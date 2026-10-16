/**
 * 密钥权限范围（`key.scope`）**在真实请求路径上生效**的行为证据（api-contract §2.1.2 第 3 步附）。
 *
 * ── 这个测试为谁而写 ────────────────────────────────────────────────────
 *
 * `scope` 之前是「存了但没人读」：界面有「权限范围」一列、创建时有校验、
 * 契约也写着「命中后校验 key.scope，越权 403」—— 而请求路径上**一次都没读过**。
 * 所以界面上写着「仅 kimi 系」的密钥，实际能调 `glm-5.3`。
 *
 * 这个测试**必须走 controller 公共边界**（与 `proxy-wiring.spec.ts` 同一套夹具），
 * 因为要证明的正是「这条路真的会被挡住」，而不是「有个纯函数返回了 false」——
 * 后者已由 `model-scope.spec.ts` 覆盖。两者缺一不可：
 * 纯函数对了但没人调它，正是这个 bug 原本的形态。
 *
 * 断言三件事（每件都是"用户会遇到的后果"）：
 *   ① 越权 → 403 `model_not_allowed`，且**不产生任何上游请求**（fetch 未被调用）；
 *   ② 越权这一行**照样落库**（排障要能在请求日志里看到它，且 status=403）；
 *   ③ 范围内 → 正常转发（证明这个改动没有把功能整体关掉）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyReply } from 'fastify';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { runMigrations } from '../store/migrate';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import type { RelayConfigService } from '../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';

const KEY_ID = 'k_scope';
const CLIENT_KEY_HINT = 'sk-waygate-scop…e001';

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

/** 目录里四个不同系、不同标签的模型，用来区分四种 scope。 */
const SEED = [
  { id: 'kimi-k3', displayName: 'Kimi-K3', tag: '订阅优先', multiplier: 1.62 },
  { id: 'glm-5.3', displayName: 'GLM-5.3', tag: '订阅优先', multiplier: 0.79 },
  { id: 'deepseek-v4.1-flash', displayName: 'Deepseek-V4.1-Flash', tag: '夜间折扣', multiplier: 0.11 },
  { id: 'minimax-m3', displayName: 'MiniMax-M3', tag: null, multiplier: 0.25 },
];

function makeHarness(scope: KeyContext['scope']) {
  const db = new Database(':memory:');
  // 空库 → 走 schema.sql 一次建表（与生产首启同一条路径）。
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  const keys = new ClientKeysRepository(db);
  const catalog = new ModelCatalogRepository(db);
  catalog.seed('p_test', SEED);
  const providers = new ProvidersRepository(db);
  providers.create({ id: 'p_test', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog);

  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://up.example.com' },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_scope.SECRET',
  } as unknown as RelayConfigService;

  keys.create({
    id: KEY_ID,
    name: '范围测试密钥',
    keyHash: 'h_scope',
    keyHint: CLIENT_KEY_HINT,
    scope: JSON.stringify(scope),
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });

  const controller = new ProxyController(new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef')), catalog, providers);
  const latest = (): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
  const keyContext: KeyContext = {
    keyId: KEY_ID,
    keyHint: CLIENT_KEY_HINT,
    client: 'Claude Code',
    clients: [],
    scope,
  };
  return { db, controller, latest, keyContext };
}

/** SSE 上游响应（含 [DONE]），让非流式聚合能正常收尾。 */
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
  `data: ${JSON.stringify({ id: 'c1', model: 'kimi-k3', choices: [{ delta: { content } }] })}\n\n`;

/** 打一次 /v1/chat/completions；返回「是否真的发出了上游请求」与响应状态。 */
async function invoke(
  h: ReturnType<typeof makeHarness>,
  model: string,
): Promise<{ status: number; body: unknown; upstreamCalled: boolean }> {
  const fetchSpy = vi.fn(sseUpstream([FRAME('hi'), 'data: [DONE]\n\n']));
  vi.stubGlobal('fetch', fetchSpy);
  const { reply, state } = fakeReply();
  const req = {
    headers: { authorization: `Bearer ${CLIENT_KEY_HINT}`, 'user-agent': 'claude-cli/1.0' },
    ip: '127.0.0.1',
    keyContext: h.keyContext,
  } as RequestWithKeyContext;
  await h.controller.chatCompletions(
    req as never,
    reply,
    { model, messages: [{ role: 'user', content: '你好' }], stream: false } as never,
  );
  return { status: state.status, body: state.body, upstreamCalled: fetchSpy.mock.calls.length > 0 };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scope=all · 不设限（回归：默认行为不变）', () => {
  it('任意模型正常转发', async () => {
    const h = makeHarness({ type: 'all' });
    const r = await invoke(h, 'glm-5.3');
    expect(r.upstreamCalled).toBe(true);
    expect(r.status).toBe(200);
  });
});

describe('scope=family · 仅某系', () => {
  it('★ 同系放行', async () => {
    const h = makeHarness({ type: 'family', value: 'kimi' });
    const r = await invoke(h, 'kimi-k3');
    expect(r.upstreamCalled).toBe(true);
    expect(r.status).toBe(200);
  });

  it('★ 异系被 403 挡住，且**完全不发上游请求**', async () => {
    const h = makeHarness({ type: 'family', value: 'kimi' });
    const r = await invoke(h, 'glm-5.3');

    expect(r.status).toBe(403);
    // 「不转发」是契约明文要求（§2.1.2 第 3 步）—— 被挡下的请求不该消耗上游额度
    expect(r.upstreamCalled).toBe(false);
    const err = (r.body as { error?: { code?: string; message?: string } }).error;
    expect(err?.code).toBe('model_not_allowed');
    // 文案要能回答「那我该用什么」：带上本密钥的范围
    expect(err?.message).toContain('仅 kimi 系');
  });

  it('★ 越权这一行照样落库（排障能在请求日志里看到它）', async () => {
    const h = makeHarness({ type: 'family', value: 'kimi' });
    await invoke(h, 'glm-5.3');

    const row = h.latest()!;
    expect(row.status).toBe(403);
    // 模型要带上 —— 「403 但不知道是哪个模型被挡」是排障时最没用的行
    expect(row.model).toBe('glm-5.3');
    expect(String(row.note)).toContain('model not permitted');
    expect(row.credits).toBe(0); // 被拒不吃积分
  });
});

describe('scope=tag · 仅某标签', () => {
  it('★ 标签匹配放行', async () => {
    const h = makeHarness({ type: 'tag', value: '订阅优先' });
    const r = await invoke(h, 'kimi-k3');
    expect(r.upstreamCalled).toBe(true);
  });

  it('★ 标签不匹配被挡（同为订阅优先的 glm 放行、夜间折扣的 deepseek 不放行）', async () => {
    const h = makeHarness({ type: 'tag', value: '订阅优先' });
    const r = await invoke(h, 'deepseek-v4.1-flash');
    expect(r.status).toBe(403);
    expect(r.upstreamCalled).toBe(false);
  });

  it('★ 无标签的模型不被放行（「仅订阅优先」不能因为 minimax 没标签就放它进来）', async () => {
    const h = makeHarness({ type: 'tag', value: '订阅优先' });
    const r = await invoke(h, 'minimax-m3');
    expect(r.status).toBe(403);
  });
});

describe('scope=models · 指定清单', () => {
  it('★ 清单内放行、清单外拦截', async () => {
    const h = makeHarness({ type: 'models', value: ['kimi-k3'] });
    const ok = await invoke(h, 'kimi-k3');
    expect(ok.upstreamCalled).toBe(true);

    const bad = await invoke(h, 'glm-5.3');
    expect(bad.status).toBe(403);
    expect(bad.upstreamCalled).toBe(false);
  });

  it('★ 按**显示名**请求也按解析后的 id 判定（Kimi-K3 → kimi-k3 在清单内 → 放行）', async () => {
    const h = makeHarness({ type: 'models', value: ['kimi-k3'] });
    const r = await invoke(h, 'Kimi-K3');
    expect(r.status).toBe(200);
    expect(r.upstreamCalled).toBe(true);
  });
});

describe('与既有两条检查的顺序', () => {
  it('★ 模型不存在 → 400（而不是越权的 403）：先报全局、再报个体', async () => {
    const h = makeHarness({ type: 'family', value: 'kimi' });
    const r = await invoke(h, 'no-such-model');
    expect(r.status).toBe(400);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('model_not_found');
  });

  it('★ 已下架的模型 → 403 且文案说「已下架」（对所有密钥都不可用，先报这个）', async () => {
    const h = makeHarness({ type: 'family', value: 'kimi' });
    // 下架一个**范围内**的模型，确保命中的是"下架"而不是"越权"
    h.db.prepare('UPDATE model_catalog SET enabled = 0 WHERE id = ?').run('kimi-k3');
    const r = await invoke(h, 'kimi-k3');
    expect(r.status).toBe(403);
    // 命运中的是「下架」那条（原文案），而不是新加的「越权」那条
    expect((r.body as { error?: { message?: string } }).error?.message).toContain('控制台下架');
    expect(r.upstreamCalled).toBe(false);
  });
});
