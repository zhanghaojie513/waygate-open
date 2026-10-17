/**
 * [v1.6.27] 11128 渠道熔断 wire 回归：连续渠道级 11128（降级重试也败）后，
 * 后续请求**不再打上游**、立即 502 + breaker_open，且落审计行不带业务码
 * （上游根本没回 —— 反代保真铁律）。
 *
 * 同时钉住「内容级 11128 不触发熔断」：rewrite=off 时没有降级重试，
 * 三个连续 11128 之后第 4 个请求**仍应正常打上游**（不 fast-fail）。
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
const KEY_ID = 'k_brkwire';

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
  new ClientKeysRepository(db).create({
    id: KEY_ID,
    name: '熔断 wire 测试',
    keyHash: 'h_brkwire',
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

function makeController(promptRewrite?: string) {
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
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://up.example.com', ...(promptRewrite ? { promptRewrite } : {}) },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_test.SECRET',
  } as unknown as RelayConfigService;
  return new ProxyController(
    new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef')),
    catalog,
    providers,
  );
}

const latest = () => db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

const req = (): RequestWithKeyContext =>
  ({ headers: { authorization: 'Bearer sk-waygate-aaaa…bbbb', 'user-agent': 'ZCode/3.14.4' }, ip: '127.0.0.1', keyContext }) as RequestWithKeyContext;

const streamBody = () => ({ model: 'kimi-k2.7', messages: [{ role: 'user', content: 'hi' }], stream: true });

interface RawState {
  status: number;
  sent: unknown;
  writes: string[];
  ended: boolean;
  events: EventEmitter;
}

/** 同时支持 `reply.code().send()`（错误路径）与 `reply.raw.*`（SSE 200 路径）的假 reply。 */
function fakeReply(): { reply: FastifyReply; raw: RawState } {
  const raw: RawState = { status: 0, sent: undefined, writes: [], ended: false, events: new EventEmitter() };
  const rawObj = {
    writeHead(code: number) {
      raw.status = code;
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

/** 等到 raw.end() 被调用（SSE 的 async IIFE 完成）。 */
async function waitEnded(raw: RawState, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!raw.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

function failing11128() {
  let consumed = false;
  return {
    ok: false,
    status: 400,
    text: async () => {
      if (consumed) throw new TypeError('Body is unusable');
      consumed = true;
      return JSON.stringify({ code: 11128, message: 'Illegal API invocation from an unapproved channel' });
    },
  };
}

describe('v1.6.27 · 11128 渠道熔断 wire 行为', () => {
  it('★ 连续 3 次渠道级 11128（降级也败）后，第 4 个请求快速失败且不再打上游', async () => {
    const fetchMock = vi.fn(async () => failing11128());
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController(); // promptRewrite 默认（template）→ 每请求模板+降级两次上游调用

    for (let i = 1; i <= 3; i += 1) {
      const { reply, raw } = fakeReply();
      await controller.chatCompletions(req() as never, reply, streamBody() as never);
      expect(raw.status).toBe(502);
      expect(String(latest().note)).toContain('sysprompt_degraded_retry'); // 渠道级信号：降级也败
    }
    expect(fetchMock.mock.calls.length).toBe(6); // 3 请求 × (模板 + 降级)

    // 第 4 个：熔断开闸 → 不发上游、立即 502、审计行不带业务码
    const before = fetchMock.mock.calls.length;
    const { reply, raw } = fakeReply();
    await controller.chatCompletions(req() as never, reply, streamBody() as never);
    expect(fetchMock.mock.calls.length).toBe(before); // ★ 没有再打上游
    expect(raw.status).toBe(502);
    const body = raw.sent as { error?: { code?: string; message?: string } };
    expect(body?.error?.code).toBe('upstream_channel_blocked');
    expect(String(body?.error?.message)).toContain('熔断');

    const row = latest()!;
    expect(row.status).toBe(502);
    expect(row.upstream_code).toBeNull(); // 保真：上游未回报即 null
    expect(String(row.note)).toContain('breaker_open'); // 其余 note（system_injected 等）是改写层正常标记
  });

  it('★ 内容级 11128（rewrite=off，无降级重试）不触发熔断 —— 第 4 个请求仍正常打上游', async () => {
    const fetchMock = vi.fn(async () => failing11128());
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('off');

    for (let i = 1; i <= 3; i += 1) {
      const { reply } = fakeReply();
      await controller.chatCompletions(req() as never, reply, streamBody() as never);
    }
    expect(fetchMock.mock.calls.length).toBe(3); // rewrite=off：每请求只打一次上游

    const before = fetchMock.mock.calls.length;
    const { reply, raw } = fakeReply();
    await controller.chatCompletions(req() as never, reply, streamBody() as never);
    expect(fetchMock.mock.calls.length).toBe(before + 1); // ★ 仍在打上游（未熔断）
    expect(raw.status).toBe(502);
    expect(String(latest().note)).toContain('upstream_11128'); // 走的是正常失败映射，不是 breaker_open
  });

  it('★ 熔断期内一次成功（换提供商口径不可行 —— 用冷却到期模拟半开探测成功更直接）：这里钉「成功复位」', async () => {
    // 借道：两个拒绝 + 一次成功（上游恢复）→ 计数清零，再来两个拒绝不开闸。
    let ok = false;
    const fetchMock = vi.fn(async () =>
      ok ? { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"id":"c1","choices":[{"delta":{"content":"x"}}]}\n\n')); c.close(); } }) } : failing11128(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();

    for (let i = 0; i < 2; i += 1) {
      const { reply } = fakeReply();
      await controller.chatCompletions(req() as never, reply, streamBody() as never);
    }
    ok = true; // 上游恢复：这一单成功（降级重试成功 → res.ok → recordHealthy 复位）
    {
      const { reply, raw } = fakeReply();
      await controller.chatCompletions(req() as never, reply, streamBody() as never);
      await waitEnded(raw);
      expect(raw.status).toBe(200); // 上游接受 = 渠道健康（审计行的 usage 缺失语义与本测试无关）
    }
    ok = false; // 再来两个拒绝 —— 若复位生效，不满阈值，不开闸
    for (let i = 0; i < 2; i += 1) {
      const { reply } = fakeReply();
      await controller.chatCompletions(req() as never, reply, streamBody() as never);
      expect(String(latest().note)).not.toContain('breaker_open');
    }
  });
});
