import { Injectable, Logger } from '@nestjs/common';
import { RelayHttpError, newTraceId } from '../common/errors';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
// ⚠️ 必须是**值导入**（不能 `import type`）：`config?` 参数靠 emitDecoratorMetadata
//    生成 design:paramtypes 供 Nest 注入；type-only 导入会让第三参元数据退化为 Function，
//    启动即 UnknownDependenciesException（smoke:boot 实测抓到过）。
import { capBody } from './body-capture';
import { extractCachedTokens, extractReasoningTokens, extractUpstreamCredit } from './usage-tokens';
import type { Accumulator } from './types';
import type { KeyContext } from '../auth/key.guard';

/** 一次上游调用的不可变上下文，用于落库。 */
export interface StreamContext {
  traceId: string;
  started: number;
  /** 解析出的模型 id；**解析成功之前为空串**（失败行不编造模型）。 */
  modelId: string;
  modelDisplay: string;
  notes: string[];
  keyContext: KeyContext | undefined;
  remoteIp: string | null;
  ua: string | null;
  originalStream: boolean;
  /**
   * 落库幂等守卫（**跨模块共享同一引用**）。
   *
   * `fail()` / `logRejection()` 都通过 `{ ...ctx, traceId: ... }` **浅拷贝** ctx ——
   * 把「本请求是否已落库」做成对象引用，浅拷贝就会保留同一引用，于是所有路径共享
   * 这一个标记：**任何路径重复调用都只落一行**，成为结构性保证，而不是靠各调用点自觉。
   *
   * 修的是这个数值正确性问题：生成器已成功落库后，若 `reply.send` 抛错冒泡到
   * controller catch，`logRejection` 会**再落一行** → 同一请求两行 → 积分被重复计入用量统计。
   */
  persistGuard: PersistGuard;
  /**
   * 待落库的请求体（仅当 `logs.recordRequestBody` 打开时由 service 挂上；默认 null）。
   * 写库前由 `capBody` 截断。**绝不包含密钥** —— Authorization 只在请求头。
   */
  requestBody?: string | null;
  /**
   * 待落库的响应体（仅当 `logs.recordResponseBody` 打开时由 sse-stream 累积；默认 null）。
   * SSE 帧原文用 `\n\n` 连接，写库前由 `capBody` 截断。
   */
  responseBody?: string | null;
  /** [v0.2.0] 同一请求的上游重发次数（11133 幂等重试 / 11128 降级重试各计一次）。 */
  retries: number;
  /** 并发槽位，由调用方在流结束后 release。 */
  release: () => void;
}

/** 「本请求是否已落库」的共享标记（见 StreamContext.persistGuard）。 */
export interface PersistGuard {
  done: boolean;
}

/** 构造落库上下文所需的最小请求元信息（controller 拿到请求即可填）。 */
export interface RequestMeta {
  keyContext: KeyContext | undefined;
  remoteIp: string | null;
  ua: string | null;
  originalStream: boolean;
}

/**
 * ★ 在 **fetch 之前** 构造落库上下文 —— 这是「失败请求不落库」的根因修复。
 * 旧实现把 ctx 建在 fetch 成功之后，失败路径手上没有 ctx，也就无从落库。
 * 模型字段留空，等 `resolveModel` 解析成功后由 service 回填。
 */
export function beginContext(meta: RequestMeta): StreamContext {
  return {
    traceId: newTraceId(),
    started: Date.now(),
    modelId: '',
    modelDisplay: '',
    notes: [],
    keyContext: meta.keyContext,
    remoteIp: meta.remoteIp,
    ua: meta.ua,
    originalStream: meta.originalStream,
    persistGuard: { done: false },
    requestBody: null,
    responseBody: null,
    retries: 0,
    release: () => {},
  };
}

export interface PersistOutcome {
  status: number;
  upstreamCode: number | null;
  acc: Accumulator;
  firstByteMs: number | null;
  note: string;
}

/**
 * 失败行的落库入参。tokens / first_byte_ms 一律为 0 / NULL —— 失败行没有用量可言。
 *
 * `credits` 由调用方按**事实**给，缺省 `null`：
 *   · 本地拒绝（`logRejection`，请求根本没到上游）→ `0`：未消耗是**事实**，不是估算；
 *   · 上游路径失败（`fail`，不可达 / 非 2xx / 超时）→ `null`：上游到底计没计费**未知**。
 * 两种情形分开表达，是为了不把「不知道」写成「0」——那正是自标定，本项目是反代，禁止。
 */
export interface FailureOutcome {
  status: number;
  upstreamCode: number | null;
  note: string;
  model?: string | null;
  modelDisplay?: string | null;
  /** 缺省 null = 未知。见接口注释：本地拒绝给 0，上游路径失败给 null。 */
  credits?: number | null;
}

/** 本地拒绝 → 可读 note（落进日志表，供排障直接看）。 */
export function rejectionNote(err: RelayHttpError): string {
  if (err.code === 'invalid_request_body') return 'bad request body';
  if (err.code === 'model_not_allowed') return 'model not permitted';
  if (err.code === 'model_not_found') return 'model not found';
  if (err.code === 'rate_limited') return 'concurrency limit';
  return err.code;
}

/**
 * 落库 + 积分计算。
 *
 * 从 ProxyService 拆出，原因有二：
 *   1. 单文件 ≤ 300 行（硬门禁）；
 *   2. 落库失败绝不能影响已经发给客户端的响应 —— 这个"吞异常只记日志"的策略
 *      集中在一处，比散在编排逻辑里更容易审查。
 *
 * ⚠️ 必须加 `@Injectable()`：本项目用 `emitDecoratorMetadata` 生成 `design:paramtypes`，
 * 而 TS 只为**带装饰器**的声明发射构造参数元数据。若不加，Nest 用 `useClass` 实例化时
 * 拿不到参数类型 → `this.requests` 为 undefined → 每次落库都静默失败（真链路实测踩到）。
 */
@Injectable()
export class ProxyLogger {
  private readonly logger = new Logger(ProxyLogger.name);

  constructor(
    private readonly requests: RequestsRepository,
    /* [v0.5.8] `catalog` / `providers` 曾用于「倍率未知」标记与兜底计价公式。
       自标定公式移除后（上游未回报即记未知），二者在本类已无消费者 ——
       参数保留仅为不改动 DI 与 10 处测试直构的调用形状；下轮可一并清掉。 */
    _catalog?: ModelCatalogRepository,
    _providers?: ProvidersRepository,
  ) {}

  /** 统一日志出口，避免 sse-stream 直接依赖 Logger 造成循环。 */
  warn(message: string): void {
    this.logger.warn(message);
  }

    /** 一次客户端请求 = 一行；重试只加 retryCount（本版未做自动重试，恒 0）。 */
  async persist(ctx: StreamContext, outcome: PersistOutcome): Promise<void> {
    // ★ 幂等：同一请求任何路径都不重复落行（task#37）。
    //   `?.` 是防御性写法 —— 容忍 `as StreamContext` 绕过类型的对象字面量（如部分测试）；
    //   生产路径的 ctx 一律由 beginContext 创建，必带 persistGuard。
    if (ctx.persistGuard?.done) return;
    const usage = outcome.acc.usage;
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    const total = usage?.total_tokens ?? prompt + completion;
    // 缓存命中的 prompt tokens：真值在 usage.prompt_tokens_details.cached_tokens，
    // **顶层 usage.cached_tokens 恒 0 是假的** —— 见 usage-tokens.ts（task#62 防陷阱）。
    const cached = extractCachedTokens(usage);
    // ★ 积分的唯一权威来源：上游 usage 直接回报的 credit（真实账单，已含倍率与缓存折扣）。
    //   上游没回报 = **未知**（null）—— 不估算、不补零（口径铁律见下）。
    const upstreamCredit = extractUpstreamCredit(usage);
    const notes = [...ctx.notes];
    if (!usage) notes.push('usage_missing');
    if (outcome.note) notes.push(outcome.note);
    /* 留痕：上游是否回报了费用 —— 让「这个数从哪来」在请求日志里可查、可追溯。 */
    if (upstreamCredit !== null) notes.push('credits_from_upstream');
    else notes.push('credits_unknown');
    /* [v0.5.8 口径铁律] 上游没回报就是**未知**（null）：不估算、不补零。
       本项目是反代 —— 一切以上游真实返回为准；自造数字会让整个面板失去可信度。
       账户级的真实消耗另有权威来源（如 MiniMax 的 credit/details 账本）。 */
    const credits = upstreamCredit;

    try {
      this.requests.log({
        ts: ctx.started,
        traceId: ctx.traceId,
        // client_id 是稳定标识（分组/过滤/聚合键）；client 只是「快照」，供日志表直接渲染
        clientId: ctx.keyContext?.keyId ?? 'unidentified',
        clientRule: ctx.keyContext ? 2 : 4,
        client: ctx.keyContext?.client ?? '未识别',
        keyId: ctx.keyContext?.keyId ?? null,
        keyHint: ctx.keyContext?.keyHint ?? null,
        model: outcome.acc.model || ctx.modelId,
        modelDisplay: ctx.modelDisplay,
        status: outcome.status,
        upstreamCode: outcome.upstreamCode,
        ms: Date.now() - ctx.started,
        queuedMs: 0,
        firstByteMs: outcome.firstByteMs,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        cachedTokens: cached,
        reasoningTokens: extractReasoningTokens(usage, completion),
        credits,
        stream: ctx.originalStream,
        retryCount: ctx.retries ?? 0,
        note: notes.join(','),
        remoteIp: ctx.remoteIp,
        ua: ctx.ua,
        requestBody: capBody(ctx.requestBody),
        responseBody: capBody(ctx.responseBody),
      });
      if (ctx.persistGuard) ctx.persistGuard.done = true; // 成功后才标记（落库失败仍允许后续路径补记）
    } catch (err) {
      // 落库失败不能影响已发给客户端的响应；只记日志
      this.logger.error(`请求日志落库失败 trace=${ctx.traceId}: ${(err as Error).message}`);
    }
  }

  /**
   * 面向失败的落库入口。失败行与成功行同表同字段，只是取值不同：
   *   tokens = 0、first_byte_ms = NULL、credits 见 `FailureOutcome.credits`（本地拒绝 0 / 上游路径 null）。
   * `model` / `modelDisplay` 缺省回落到 ctx（未解析出模型时为空，不编造）。
   *
   * 落库失败只降级为 warn，**绝不改变**已返回给客户端的状态码与时序。
   */
  persistFailure(ctx: StreamContext, outcome: FailureOutcome): void {
    if (ctx.persistGuard?.done) return; // ★ 幂等：与 persist 共享同一守卫（task#37）
    // [v0.5.8] 与 persist 同口径：费用未知就留痕 credits_unknown，让「这个 0/空 从哪来」可查。
    const credits = outcome.credits ?? null;
    const notes = [...ctx.notes, outcome.note, credits === null ? 'credits_unknown' : ''].filter(Boolean);
    try {
      this.requests.log({
        ts: ctx.started,
        traceId: ctx.traceId,
        clientId: ctx.keyContext?.keyId ?? 'unidentified',
        clientRule: ctx.keyContext ? 2 : 4,
        client: ctx.keyContext?.client ?? '未识别',
        keyId: ctx.keyContext?.keyId ?? null,
        keyHint: ctx.keyContext?.keyHint ?? null,
        model: outcome.model ?? ctx.modelId,
        modelDisplay: (outcome.modelDisplay ?? ctx.modelDisplay) || null,
        status: outcome.status,
        upstreamCode: outcome.upstreamCode,
        ms: Date.now() - ctx.started,
        queuedMs: 0,
        firstByteMs: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        credits,
        stream: ctx.originalStream,
        retryCount: ctx.retries ?? 0,
        note: notes.join(','),
        remoteIp: ctx.remoteIp,
        ua: ctx.ua,
        requestBody: capBody(ctx.requestBody),
        responseBody: capBody(ctx.responseBody),
      });
      if (ctx.persistGuard) ctx.persistGuard.done = true;
    } catch (err) {
      this.warn(`失败请求落库失败 trace=${ctx.traceId}: ${(err as Error).message}`);
    }
  }
}
