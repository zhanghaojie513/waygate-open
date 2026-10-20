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
import { OverviewService } from '../api/overview.service';
import { resolveWindow } from '../api/window';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import type { RelayConfigService } from '../config/config.service';
import { QuotaSourceService } from './quota/quota-source.service';
import type { KeyContext, RequestWithKeyContext } from '../auth/key.guard';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';

/**
 * 失败请求必须落库（spec-v4-failure-logging.md）。
 *
 * 关键纪律（AC-F09 门禁）：**所有断言都走 controller 公共边界**
 * （`ProxyController.chatCompletions`），不碰 service 私有方法 —— 这样本 spec 在
 * 「未修复」的代码上也能编译、且必须**真实变红**（此前失败路径一行都不落）。
 * 断言的是**结果**：库里有没有那一行、成功率是多少，而不是「persist 被调用」。
 */

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');
const KEY_ID = 'k_fail';
const CLIENT = 'Claude Code';

const keyContext: KeyContext = {
  keyId: KEY_ID,
  keyHint: 'sk-waygate-aaaa…bbbb',
  client: CLIENT,
  clients: [],
  scope: { type: 'all' },
};

const validBody = () => ({
  model: 'kimi-k2.7',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});

interface ReplyState {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function fakeReply(): { reply: FastifyReply; state: ReplyState } {
  const state: ReplyState = { status: 0, headers: {}, body: undefined };
  const reply = {
    code(n: number) {
      state.status = n;
      return reply;
    },
    header(k: string, v: string) {
      state.headers[k] = v;
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

function makeHarness() {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const keys = new ClientKeysRepository(db);
  const requests = new RequestsRepository(db, new AggregatesRepository(db));
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  /* 占位：baseUrl 随 config 一起定（路由读 provider 行，不再读 config） */
  const log = new ProxyLogger(requests, catalog);
  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.7.7', baseUrl: 'https://copilot.tencent.com' },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_test_0123456789abcdef',
  } as unknown as RelayConfigService;

  catalog.seed('p_wire', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  catalog.seed('p_wire', [{ id: 'retired-model', displayName: 'Retired', tag: null, multiplier: 1 }]);
  catalog.setEnabled('p_wire', 'retired-model', false);

  keys.create({
    id: KEY_ID,
    name: '测试密钥',
    keyHash: 'h_fail',
    keyHint: 'sk-waygate-aaaa…bbbb',
    scope: '{"type":"all"}',
    client: CLIENT,
    clients: JSON.stringify([CLIENT]),
    expiresAt: null,
    source: 'console',
  });

  providers.create({ id: 'p_wire', name: 'TestUpstream', baseUrl: (config.get() as { upstream: { baseUrl: string } }).upstream.baseUrl, active: true });
  const controller = new ProxyController(new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef')), catalog, providers);
  // 额度来源与本 spec（失败落库）无关：给「未接入」桩，避免真起轮询。
  // [v0.5.15] byClient 归属需要目录与提供商；本 spec 不 seed 目录 → 全走密钥回落，与旧口径一致。
  const overview = new OverviewService(db, {
    block: () => ({ available: false, reason: 'pending', remain: null, total: null, resetAt: null, stale: false, low: false, message: '（测试桩）' }),
    snapshot: () => ({ ledger: [], fetchedAt: null }),
  } as unknown as QuotaSourceService, { allBlocks: () => [] } as unknown as import('../proxy/anthropic-upstream/minimax-credit.service').MinimaxCreditService, catalog, providers, undefined);

  let seq = 0;
  /** 造一条成功行（走生产写路径 RequestsRepository.log）。 */
  const insertSuccess = (credits = 1): void => {
    requests.log({
      ts: Date.now(),
      traceId: `ok-${++seq}`,
      clientId: KEY_ID,
      client: CLIENT,
      clientRule: 2,
      keyId: KEY_ID,
      keyHint: 'sk-waygate-aaaa…bbbb',
      model: 'kimi-k2.7',
      modelDisplay: 'Kimi K2.7',
      status: 200,
      upstreamCode: null,
      ms: 120,
      queuedMs: 0,
      firstByteMs: 40,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      credits,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: null,
      ua: null,
      requestBody: null,
      responseBody: null,
    });
  };

  const latest = (): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;

  return { db, requests, catalog, log, controller, overview, insertSuccess, latest, count };
}

type Harness = ReturnType<typeof makeHarness>;

/** 通过 controller 打一次 /v1/chat/completions，返回写回客户端的 {status, headers, body}。 */
async function invoke(
  h: Harness,
  body: unknown,
  fetchImpl: () => Promise<unknown>,
): Promise<ReplyState> {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const { reply, state } = fakeReply();
  const req = {
    headers: { authorization: 'Bearer sk-waygate-aaaa', 'user-agent': 'claude-cli/1.0' },
    ip: '127.0.0.1',
    keyContext,
  } as RequestWithKeyContext;
  await h.controller.chatCompletions(req as never, reply, body as never);
  return state;
}

/** 上游响应桩。text 供 `!res.ok` 分支读体；body 供 200 分支判断是否为空。 */
function upstream(o: { status: number; text?: string; body?: unknown }): () => Promise<unknown> {
  return async () => ({
    ok: o.status >= 200 && o.status < 300,
    status: o.status,
    body: o.body ?? null,
    text: async () => o.text ?? '',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('失败请求必须落库 · AC-F01..F08', () => {
  it('AC-F01 上游不可达 → 落一行 502 / credits=null（未知）/ first_byte_ms IS NULL', async () => {
    const h = makeHarness();
    const state = await invoke(h, validBody(), () =>
      Promise.reject(new Error('ECONNREFUSED 127.0.0.1:443')),
    );

    expect(state.status).toBe(502);
    expect(h.count()).toBe(1);
    const row = h.latest()!;
    expect(row.status).toBe(502);
    // [v0.5.8] 上游不可达 ⇒ 是否计费**未知**：不写成 0（那是自标定），记 null + credits_unknown。
    expect(row.credits).toBeNull();
    expect(String(row.note)).toContain('credits_unknown');
    expect(row.first_byte_ms).toBeNull();
    expect(String(row.note)).toContain('upstream unreachable');
    // 落库行的 trace_id 必须等于客户端可见的 x-trace-id，用户才找得到这一行
    expect(row.trace_id).toBe(state.headers['x-trace-id']);
  });

  it('AC-F02 上游 401（凭证失效）→ 落一行，note 标明 upstream_credential_invalid', async () => {
    const h = makeHarness();
    const state = await invoke(h, validBody(), upstream({ status: 401, text: '{"message":"unauthorized"}' }));

    // §2/§3：status = 「返回给客户端的」状态（上游 401 按契约映射成 502，绝不原样 401）
    expect(state.status).toBe(502);
    expect(h.count()).toBe(1);
    const row = h.latest()!;
    expect(row.status).toBe(502);
    expect(String(row.note)).toContain('upstream_credential_invalid');
    // [v0.5.8] 上游路径失败 ⇒ 费用未知（null），不是 0。
    expect(row.credits).toBeNull();
  });

  it('AC-F03 body 形状不合法（assertBodyShape）→ 落一行 400', async () => {
    const h = makeHarness();
    const state = await invoke(h, { model: 'kimi-k2.7' }, () =>
      Promise.reject(new Error('不应打到上游')),
    );

    expect(state.status).toBe(400);
    expect(h.count()).toBe(1);
    const row = h.latest()!;
    expect(row.status).toBe(400);
    expect(String(row.note)).toContain('bad request body');
    expect(row.credits).toBe(0);
    expect(row.model).toBe(''); // 解析之前失败 → 模型留空，不编造
  });

  it('AC-F04 模型越权（已下架）→ 落一行 403，且带上已解析的模型', async () => {
    const h = makeHarness();
    const state = await invoke(
      h,
      { model: 'retired-model', messages: [{ role: 'user', content: 'hi' }] },
      () => Promise.reject(new Error('不应打到上游')),
    );

    expect(state.status).toBe(403);
    expect(h.count()).toBe(1);
    const row = h.latest()!;
    expect(row.status).toBe(403);
    expect(row.model).toBe('retired-model');
    expect(String(row.note)).toContain('model not permitted');
  });

  it('AC-F05 失败行的 client_id / key_id 与同请求成功行一致（来自 keyContext，非空）', async () => {
    const h = makeHarness();
    h.insertSuccess();
    const success = h.latest()!;
    await invoke(h, validBody(), () => Promise.reject(new Error('x')));

    expect(h.count()).toBe(2); // 证伪项：失败行必须真的落库（否则下面会拿成功行冒充）
    const failure = h.latest()!;
    expect(failure.status).toBe(502); // 确认取到的是失败行
    expect(failure.client_id).toBe(success.client_id);
    expect(failure.key_id).toBe(success.key_id);
    expect(failure.client_id).toBe(KEY_ID);
    expect(failure.key_id).toBe(KEY_ID);
  });

  it('AC-F06 成功率不再恒 ~100%：3 成功 + 1 失败 → 0.75', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) h.insertSuccess();
    await invoke(h, validBody(), () => Promise.reject(new Error('x')));

    const ov = h.overview.build(resolveWindow('24h'));
    expect(ov.metrics.requests).toBe(4);
    expect(ov.metrics.successRate).toBe(0.75);
  });

  it('AC-F07 失败行 credits=null（未知），不破坏 overview 的积分一致性（creditsUsed = ΣbyModel = ΣbyClient）', async () => {
    const h = makeHarness();
    h.insertSuccess(2);
    h.insertSuccess(3);
    await invoke(h, validBody(), () => Promise.reject(new Error('x')));

    const ov = h.overview.build(resolveWindow('24h'));
    const sumModel = ov.byModel.reduce((s, m) => s + (m.credits ?? 0), 0);
    const sumClient = ov.byClient.reduce((s, c) => s + (c.credits ?? 0), 0);

    expect(ov.metrics.requests).toBe(3); // 证伪项：失败行必须真的进了库
    /* [v0.5.8] 上游路径失败 ⇒ 费用**未知**（null），不再写 0。
       未知行对**合计**的贡献是 0（SUM 语义），所以一致性断言不变。 */
    expect(h.latest()!.credits).toBeNull();
    expect(ov.metrics.creditsUnknownCount).toBe(1); // 必须如实报出「有 1 条没算进合计」
    expect(ov.metrics.creditsUsed).toBe(5);
    expect(sumModel).toBe(5);
    expect(sumClient).toBe(5);
  });

  it('AC-F08 落库失败（磁盘满）只 warn，不改变返回给客户端的状态码', async () => {
    const h = makeHarness();
    const warn = vi.spyOn(h.log, 'warn');
    const boom = vi.spyOn(h.requests, 'log').mockImplementation(() => {
      throw new Error('database or disk is full');
    });

    const state = await invoke(h, validBody(), () => Promise.reject(new Error('x')));

    expect(state.status).toBe(502); // 状态码不受落库失败影响
    expect(boom).toHaveBeenCalled(); // 确实尝试过落库
    expect(warn).toHaveBeenCalled(); // 且降级为 warn（不抛、不改时序）
  });
});
