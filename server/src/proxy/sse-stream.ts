import { RelayHttpError, ApiCode } from '../common/errors';
import { accumulate, createAccumulator, finalize } from './accumulate';
import type { ProxyLogger } from './proxy-log';
import type { StreamContext } from './proxy-log';
import type { ChatChunk } from './types';
import type { StreamEvent } from './proxy.service';

/** 距上一个 chunk 超过该毫秒数未收到数据，发一行 SSE 注释心跳。 */
const HEARTBEAT_MS = 15_000;

/**
 * ★ delta 空值归一化（2026-10-07，实测根因见下）。
 *
 * 上游网关的每个 delta 都**塞满全量字段**：思考帧是 `{"content":"","reasoning_content":"词"}`
 * （一帧一词），答案帧是 `{"content":"词","reasoning_content":""}`，外加恒定的
 * `tool_calls:[]` / `refusal:""` / `function_call` 空壳。而 DeepSeek 官方 API 等规范形状
 * **从不发空字段**。
 *
 * 后果实测：ai-sdk 系客户端（ZCode 用 provider-utils 4.0.39）把夹在 reasoning 帧之间的
 * 空 `content:""` 当作分段边界 → **每个词被拆成一段独立思考**，UI 上一次回答堆出
 * 几十条「思考」块，且客户端记录的思考文本变成 `"The\n\n user\n\n keeps…"`。
 *
 * 处置：转发前丢掉 delta 里的**无信息空值**（空串 / null / 空数组 / 空 function_call）。
 * - 无损：空值不携带任何语义，任何客户端对「字段缺失」与「字段为空」的处理本就该等价；
 * - 保真：id / model / object / created / usage / finish_reason 与非空 delta 原样保留
 *   （硬规则 1 的「保留上游真实 ID」不受影响，该规则防的是改模型名/改内容，不是丢空壳）。
 */
function isNoopValue(v: unknown): boolean {
  if (v === '' || v === null || v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (
    v &&
    typeof v === 'object' &&
    'name' in v &&
    'arguments' in v &&
    (v as { name: unknown }).name === '' &&
    (v as { arguments: unknown }).arguments === ''
  ) {
    return true; // 上游收尾帧的 function_call 空壳 {"name":"","arguments":""}
  }
  return false;
}

/** 返回归一化后的 chunk（choices[].delta 去空值；顶层字段一字不动）。 */
export function normalizeChunkDelta(chunk: ChatChunk): ChatChunk {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return chunk;
  let changed = false;
  const newChoices = choices.map((c) => {
    const d = (c as { delta?: unknown }).delta;
    if (!d || typeof d !== 'object') return c;
    const entries = Object.entries(d as Record<string, unknown>).filter(([, v]) => {
      if (isNoopValue(v)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (entries.length === Object.keys(d as object).length) return c; // 本 choice 无空值
    return { ...c, delta: Object.fromEntries(entries) };
  });
  if (!changed) return chunk;
  return { ...chunk, choices: newChoices };
}

/**
 * ★ 上游读超时守卫（2026-10-08 修复，生产事故见下）。
 *
 * 此前实现把 `AbortSignal.timeout(firstByteTimeoutMs)` 挂在整个 fetch 上 ——
 * 但 `AbortSignal.timeout` 是**从创建起算的全程超时**，不止覆盖到首字节：
 * 任何总时长超过 30s 的流式响应都会被我们自己掐断（生产实测：两条 agent 工具调用
 * 恰好在 30009/30011ms 被杀，首字节 8-9s 早已到达，note=stream_abort）。
 * 这直接违背设置页的承诺「流式请求按首字超时计算，不用总时长，避免长回答被误杀」。
 *
 * 两段式语义：
 *   ① 首字超时（设置项 `limits.firstByteTimeoutMs`，默认 30s）：
 *      只管「发请求 → 收到首个真实数据帧」。到达即解除，此后不再约束总时长。
 *   ② 空闲看门狗（代码常量，非设置项）：收过数据后，上游**连续静默**超过
 *      `UPSTREAM_IDLE_TIMEOUT_MS` 才中止 —— 防真挂死占住并发槽与连接；
 *      合法流（逐词思考 / 工具参数流）从不静默这么久，不会误伤。
 *
 * 字节级活动（上游 keepalive 注释行）只重置看门狗、**不解除**首字超时 ——
 * 「有连接活动」不等于「模型出了第一个字」，首字语义必须以数据帧为准。
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

export interface ReadGuard {
  /** 挂给上游 fetch 的 abort 信号：①段超时或②段看门狗触发时中止整个请求（含 body）。 */
  signal: AbortSignal;
  /** 收到任何上游字节：重置空闲看门狗（连接活着 ≠ 有数据，首字超时不因此解除）。 */
  onBytes(): void;
  /** 收到首个真实数据帧（含 [DONE]）：解除首字超时 + 重置看门狗。 */
  onData(): void;
  /** 流已终结（无论成败）：停掉全部定时器。幂等。 */
  dispose(): void;
}

export function createReadGuard(
  firstByteTimeoutMs: number,
  idleTimeoutMs: number = UPSTREAM_IDLE_TIMEOUT_MS,
): ReadGuard {
  const controller = new AbortController();
  let firstByteTimer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), firstByteTimeoutMs);
  let idleTimer: NodeJS.Timeout | undefined;
  firstByteTimer.unref?.();
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    idleTimer.unref?.();
  };
  return {
    signal: controller.signal,
    onBytes() {
      if (idleTimer !== undefined) armIdle();
    },
    onData() {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
        armIdle();
      } else {
        armIdle();
      }
    },
    dispose() {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      firstByteTimer = undefined;
      idleTimer = undefined;
    },
  };
}

/**
 * 上游 SSE 字节流 → 我们的 StreamEvent 流（ADR-004 / api-contract §2.1.4）。
 *
 * 从 ProxyService 拆出，原因：单文件 ≤ 300 行；且这里是纯粹的行解析 + 折叠逻辑，
 * 与"调上游 / 并发闸"是两件独立的事，混在一起既超行数也难单测。
 *
 * 硬规则：
 *   1. 不改写 chunk 内容（model 保留上游真实 ID）。**唯一例外（2026-10-07）**：
 *      `normalizeChunkDelta` 丢掉 delta 里的无信息空值字段（`content:""` 等），原因与
 *      实测证据见该函数注释——不丢的话 ai-sdk 系客户端会把思考流拆成一词一段。
 *   2. 边聚合边转发，不缓冲（首字延迟 = 上游首字延迟）。
 *   3. 未收到 `[DONE]` 就结束 = 断流 → `finalize(acc,false).ok===false` → 整段失败。
 *   4. **落库在 finally 内完成**：无论正常读完、抛异常，还是被 `.return()`（客户端断开时
 *      controller 的 'close' 回调会这么做）提前终止，都恰好落一行 —— 这样
 *      「客户端可见失败 ⇒ 必有审计行」是**结构性保证**，不依赖每个分支自觉调用（task#36）。
 */
export async function* readUpstreamSse(
  upstreamBody: ReadableStream<Uint8Array>,
  ctx: StreamContext,
  log: ProxyLogger,
  captureResponse = false,
  guard?: ReadGuard,
): AsyncGenerator<StreamEvent> {
  const acc = createAccumulator();
  const decoder = new TextDecoder('utf-8');
  const reader = upstreamBody.getReader();
  let buffer = '';
  let completed = false;
  let firstByteMs: number | null = null;
  let ok = false;
  let persisted = false;
  // A3：仅在开关打开时累积响应帧原文（默认关 = 不持有上游回复内容）。
  const responseParts: string[] = [];
  // 区分失败来源（note 要能指向正确排查方向）：
  //   endedNaturally / upstreamFailed → 上游侧问题 → stream_aborted
  //   两者都为 false（读没到末尾、也没抛错，却被 .return() 终止）→ 客户端侧 → client_detached
  let endedNaturally = false;
  let upstreamFailed = false;
  // 心跳只结束本轮等待，不取消读取；必须复用未完成的 read，避免旧读取吞掉后续分片。
  let pendingRead: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | undefined;

  /**
   * 幂等落库：正常读完 / 抛异常 / 被 `.return()` 提前终止，都**恰好执行一次**。
   *
   * ⚠️ 为什么必须幂等、且必须由 finally 调用：controller 在客户端断开时会调
   * `events.return()` 提前终止本生成器；此时 try/finally **之后**的代码**不会执行**，
   * 所以落库绝不能留在 finally 之后 —— 否则「流式进行中被客户端断开」这一类
   * 客户端可见失败会一条审计行都不落（task#36 修的正是这个漏网路径）。
   */
  const finalizeAndPersist = async (): Promise<void> => {
    if (persisted) return;
    persisted = true;
    // 响应体在落库前一次性拼接（仅开关打开时）
    if (captureResponse) ctx.responseBody = responseParts.join('\n\n');
    ok = finalize(acc, completed).ok;
    await log.persist(ctx, {
      status: ok ? 200 : 502,
      upstreamCode: null,
      acc,
      firstByteMs,
      // 失败时 note 指向正确的排查方向：上游断流 vs 客户端断开（task#37）
      note: ok ? '' : endedNaturally || upstreamFailed ? 'stream_aborted' : 'client_detached',
    });
    ctx.release();
  };

  try {
    for (;;) {
      pendingRead ??= reader.read();
      const read = await readWithHeartbeat(pendingRead);
      if (read.heartbeat) {
        yield { type: 'ping' };
        continue;
      }
      pendingRead = undefined; // 结果已消费，下一轮才能发起新的读取。
      if (read.done) {
        endedNaturally = true;
        break;
      }
      if (firstByteMs === null) firstByteMs = Date.now() - ctx.started;
      guard?.onBytes(); // 连接层活动：只续看门狗，不解首字超时
      buffer += decoder.decode(read.value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        guard?.onData(); // 真实数据帧：解除首字超时（此后总时长不再受约束）
        if (payload === '[DONE]') {
          completed = true;
          yield { type: 'done' };
          continue;
        }
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(payload) as ChatChunk;
        } catch {
          continue; // 坏帧跳过，不断流
        }
        accumulate(acc, chunk);
        // ★ 归一化后再转发（见 normalizeChunkDelta 注释）：丢空值字段，防 ai-sdk 系客户端
        //   把夹在 reasoning 帧间的 `content:""` 当分段边界、把思考拆成一词一段。
        const outChunk = normalizeChunkDelta(chunk);
        const outPayload = outChunk === chunk ? payload : JSON.stringify(outChunk);
        if (captureResponse) responseParts.push(`data: ${outPayload}`);
        // 附带已解析对象：非流式聚合 / Anthropic 编码不再二次 JSON.parse（每帧省一次解析）
        yield { type: 'chunk', data: outPayload, parsed: outChunk };
      }
    }
  } catch (err) {
    // 上游中途断流（读失败/超时/中断）：completed 保持 false，按失败落库（在 finally 里做）
    upstreamFailed = true;
    log.warn(`上游流中断 trace=${ctx.traceId}: ${(err as Error).message}`);
  } finally {
    reader.releaseLock();
    guard?.dispose(); // 流已终结：停掉首字/看门狗定时器（幂等）
    // ★ 落库放进 finally —— 这是「客户端可见失败 ⇒ 必有审计行」的结构性保证：
    //   被 .return() 提前终止时，下面的代码整段跳过，但 finally 一定会执行。
    await finalizeAndPersist();
  }

  // 只有生成器**正常走完**（未被 .return() 终止）才会到达这里：把失败以 SSE error 帧写回。
  // 客户端已断开时走不到这里，也就不做徒劳的写入。
  if (!ok) {
    yield {
      type: 'error',
      error: new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_error',
        apiCode: ApiCode.INTERNAL,
        message: '上游在流中途断开，本次请求按失败处理。已落库，不会返回半截结果。',
      }),
    };
  }
}

/** 等待已有读取最多 HEARTBEAT_MS：心跳胜出时保留该读取，供下一轮继续等待。 */
async function readWithHeartbeat(
  read: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>,
): Promise<{ done: boolean; value?: Uint8Array; heartbeat?: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const beat = new Promise<{ done: boolean; heartbeat: true }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false, heartbeat: true }), HEARTBEAT_MS);
  });
  try {
    return await Promise.race([read, beat]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
