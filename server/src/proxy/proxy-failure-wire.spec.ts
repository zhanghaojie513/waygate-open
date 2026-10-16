/**
 * task#76 回归：**流式（stream:true）请求遇到上游失败时，客户端能读到可读的错误**，
 * 而不是一个 socket reset。把两条 wire 行为钉死，防未来把「先写 200 再报错」这类
 * 会把客户端逼成 RST 的改动混进来。
 *
 *   ① 上游在**任何 SSE 之前**就失败（11128 这类非 2xx）→ 我方回 **502 + 标准 JSON 错误**
 *      （契约 §2.1.5），**绝不**以 200 开 SSE —— 一旦 200 头发出就再也改不了状态码。
 *   ② 上游 200 但**流中途**断掉 → 我方以 **200 开 SSE**，但把失败写成 SSE error 帧 +
 *      `[DONE]`（契约 §2.1.4(3)）—— 客户端仍能读到结构化错误，无需 reset。
 *
 * 两条都断言**必落一行**（失败留痕 + note 指向正确方向），因为「客户端可见失败 ⇒ 必有
 * 审计行」是与本任务同源的不变式。
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import type { RelayConfigService } from '../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');
const KEY_ID = 'k_wire76';
const enc = new TextEncoder();

const keyContext: KeyContext = {
  keyId: KEY_ID,
  keyHint: 'sk-waygate-aaaa…bbbb',
  client: 'ZCode',
  clients: ['ZCode'],
  scope: { type: 'all' },
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const catalog = new ModelCatalogRepository(db);
  /* 占位：baseUrl 随 config 一起定（路由读 provider 行，不再读 config） */
  catalog.seed('p_wire', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  new ClientKeysRepository(db).create({
    id: KEY_ID,
    name: '流式失败 wire 测试',
    keyHash: 'h_wire76',
    keyHint: 'sk-waygate-aaaa…bbbb',
    scope: '{"type":"all"}',
    client: 'ZCode',
    clients: JSON.stringify(['ZCode']),
    expiresAt: null,
    source: 'console',
  });
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface RawState {
  status: number;
  headers: Record<string, unknown> | null;
  writes: string[];
  ended: boolean;
  sent: unknown;
  events: EventEmitter;
}

/** 同时支持 `reply.code().send()`（错误路径）与 `reply.raw.*`（SSE 路径）的假 reply。 */
function fakeReply(): { reply: FastifyReply; raw: RawState } {
  const raw: RawState = { status: 0, headers: null, writes: [], ended: false, sent: undefined, events: new EventEmitter() };
  const rawObj = {
    writeHead(code: number, headers?: Record<string, unknown>) {
      raw.status = code;
      raw.headers = headers ?? null;
      return rawObj;
    },
    write(s: string) {
      raw.writes.push(String(s));
      return true;
    },
    end(s?: string) {
      if (s !== undefined) raw.writes.push(String(s));
      raw.ended = true;
    },
    on(ev: string, cb: (...a: unknown[]) => void) {
      raw.events.on(ev, cb);
      return rawObj;
    },
  };
  const reply = {
    code(n: number) {
      raw.status = n;
      return reply;
    },
    header() {
      return reply;
    },
    send(b: unknown) {
      raw.sent = b;
      raw.ended = true;
      return reply;
    },
    raw: rawObj,
  } as unknown as FastifyReply;
  return { reply, raw };
}

function makeController() {
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  if (!providers.findById('p_wire')) {
    providers.create({ id: 'p_wire', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  }
  catalog.seed('p_wire', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog, providers);
  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://up.example.com' },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_test.SECRET',
  } as unknown as RelayConfigService;
  return new ProxyController(new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef')), catalog, providers);
}

const latest = (): Record<string, unknown> | undefined =>
  db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;

const req = (): RequestWithKeyContext =>
  ({ headers: { authorization: 'Bearer sk-waygate-aaaa…bbbb', 'user-agent': 'ZCode/3.14.4' }, ip: '127.0.0.1', keyContext }) as RequestWithKeyContext;

const streamBody = () => ({ model: 'kimi-k2.7', messages: [{ role: 'user', content: 'hi' }], stream: true });

/**
 * ★ [2026-10-12] **忠实的非 2xx 假响应**：`text()` 只准成功一次，第二次抛
 * `TypeError: Body is unusable` —— 与真实 `Response.body`（单向流）一致。
 *
 * 为什么必须有它：本文件此前的 mock 用 `text: async () => '...'`，**可无限次读**，
 * 于是「业务码探测读一次、失败分支再读一次」的双重读取在生产必现、在单测里完全隐形。
 * 生产因此把 `11115 prompt is too long` 吞成了「未预期状态码 400」（trace 409d1efa…）。
 * 用这个工厂构造响应，任何重复读取都会像生产一样拿到空串，回归网才算真的织上。
 */
function failingResponse(status: number, body: string) {
  let consumed = false;
  return {
    ok: false,
    status,
    text: async () => {
      if (consumed) throw new TypeError('Body is unusable: Body has already been read');
      consumed = true;
      return body;
    },
  };
}

/** 等到 raw.end() 被调用（SSE 的 async IIFE 完成）。 */
async function waitEnded(raw: RawState, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!raw.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe('task#76 · 流式请求遇上游失败：客户端能读到可读错误（不是 RST）', () => {
  it('★ ① 上游在任何 SSE 之前失败（非 2xx + 11128）→ 502 + JSON，绝不以 200 开 SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11128, message: 'upstream rejected' }))),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    // 回的是标准 JSON 错误（OpenAI 形状），状态 502 —— 客户端能读到中文 message + 真实业务码
    expect(raw.status).toBe(502);
    const body = raw.sent as { error?: { code?: string; message?: string } };
    expect(body?.error?.code).toBe('upstream_11128');
    expect(String(body?.error?.message)).toContain('11128');
    // 关键：**没有**以 200 开过 SSE（否则无法再改状态码 → 只能 reset）
    expect(raw.headers).toBeNull();

    // 失败必落一行，且 note 指向正确方向、first_byte_ms 为空（一个字节都没流）
    const row = latest()!;
    expect(row.status).toBe(502);
    expect(row.upstream_code).toBe(11128);
    expect(row.first_byte_ms).toBeNull();
    expect(String(row.note)).toContain('upstream_11128');
  });

  it('② 上游 200 但流中途断掉 → 200 + SSE error 帧 + [DONE]（契约 §2.1.4(3)），客户端仍能读到', async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i++ === 0) {
          c.enqueue(enc.encode('data: {"id":"c1","choices":[{"delta":{"content":"你"}}]}\n\n'));
          return;
        }
        c.error(new Error('upstream reset')); // 上游中途断流
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body })));
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);
    await waitEnded(raw);

    expect(raw.status).toBe(200); // SSE 已开始 → 只能 200
    const all = raw.writes.join('');
    expect(all).toContain('data: '); // 有内容帧
    expect(all).toContain('"error"'); // 有结构化错误帧
    expect(all).toContain('[DONE]'); // 正常收尾（不是 reset）
    expect(raw.ended).toBe(true);

    const row = latest()!;
    expect(row.status).toBe(502);
    expect(String(row.note)).toContain('stream_aborted');
  });
});

/**
 * ★ [2026-10-12 生产事故回归] 上游 400 的业务码必须活着走到客户端与审计行。
 *
 * 事故形态（trace 409d1efa-c83e-4679-a699-55e9530900ea，08:32:49）：
 * 客户端发来 5.3MB 的 agent 历史，上游回
 * `{"code":11115,"msg":"prompt is too long: 1266460 tokens > 1048576 maximum"}`；
 * 因为 11133 探测把 `res.text()` 用掉、失败分支再读一次拿到空串，业务码恒为 null，
 * 最终对外只剩一句「上游返回未预期状态码 400」—— 排障方向、真实原因、可纠正性全丢。
 *
 * 这些用例用**一次性 `text()`**（见 `failingResponse`）钉死「只准读一次」的纪律。
 */
describe('★ 上游非 2xx 的错误体解析（业务码不得被吞）', () => {
  it('★ 11115 上下文超限 → 400 context_length_exceeded，且 message 带上上游原文的 token 数', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failingResponse(400, JSON.stringify({
        code: 11115,
        msg: 'prompt is too long: 1266460 tokens > 1048576 maximum',
        requestId: 'dc5758ee-9f1b-498c-866f-97017895635c',
      }))),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    // 客户端能读到「上下文超限」这个可自行纠正的原因，而不是「未预期状态码 400」
    expect(raw.status).toBe(400);
    const body = raw.sent as { error?: { code?: string; message?: string } };
    expect(body?.error?.code).toBe('context_length_exceeded');
    expect(String(body?.error?.message)).toContain('上下文超限');
    // 上游原文里的真实数字要带出来（超了多少 / 上限多少）
    expect(String(body?.error?.message)).toContain('1266460 tokens > 1048576 maximum');

    // 审计行必须留住业务码 —— 这是「为什么当时排不出来」的正解
    const row = latest()!;
    expect(row.status).toBe(400);
    expect(row.upstream_code).toBe(11115);
    // note 是逗号拼接的集合（前面还会有 system_injected 等），这里只断言含正确码
    expect(String(row.note)).toContain('context_length_exceeded');
    // 超限是推理前拒绝，一个字节都没流过
    expect(row.first_byte_ms).toBeNull();
  });

  it('★ 11115 不被误判成 11133 抖动而白白重试（只打一次上游）', async () => {
    const fetchMock = vi.fn(async () => failingResponse(400, JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 2000000 tokens > 1048576 maximum',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    // 11115 不是瞬时抖动：同 payload 重发必然同样被拒，重试只会把延迟翻倍
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raw.status).toBe(400);
  });

  it('未知业务码仍要带出上游原文（否则只剩一串数字）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11999, msg: 'brand new upstream rule' }))),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    const body = raw.sent as { error?: { code?: string; message?: string } };
    expect(body?.error?.code).toBe('upstream_11999');
    expect(String(body?.error?.message)).toContain('brand new upstream rule');
    expect(latest()!.upstream_code).toBe(11999);
  });

  it('上游原文会折叠换行并截断到 200 字符（不把整段正文灌进日志）', async () => {
    const huge = `line one\n\n   line two ${'x'.repeat(500)}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11998, msg: huge }))),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    const body = raw.sent as { error?: { message?: string } };
    const msg = String(body?.error?.message);
    expect(msg).not.toContain('\n');
    // 200 字符原文 + 前缀文案，整体远小于原文长度
    expect(msg.length).toBeLessThan(huge.length);
    expect(msg).toContain('line one line two');
  });
});

/**
 * [2026-10-07] L2 fail-open：上游渠道校验拒绝（400/11128）→ 以 neutral 档降级重试一次。
 * 兜的是「L1 规则表漏掉上游新增指纹变体」的失效模式：整条请求从"死"变"降级可用"。
 */
describe('11128 · 降级重试（L2 fail-open）', () => {
  function sseBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc.encode('data: {"id":"c1","choices":[{"delta":{"content":"好"}}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
  }

  it('★ 首次 400/11128 → 降级重发一次 → 200 SSE；落一行 200 且 note 含降级标记', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        calls.push(String(init?.body));
        if (calls.length === 1) {
          return failingResponse(400, JSON.stringify({ code: 11128, message: 'upstream rejected' }));
        }
        return { ok: true, status: 200, body: sseBody() };
      }),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);
    await waitEnded(raw);

    // 恰好两次上游调用：第一次被拒，第二次降级成功
    expect(calls).toHaveLength(2);
    // 降级请求的 system 已被换成中性提示（neutral 档）
    expect(calls[1]).toContain('You are a helpful assistant.');
    // 客户端拿到的是 SSE 200（不是 502）
    expect(raw.status).toBe(200);
    expect(raw.writes.join('')).toContain('data: ');

    // 恰好落一行，status=200，note 留有降级痕迹
    const rows = db.prepare('SELECT * FROM requests').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(200);
    expect(String(rows[0].note)).toContain('sysprompt_degraded_retry');
  });

  it('降级重试也被拒 → 502 + JSON（fail-open 失败时不吞错），且只重试一次', async () => {
    const fetchMock = vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11128, message: 'upstream rejected' })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    // 恰好两次（原始 + 一次降级），不会循环
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(raw.status).toBe(502);
    const rows = db.prepare('SELECT * FROM requests').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(502);
    expect(String(rows[0].note)).toContain('sysprompt_degraded_retry');
    expect(String(rows[0].note)).toContain('upstream_11128');
  });

  it('off 档不降级：400/11128 直接回给客户端（关闭改写 = 关闭降级）', async () => {
    const fetchMock = vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11128, message: 'upstream rejected' })));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ModelCatalogRepository(db);
    const providers2 = new ProvidersRepository(db);
    providers2.create({ id: 'p_wire', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
    catalog.seed('p_wire', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
    const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog, providers2);
    const config = {
      get: () => ({
        limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
        upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://up.example.com', promptRewrite: 'off' },
        logs: { recordRequestBody: false, recordResponseBody: false },
      }),
      upstreamKey: 'ck_test.SECRET',
    } as unknown as RelayConfigService;
    const controller = new ProxyController(new ProxyService(config, catalog, log, providers2, undefined, fakeWbOauth('ck_test_0123456789abcdef')), catalog, providers2);
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raw.status).toBe(502);
  });
});

/**
 * [v0.2.0 B5] 11133 瞬时抖动自动幂等重试：首次 400/11133 → 1s 后同 payload 重发 → 200。
 * 断言 retried note、retry_count 落库、恰好一行审计。
 */
describe('11133 · 瞬时抖动幂等重试（v0.2.0）', () => {
  // 注：重试阶梯是真实延时（1s/4s），两个用例都给足测试超时。
  it('★ 首次 400/11133 → 自动重发一次 → 200 SSE；note 含 retried 且 retry_count=1', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: { body?: string }) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) {
          return failingResponse(400, JSON.stringify({ code: 11133, message: 'max_tokens too small' }));
        }
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(enc.encode('data: {"id":"c1","choices":[{"delta":{"content":"好"}}]}\n\n'));
              c.enqueue(enc.encode('data: [DONE]\n\n'));
              c.close();
            },
          }),
        };
      }),
    );
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);
    await waitEnded(raw);

    // 恰好两次、同 payload（幂等重试不是重新改写）
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(raw.status).toBe(200);

    const rows = db.prepare('SELECT * FROM requests').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(200);
    expect(String(rows[0].note)).toContain('retried');
    expect(rows[0].retry_count).toBe(1);
  }, 20_000);

  it('重试两次仍 11133 → 400 返回客户端（不无限重试），retried 留痕、retry_count=2', async () => {
    const fetchMock = vi.fn(async () => failingResponse(400, JSON.stringify({ code: 11133, message: 'max_tokens too small' })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();
    const { reply, raw } = fakeReply();

    await controller.chatCompletions(req() as never, reply, streamBody() as never);

    // 原始 + 两档重试 = 恰好 3 次
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(raw.status).toBe(400);
    const rows = db.prepare('SELECT * FROM requests').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].retry_count).toBe(2);
    expect(String(rows[0].note)).toContain('retried');
    expect(String(rows[0].note)).toContain('invalid_max_tokens');
  }, 20_000);
});
