/**
 * 设置接线（task#37 A1 + A3）的**行为证据** —— 走 controller 公共边界，断言结果而非"函数被调用"。
 *
 *   A1 `upstream.baseUrl`：转发必须打到**设置里配的**上游，而不是某个硬编码常量。
 *      （此前 proxy.service 把地址写死成 copilot.tencent.com，改设置页不生效 —— 空壳项。）
 *   A3 `logs.recordRequestBody` / `recordResponseBody`：
 *      开着 → 库里存请求/响应体（超长截断、绝不含密钥）；关着（默认）→ 恒 null。
 *
 * 断言都落在数据库行上（`requests.request_body/response_body`），与生产写路径同源。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import { BODY_CAP_CHARS, TRUNCATION_MARK } from './body-capture';
import type { RelayConfigService } from '../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');
const KEY_ID = 'k_wire';
const UPSTREAM_KEY = 'ck_t48dck4e5yju.SECRETVALUE';
const CLIENT_KEY_HINT = 'sk-waygate-aaaa…bbbb';

const keyContext: KeyContext = {
  keyId: KEY_ID,
  keyHint: CLIENT_KEY_HINT,
  client: 'Claude Code',
  clients: [],
  scope: { type: 'all' },
};

interface ReplyState {
  status: number;
  body: unknown;
}
function fakeReply(): { reply: FastifyReply; state: ReplyState } {
  const state: ReplyState = { status: 0, body: undefined };
  const reply = {
    code(n: number) {
      state.status = n;
      return reply;
    },
    header() {
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

interface WiringOptions {
  baseUrl?: string;
  recordRequestBody?: boolean;
  recordResponseBody?: boolean;
}

function makeHarness(opts: WiringOptions = {}) {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const keys = new ClientKeysRepository(db);
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  providers.create({ id: 'p_wire', name: 'TestUpstream', baseUrl: (opts && 'baseUrl' in opts ? opts.baseUrl : undefined) ?? 'https://default.example.com', active: true });
  const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog);

  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: opts.baseUrl ?? 'https://default.example.com' },
      logs: {
        recordRequestBody: opts.recordRequestBody ?? false,
        recordResponseBody: opts.recordResponseBody ?? false,
      },
    }),
    upstreamKey: UPSTREAM_KEY,
  } as unknown as RelayConfigService;

  catalog.seed('p_wire', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  keys.create({
    id: KEY_ID,
    name: '布线测试密钥',
    keyHash: 'h_wire',
    keyHint: CLIENT_KEY_HINT,
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });

  const controller = new ProxyController(new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth(UPSTREAM_KEY)), catalog, providers);
  const latest = (): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
  return { db, controller, latest };
}

type Harness = ReturnType<typeof makeHarness>;

/** 造一个 SSE 上游响应（含 [DONE]），让非流式聚合能正常收尾。 */
function sseUpstream(texts: string[]): () => Promise<unknown> {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const t of texts) c.enqueue(enc.encode(t));
      c.close();
    },
  });
  return async () => ({ ok: true, status: 200, body, text: async () => '' });
}

const FRAME = (content: string) =>
  `data: ${JSON.stringify({ id: 'c1', model: 'kimi-k2.7', choices: [{ delta: { content } }] })}\n\n`;

/** 打一次 /v1/chat/completions（非流式入站 → 走聚合路径），返回 fetch 记下的 URL。 */
async function invoke(
  h: Harness,
  body: unknown,
  fetchImpl: (url: string) => Promise<unknown>,
): Promise<{ seenUrl: string }> {
  let seenUrl = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seenUrl = url;
      return fetchImpl(url);
    }),
  );
  const { reply } = fakeReply();
  const req = {
    headers: { authorization: `Bearer ${CLIENT_KEY_HINT}`, 'user-agent': 'claude-cli/1.0' },
    ip: '127.0.0.1',
    keyContext,
  } as RequestWithKeyContext;
  await h.controller.chatCompletions(req as never, reply, body as never);
  return { seenUrl };
}

const body = (extra: Record<string, unknown> = {}) => ({
  model: 'kimi-k2.7',
  messages: [{ role: 'user', content: '你好' }],
  stream: false,
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('A1 · upstream.baseUrl 已接线（转发读设置，不再硬编码）', () => {
  it('① 转发打到设置里的上游地址（自定义 host 生效）', async () => {
    const h = makeHarness({ baseUrl: 'https://upstream.custom.example.com' });
    const { seenUrl } = await invoke(h, body(), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));

    expect(seenUrl).toBe('https://upstream.custom.example.com/v2/chat/completions');
    expect(seenUrl).not.toContain('copilot.tencent.com');
  });

  it('② baseUrl 尾部斜杠不产生双斜杠', async () => {
    const h = makeHarness({ baseUrl: 'https://upstream.custom.example.com///' });
    const { seenUrl } = await invoke(h, body(), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    expect(seenUrl).toBe('https://upstream.custom.example.com/v2/chat/completions');
  });
});

describe('A3 · 记录请求体 / 响应体已接线', () => {
  it('③ 默认关闭 → request_body / response_body 恒 null（不落对话内容）', async () => {
    const h = makeHarness();
    await invoke(h, body(), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const row = h.latest()!;
    expect(row.request_body).toBeNull();
    expect(row.response_body).toBeNull();
  });

  it('④ recordRequestBody 打开 → 落请求体，且能解析出 messages', async () => {
    const h = makeHarness({ recordRequestBody: true });
    await invoke(h, body(), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const row = h.latest()!;
    const stored = row.request_body as string;
    expect(typeof stored).toBe('string');
    const parsed = JSON.parse(stored) as { messages: Array<{ content: string }> };
    expect(parsed.messages[0]!.content).toBe('你好');
  });

  it('⑤ recordResponseBody 打开 → 落响应体（含上游 SSE 帧）', async () => {
    const h = makeHarness({ recordResponseBody: true });
    await invoke(h, body(), sseUpstream([FRAME('hi'), FRAME(' there'), 'data: [DONE]\n\n']));
    const stored = h.latest()!.response_body as string;
    expect(typeof stored).toBe('string');
    expect(stored).toContain('data: ');
    expect(stored).toContain('hi');
    expect(stored).toContain('there');
  });

  it('⑥ ★ 存的体里绝不出现任何密钥（Authorization 只在请求头）', async () => {
    const h = makeHarness({ recordRequestBody: true, recordResponseBody: true });
    await invoke(h, body(), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const row = h.latest()!;
    const all = `${String(row.request_body)}\n${String(row.response_body)}`;
    expect(all).not.toContain(UPSTREAM_KEY);
    expect(all).not.toContain('ck_');
    /* 断言**当前**入站前缀：这条守卫测的是「本机密钥绝不出站」，
       若只断言已退役的旧前缀，守卫会退化成永远通过的空断言。 */
    expect(all).not.toContain('sk-waygate-');
    expect(all).not.toContain('sk-relay-');
  });

  it('⑦ 超长请求体被截断到上限并留标记（不撑爆 requests 表）', async () => {
    const h = makeHarness({ recordRequestBody: true });
    const huge = 'x'.repeat(BODY_CAP_CHARS + 5000);
    await invoke(h, body({ messages: [{ role: 'user', content: huge }] }), sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const stored = h.latest()!.request_body as string;
    expect(stored.length).toBe(BODY_CAP_CHARS + TRUNCATION_MARK.length);
    expect(stored.endsWith(TRUNCATION_MARK)).toBe(true);
  });
});
