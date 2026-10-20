/**
 * 自定义提供商出站（v1.7.0 doCallCustom）的行为证据 —— 走 controller 公共边界，
 * 断言结果而非"函数被调用"（与 proxy-wiring.spec 同一条纪律）。
 *
 * 钉五件事：
 *   ① URL 智能解析：无版本段 → /v1/chat/completions；以 /vN 结尾 → /chat/completions；
 *      显式 chatPath → 原样拼。
 *   ② 头是纯 Bearer：**没有** WorkBuddy 指纹（x-codebuddy-request / x-machine-id /
 *      origin codebuddy / UA WorkBuddy）—— 这些头出现在通用端点上只会招来误判。
 *   ③ **不做 prompt 重写**：即使设置里 promptRewrite=neutral，上游收到的也是
 *      客户端原文（重写是 WorkBuddy 指纹对抗，对通用端点是污染）。
 *   ④ 错误映射：上游 401 → 502 upstream_credential_invalid + 失败体 message 进响应。
 *   ⑤ 归属事实列：requests.provider_id = custom 那家（v1.6.30 的机制对 custom 同样成立）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import type { RelayConfigService } from '../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';
import { buildCustomChatUrl } from './upstream-url';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');
const KEY_ID = 'k_cu';
const CLIENT_KEY_HINT = 'sk-waygate-aaaa…bbbb';
const API_KEY = 'sk-custom-test-1234567890';

const keyContext: KeyContext = {
  keyId: KEY_ID,
  keyHint: CLIENT_KEY_HINT,
  client: 'Claude Code',
  clients: [],
  scope: { type: 'all' },
};

let dataDir: string;

function makeHarness(opts: { baseUrl?: string; chatPath?: string | null } = {}) {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const keys = new ClientKeysRepository(db);
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  providers.create({
    id: 'p_cu', name: 'DeepSeek', baseUrl: opts.baseUrl ?? 'https://api.deepseek.com',
    active: true, protocol: 'custom', credKind: 'static', chatPath: opts.chatPath ?? null,
  });
  catalog.seed('p_cu', [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat', tag: null, multiplier: null }]);
  keys.create({
    id: KEY_ID, name: 'custom 测试密钥', keyHash: 'h_cu', keyHint: CLIENT_KEY_HINT,
    scope: '{"type":"all"}', client: 'Claude Code', clients: JSON.stringify(['Claude Code']),
    expiresAt: null, source: 'console',
  });
  const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog);
  /* promptRewrite=neutral + 注入提示 —— 若 custom 路径漏了"跳过重写"，上游会多出一条 system。 */
  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: {
        spoofUA: true, userAgent: 'WorkBuddy/5.8.0', baseUrl: 'https://copilot.tencent.com',
        promptRewrite: 'neutral', defaultSystemPrompt: 'NEUTRAL-INJECTED',
      },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_unused000000000000',
  } as unknown as RelayConfigService;
  const controller = new ProxyController(
    new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('oauth-unused')),
    catalog, providers,
  );
  const latest = (): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  return { db, controller, latest };
}

type Harness = ReturnType<typeof makeHarness>;

function fakeReply(): { reply: FastifyReply; state: { status: number; body: unknown } } {
  const state = { status: 0, body: undefined as unknown };
  const reply = {
    code(n: number) { state.status = n; return reply; },
    header() { return reply; },
    send(b: unknown) { state.body = b; return reply; },
  } as unknown as FastifyReply;
  return { reply, state };
}

/** 记录 URL/头/体的 fetch 替身；上游行为由 impl 决定。 */
function recordingFetch(impl: (url: string) => Promise<unknown>) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return impl(url);
  }));
  return seen;
}

function sseUpstream(texts: string[]): () => Promise<unknown> {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const t of texts) c.enqueue(enc.encode(t)); c.close(); },
  });
  return async () => ({ ok: true, status: 200, body, text: async () => '' });
}

const FRAME = (content: string) =>
  `data: ${JSON.stringify({ id: 'c1', model: 'deepseek-chat', choices: [{ delta: { content } }] })}\n\n`;

async function invoke(h: Harness, fetchImpl: (url: string) => Promise<unknown>) {
  const seen = recordingFetch(fetchImpl);
  const { reply, state } = fakeReply();
  const req = {
    headers: { authorization: `Bearer ${CLIENT_KEY_HINT}`, 'user-agent': 'claude-cli/1.0' },
    ip: '127.0.0.1', keyContext,
  } as RequestWithKeyContext;
  await h.controller.chatCompletions(req as never, reply, {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    stream: false,
  } as never);
  return { seen, state };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cu-proxy-'));
  process.env.RELAY_DATA_DIR = dataDir;
  mkdirSync(join(dataDir, 'providers'), { recursive: true });
  writeFileSync(join(dataDir, 'providers', 'p_cu.key'), API_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RELAY_DATA_DIR;
});

describe('buildCustomChatUrl · 智能默认（纯函数）', () => {
  it('无版本段 → 拼 /v1/chat/completions', () => {
    expect(buildCustomChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
  });
  it('以 /v1 结尾 → 只拼 /chat/completions（用户把版本段含进了 base）', () => {
    expect(buildCustomChatUrl('https://api.x.com/v1')).toBe('https://api.x.com/v1/chat/completions');
  });
  it('以 /v2 等其它版本段结尾 → 同样只拼 /chat/completions', () => {
    expect(buildCustomChatUrl('https://gw.example.com/v2')).toBe('https://gw.example.com/v2/chat/completions');
  });
  it('显式 chatPath 优先于一切默认', () => {
    expect(buildCustomChatUrl('https://api.x.com/v1', '/openai/d/chat/completions')).toBe('https://api.x.com/openai/d/chat/completions');
  });
  it('尾斜杠吸收', () => {
    expect(buildCustomChatUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('doCallCustom · 出站行为', () => {
  it('★ URL 智能解析 + Bearer 来自 .key 文件', async () => {
    const h = makeHarness();
    const { seen } = await invoke(h, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    expect(seen[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('★ 无 WorkBuddy 指纹头（指纹对通用端点只有害处）', async () => {
    const h = makeHarness();
    const { seen } = await invoke(h, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const headers = seen[0]!.headers;
    expect(headers['x-codebuddy-request']).toBeUndefined();
    expect(headers['x-machine-id']).toBeUndefined();
    expect(headers['x-session-id']).toBeUndefined();
    expect(headers.origin).toBeUndefined();
    expect(String(headers['user-agent'] ?? '')).not.toContain('WorkBuddy');
  });

  it('★ 不做 prompt 重写：设置里 neutral 也不注入 system（上游收到客户端原文）', async () => {
    const h = makeHarness();
    const { seen } = await invoke(h, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const body = seen[0]!.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(JSON.stringify(body)).not.toContain('NEUTRAL-INJECTED');
  });

  it('base 以 /v1 结尾 / 显式 chatPath —— 与 buildCustomChatUrl 同一条规则', async () => {
    const h1 = makeHarness({ baseUrl: 'https://api.x.com/v1' });
    await invoke(h1, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    const h2 = makeHarness({ chatPath: '/api/v3/chat' });
    const r2 = await invoke(h2, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    expect(r2.seen[0]?.url).toBe('https://api.deepseek.com/api/v3/chat');
  });

  it('★ 上游 401 → 502 upstream_credential_invalid，失败体 message 透出', async () => {
    const h = makeHarness();
    const { state } = await invoke(h, async () => ({
      ok: false, status: 401, body: null,
      text: async () => JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }),
    }));
    expect(state.status).toBe(502);
    const err = (state.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('upstream_credential_invalid');
    expect(err.message).toContain('Invalid API key');
  });

  it('★ 归属事实列：requests.provider_id = custom 那家', async () => {
    const h = makeHarness();
    await invoke(h, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    expect(h.latest()?.provider_id).toBe('p_cu');
  });

  it('凭证文件缺失 → 502 upstream_credential_invalid（note=missing custom api key）', async () => {
    writeFileSync(join(dataDir, 'providers', 'p_cu.key'), ''); // 清空 = 未配置
    const h = makeHarness();
    const { state } = await invoke(h, sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
    expect(state.status).toBe(502);
    expect((state.body as { error: { code: string } }).error.code).toBe('upstream_credential_invalid');
    /* note 是逗号拼接（失败行还会带 credits_unknown），这里只钉本路径的那一段。 */
    expect(String(h.latest()?.note)).toContain('missing custom api key');
  });
});
