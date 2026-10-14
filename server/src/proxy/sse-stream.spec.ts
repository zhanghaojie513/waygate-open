/**
 * 「客户端可见失败 ⇒ 必有审计行」不变式回归（task#36）。
 *
 * 缺陷：`readUpstreamSse` 原本把 `log.persist` / `ctx.release` 放在 `try/finally`
 * **之后**。controller 在客户端断开时会调 `events.return()` 提前终止生成器 —— 此时
 * try/finally 之后的代码**整段跳过**，于是「流式进行中被客户端断开」这一类
 * 客户端可见失败（客户端看到 ECONNRESET）一条审计行都不落、并发槽位也不释放。
 *
 * 本文件把「落库必须在 finally 内」钉成结构性约束，并把「客户端断开 / 上游断流」
 * 两类失败用 note 区分开（task#37）：
 *   ① 客户端断开（.return()）→ 仍落一行（note=client_detached）且释放槽位  ← 曾失败
 *   ② 上游流中途报错         → 落一行（note=stream_aborted）
 *   ③ 正常读完（[DONE]）      → 落一行成功（不误标失败）—— 反向保护，防"一律按失败落库"
 *   ④ 集成：走 controller 的 'close' 回调（真实断开路径）→ note=client_detached
 *   ⑤ 上游自然结束但无 [DONE] → note=stream_aborted（与客户端断开区分开）
 */

import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createReadGuard, readUpstreamSse, type ReadGuard } from './sse-stream';
import { beginContext, ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import type { RelayConfigService } from '../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');
const enc = new TextEncoder();
const CHUNK1 =
  'data: {"id":"c1","model":"kimi-k2.7","choices":[{"delta":{"content":"你"},"finish_reason":null}]}\n\n';
const DONE = 'data: [DONE]\n\n';

const keyContext: KeyContext = {
  keyId: 'k_disc',
  keyHint: 'sk-waygate-aaaa…bbbb',
  client: 'Claude Code',
  clients: [],
  scope: { type: 'all' },
};

let db: Database.Database;
let catalog: ModelCatalogRepository;
let log: ProxyLogger;
let providers: ProvidersRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  catalog = new ModelCatalogRepository(db);
  providers = new ProvidersRepository(db);
  providers.create({ id: 'p_test', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  catalog.seed('p_test', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog, providers);
  // requests.key_id 有 FK → 必须先落一把密钥，否则落库因外键失败（真链路踩过）
  new ClientKeysRepository(db).create({
    id: 'k_disc',
    name: '测试密钥',
    keyHash: 'h_disc',
    keyHint: 'sk-waygate-aaaa…bbbb',
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 造一个真实 ReadableStream：吐出给定分片后可选「挂着不结束」（模拟上游仍在思考）。 */
function sseStream(chunks: string[], opts: { thenHang?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(enc.encode(chunks[i++]));
        return;
      }
      if (opts.thenHang) return new Promise<void>(() => {});
      c.close();
    },
  });
}

/** 直接造一个带上模型与 release 探针的落库上下文。 */
function makeCtx(release: () => void) {
  const ctx = beginContext({ keyContext, remoteIp: null, ua: null, originalStream: true });
  ctx.modelId = 'kimi-k2.7';
  ctx.modelDisplay = 'Kimi K2.7';
  ctx.release = release;
  return ctx;
}

function latest(): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
}

describe('readUpstreamSse · 落库结构性保证（task#36）', () => {
  it('① 客户端断开（.return() 提前终止生成器）→ 仍落一行审计，note=client_detached', async () => {
    const release = vi.fn();
    const ctx = makeCtx(release);

    // 上游发了第一个 chunk 后仍在继续（挂着）
    const gen = readUpstreamSse(sseStream([CHUNK1, CHUNK1], { thenHang: true }), ctx, log);
    const first = await gen.next();
    expect(first.done).toBe(false); // 生成器此刻挂在 yield 上

    // 模拟 controller 的 'close' 回调：客户端断开 → events.return()
    await gen.return(undefined);

    const row = latest();
    expect(row).toBeDefined(); // ← 旧实现这里会是 undefined（persist 被整段跳过）
    expect(row!.status).toBe(502);
    expect(String(row!.note)).toContain('client_detached'); // 客户端侧断开（≠ 上游断流）
    // [v0.5.8] 该帧没带 usage.credit ⇒ 费用未知（null），不再补 0（本服务不估算）。
    expect(row!.credits).toBeNull();
    expect(String(row!.note)).toContain('credits_unknown');
    expect(row!.first_byte_ms).not.toBeNull(); // 已经收到过首字节
    expect(release).toHaveBeenCalledTimes(1); // 并发槽位不泄漏
  });

  it('② 上游流中途报错（reader 抛异常）→ 落一行，note=stream_aborted', async () => {
    const release = vi.fn();
    const ctx = makeCtx(release);
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i++ === 0) {
          c.enqueue(enc.encode(CHUNK1));
          return;
        }
        c.error(new Error('upstream reset'));
      },
    });

    const events = [];
    for await (const ev of readUpstreamSse(body, ctx, log)) events.push(ev);

    expect(events.some((e) => e.type === 'error')).toBe(true); // 正常走完 → 也回了 error 帧
    const row = latest();
    expect(row).toBeDefined();
    expect(row!.status).toBe(502);
    expect(String(row!.note)).toContain('stream_aborted');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('③ 正常读完（含 [DONE]）→ 落一行成功（不被误标失败）', async () => {
    const release = vi.fn();
    const ctx = makeCtx(release);

    const gen = readUpstreamSse(sseStream([CHUNK1, DONE]), ctx, log);
    while (!(await gen.next()).done) {
      /* 消费掉即可 */
    }

    const row = latest();
    expect(row).toBeDefined();
    expect(row!.status).toBe(200);
    expect(String(row!.note)).not.toContain('stream_aborted');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('⑤ 上游自然结束但**没有 [DONE]** → note=stream_aborted（与客户端断开区分开）', async () => {
    const release = vi.fn();
    const ctx = makeCtx(release);

    // 流正常关闭（read.done），但从未发 [DONE] → 上游侧断流，不是客户端 detach
    const gen = readUpstreamSse(sseStream([CHUNK1]), ctx, log);
    while (!(await gen.next()).done) {
      /* 消费掉即可 */
    }

    const row = latest();
    expect(row).toBeDefined();
    expect(row!.status).toBe(502);
    expect(String(row!.note)).toContain('stream_aborted');
    expect(String(row!.note)).not.toContain('client_detached');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('集成：客户端流中途断开（走 controller 的 close 回调）', () => {
  function makeHarness() {
    const config = {
      get: () => ({
        limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
        upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://copilot.tencent.com' },
        logs: { recordRequestBody: false, recordResponseBody: false },
      }),
      upstreamKey: 'ck_test_0123456789abcdef',
    } as unknown as RelayConfigService;
    const proxy = new ProxyService(config, catalog, log, providers);
    const controller = new ProxyController(proxy, catalog, providers);
    return { proxy, controller };
  }

  /** 一个假的 FastifyReply：raw 是 EventEmitter；第一次 write 就 emit('close') 模拟断开。 */
  function disconnectOnFirstWrite() {
    const raw = new EventEmitter() as unknown as {
      on: (e: string, cb: () => void) => void;
      emit: (e: string, ...a: unknown[]) => unknown;
      writeHead: (s: number) => void;
      write: (s: string) => boolean;
      end: (s?: string) => void;
    };
    let head = 0;
    const writes: string[] = [];
    let resolveEnd!: () => void;
    const ended = new Promise<void>((r) => {
      resolveEnd = r;
    });
    raw.writeHead = (s: number) => {
      head = s;
    };
    raw.write = (s: string) => {
      writes.push(s);
      raw.emit('close'); // ← 触发 pipeSse 的 close 回调 → events.return()
      return true;
    };
    raw.end = () => resolveEnd();
    return {
      reply: { raw } as unknown as FastifyReply,
      writes,
      head: () => head,
      ended,
    };
  }

  it('④ 客户端断开 → 审计行存在、note=client_detached、并发槽位释放', async () => {
    const { controller, proxy } = makeHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: sseStream([CHUNK1, CHUNK1], { thenHang: true }),
      })),
    );
    const { reply, ended, head } = disconnectOnFirstWrite();
    const req = {
      headers: { authorization: 'Bearer sk-waygate-aaaa', 'user-agent': 'claude-cli/1.0' },
      ip: '127.0.0.1',
      keyContext,
    } as RequestWithKeyContext;

    await controller.chatCompletions(req as never, reply, {
      model: 'kimi-k2.7',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    } as never);

    await ended; // 等流处理收尾（persist 在 raw.end() 之前完成）

    const row = latest();
    expect(row).toBeDefined(); // ← 旧实现这里会是 undefined
    expect(row!.status).toBe(502);
    expect(String(row!.note)).toContain('client_detached');
    expect(row!.client_id).toBe('k_disc');
    expect(head()).toBe(200); // 已经写过头（客户端在流中途才断开）
    expect(proxy.activeCount).toBe(0); // 槽位不泄漏
  });
});

/**
 * [2026-10-07] delta 空值归一化回归：上游网关每帧塞满全量空字段（`content:""` /
 * `reasoning_content:""` / `tool_calls:[]` / `function_call` 空壳），ai-sdk 系客户端
 * （ZCode / provider-utils 4.0.39）会把夹在 reasoning 帧之间的空 `content` 当分段边界，
 * 思考流被拆成**一词一段**（UI 一词一条「思考」块）。转发前必须把空值字段丢掉。
 * 实测帧形态（真 key 直连探针，server/tools/probe-thinking-stream.mjs）：
 *   思考帧 {"content":"","reasoning_content":"We","tool_calls":[],...}
 *   答案帧 {"content":"$0","reasoning_content":"","tool_calls":[],...}
 */
describe('readUpstreamSse · delta 空值归一化（2026-10-07）', () => {
  /** 跑一遍流，收集转发出去的 chunk payload。 */
  async function collect(frames: string[]): Promise<string[]> {
    const ctx = makeCtx(() => {});
    const out: string[] = [];
    for await (const ev of readUpstreamSse(sseStream(frames), ctx, log)) {
      if (ev.type === 'chunk') out.push(ev.data);
    }
    return out;
  }

  it('★ 思考帧：空 content/tool_calls 被剥离，delta 只剩 reasoning_content（不再携带分段信号）', async () => {
    const frames = [
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"role":"assistant","content":"","reasoning_content":"","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"","reasoning_content":"We","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"","reasoning_content":" need","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}\n\n',
      DONE,
    ];
    const out = await collect(frames);
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0]).choices[0].delta).toEqual({ role: 'assistant' }); // 首帧：role 保留，空值全剥
    for (const p of out.slice(1)) {
      const d = JSON.parse(p).choices[0].delta;
      expect(Object.keys(d)).toEqual(['reasoning_content']); // ★ 不再有 content:"" 夹层
      expect(d.reasoning_content.length).toBeGreaterThan(0);
    }
  });

  it('★ 答案帧：空 reasoning_content 被剥离，content 原样逐词透传', async () => {
    const frames = [
      'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"$0","reasoning_content":"","tool_calls":[],"refusal":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"delta":{"content":".05","reasoning_content":"","tool_calls":[],"refusal":""},"finish_reason":null}]}\n\n',
      DONE,
    ];
    const out = await collect(frames);
    for (const p of out) {
      expect(Object.keys(JSON.parse(p).choices[0].delta)).toEqual(['content']);
    }
    expect(JSON.parse(out[0]).choices[0].delta.content).toBe('$0');
  });

  it('收尾帧：function_call 空壳剥掉，role 与 finish_reason 保留', async () => {
    const frames = [
      'data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":"","reasoning_content":"","function_call":{"name":"","arguments":""},"tool_calls":[]},"finish_reason":"stop"}]}\n\n',
      DONE,
    ];
    const out = await collect(frames);
    const c = JSON.parse(out[0]).choices[0];
    expect(c.delta).toEqual({ role: 'assistant' });
    expect(c.finish_reason).toBe('stop');
  });

  it('保真：id/model/created/usage 顶层字段与非空混合 delta 原样保留', async () => {
    const frames = [
      'data: {"id":"c9","object":"chat.completion.chunk","created":1790000000,"model":"deepseek-v4.1-flash","usage":null,"choices":[{"delta":{"content":"hi","reasoning_content":"think"},"finish_reason":null}]}\n\n',
      DONE,
    ];
    const out = await collect(frames);
    const j = JSON.parse(out[0]);
    expect(j.id).toBe('c9');
    expect(j.model).toBe('deepseek-v4.1-flash');
    expect(j.created).toBe(1790000000);
    expect(j.usage).toBeNull();
    expect(j.choices[0].delta).toEqual({ content: 'hi', reasoning_content: 'think' });
  });

  it('干净帧零改动：无空值时 payload 逐字节透传（不重序列化）', async () => {
    const payload =
      '{"id":"c1","model":"m","choices":[{"delta":{"content":"好"},"finish_reason":null}]}';
    const out = await collect([`data: ${payload}\n\n`, DONE]);
    expect(out[0]).toBe(payload);
  });
});

/**
 * ★ 上游读超时语义（2026-10-08 修复回归）。
 *
 * 事故：`AbortSignal.timeout(firstByteTimeoutMs)` 挂在整个 fetch 上，是**全程超时**——
 * agent 工具调用的长流（总时长 >30s、首字 8-9s 已到）在 30s 整被我们自己掐断
 * （生产 note=stream_abort，ms=30009/30011）。修复后：超时只管「发请求 → 首个数据帧」，
 * 之后仅受空闲看门狗（连续 5 分钟无数据）约束。
 */
describe('readUpstreamSse · 读超时守卫（首字超时 ≠ 总时长）', () => {
  /** 按时间表吐帧的流；挂 guard 时模拟 undici 行为：signal abort → body 流报错。 */
  function timedStream(
    steps: Array<{ frame?: string; afterMs: number }>,
    opts: { guard?: ReadGuard; hang?: boolean } = {},
  ): ReadableStream<Uint8Array> {
    const { guard, hang } = opts;
    return new ReadableStream<Uint8Array>({
      start(c) {
        if (guard) {
          guard.signal.addEventListener('abort', () =>
            c.error(new DOMException('This operation was aborted', 'AbortError')),
          );
        }
        let t = 0;
        for (const s of steps) {
          t += s.afterMs;
          if (s.frame !== undefined) {
            setTimeout(() => {
              try {
                c.enqueue(enc.encode(s.frame as string));
              } catch {
                /* 已 abort，丢弃 */
              }
            }, t);
          }
        }
        if (!hang) {
          setTimeout(() => {
            try {
              c.close();
            } catch {
              /* 已 abort */
            }
          }, t + 40);
        }
      },
    });
  }

  async function collectWith(
    body: ReadableStream<Uint8Array>,
    guard: ReadGuard | undefined,
  ): Promise<Array<{ type: string }>> {
    const release = vi.fn();
    const events: Array<{ type: string }> = [];
    for await (const ev of readUpstreamSse(body, makeCtx(release), log, false, guard)) {
      events.push(ev as { type: string });
    }
    return events;
  }

  it('★ 首块已到、流总时长超过首字超时 → 不被掐断（回归：agent 长流 30 秒必死）', async () => {
    const guard = createReadGuard(80); // 首字 80ms
    const USAGE_FRAME =
      'data: {"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n';
    const events = await collectWith(
      timedStream(
        [{ frame: CHUNK1, afterMs: 10 }, { frame: USAGE_FRAME, afterMs: 130 }, { frame: DONE, afterMs: 80 }],
        { guard },
      ),
      guard,
    );
    // 总时长 ~220ms > 80ms：旧实现（全程超时）在 80ms 必杀；新实现完整读完
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(latest()?.status).toBe(200);
    // [v0.5.8] 该帧 usage 无 credit ⇒ note 恰为 credits_unknown（不含任何中断标记）。
    expect(latest()?.note).toBe('credits_unknown');
  }, 5_000);

  it('★ 首个数据帧迟迟不来（超首字超时）→ 掐断，note=stream_aborted', async () => {
    const guard = createReadGuard(60);
    const events = await collectWith(timedStream([], { guard, hang: true }), guard);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(String(latest()?.note)).toContain('stream_aborted');
    expect(latest()?.status).toBe(502);
  }, 5_000);

  it('★ 流中静默超过空闲看门狗 → 掐断（真挂死有尽头，不占槽一辈子）', async () => {
    const guard = createReadGuard(60, 90); // 首字 60ms，空闲 90ms
    const events = await collectWith(
      timedStream([{ frame: CHUNK1, afterMs: 10 }], { guard, hang: true }),
      guard,
    );
    // 10ms 首块解除首字超时 → 静默 90ms → 看门狗在 ~100ms 触发（早于任何首字语义）
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(String(latest()?.note)).toContain('stream_aborted');
  }, 5_000);

  it('★ 上游 keepalive 注释行（有字节、无数据帧）不解除首字超时', async () => {
    const guard = createReadGuard(80);
    const events = await collectWith(
      timedStream(
        [
          { frame: ': ping\n\n', afterMs: 20 },
          { frame: ': ping\n\n', afterMs: 20 },
          { frame: ': ping\n\n', afterMs: 20 },
        ],
        { guard, hang: true },
      ),
      guard,
    );
    // 字节持续到达（onBytes 续看门狗），但没有数据帧（onData 未触发）→ 80ms 仍按首字超时掐断
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(String(latest()?.note)).toContain('stream_aborted');
  }, 5_000);
});
