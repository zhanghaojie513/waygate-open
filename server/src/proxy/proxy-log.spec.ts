/**
 * ProxyLogger 积分口径单测（v0.5.8「不做自标定」）：
 *
 * 铁律 —— 本项目是**反向代理**，一切以上游真实返回为准。
 *   · 上游 usage 回报了 `credit` → 原值落库，note 加 credits_from_upstream；
 *   · 上游没回报           → `credits = NULL`（**未知**）+ note credits_unknown，
 *                            绝不按 tokens/倍率估算，也不补 0。
 *
 * 旧版这里测的是本地兜底公式（computeCredits + cacheDiscount 折扣），公式已整段移除，
 * 相应断言改为「上游原值直采 / 缺失即 null」。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginContext, ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { RelayHttpError } from '../common/errors';
import type { RelayConfigService } from '../config/config.service';
import type { Accumulator } from './types';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');

let db: Database.Database;
let catalog: ModelCatalogRepository;
let providers: ProvidersRepository;
let log: ProxyLogger;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  catalog = new ModelCatalogRepository(db);
  providers = new ProvidersRepository(db);
  providers.create({ id: 'p_test', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog, providers);
});

afterEach(() => db.close());

/** 造一个最小 Accumulator（persist 只读 model 与 usage）。 */
function acc(model: string, prompt: number, completion: number): Accumulator {
  return {
    id: null,
    model,
    created: null,
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: 'stop',
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    chunkCount: 1,
    emptyChunkCount: 0,
  };
}

describe('persist × 上游未回报即未知（v0.5.8 口径铁律）', () => {
  /** 走一次真实 persist，返回落库行的 credits 与 note。 */
  async function persistAndRead(modelId: string, prompt: number, completion: number) {
    const ctx = beginContext({ keyContext: undefined, remoteIp: null, ua: null, originalStream: true });
    ctx.modelId = modelId;
    ctx.modelDisplay = modelId;
    await log.persist(ctx, {
      status: 200,
      upstreamCode: null,
      acc: acc(modelId, prompt, completion),
      firstByteMs: 5,
      note: '',
    });
    return db.prepare('SELECT credits, note FROM requests ORDER BY id DESC LIMIT 1').get() as {
      credits: number | null;
      note: string;
    };
  }

  it('★ 有 usage 但无 credit → credits = NULL（未知），note 含 credits_unknown，**不估算**', async () => {
    catalog.seed('p_test', [{ id: 'm1', displayName: 'M1', tag: null, multiplier: 1 }]);

    const row = await persistAndRead('m1', 10000, 0);

    expect(row.credits).toBeNull(); // ← 旧实现这里会是 2.8（本地公式估算）
    expect(row.note).toContain('credits_unknown');
    expect(row.note).not.toContain('credits_from_upstream');
  });

  it('倍率已知也无济于事 → 仍为 NULL（倍率不再参与积分，只描述模型属性）', async () => {
    catalog.seed('p_test', [{ id: 'm2', displayName: 'M2', tag: null, multiplier: 2 }]);

    const row = await persistAndRead('m2', 10000, 0);

    expect(row.credits).toBeNull();
    expect(row.note).toContain('credits_unknown');
  });

  it('目录里没有该模型 → 同样 NULL + credits_unknown（未知不编造）', async () => {
    const row = await persistAndRead('ghost', 4000, 0);

    expect(row.credits).toBeNull();
    expect(row.note).toContain('credits_unknown');
  });

  it('usage 缺失 → NULL + usage_missing（不补 0）', async () => {
    const ctx = beginContext({ keyContext: undefined, remoteIp: null, ua: null, originalStream: true });
    ctx.modelId = 'm1';
    ctx.modelDisplay = 'm1';
    const a = acc('m1', 0, 0);
    a.usage = undefined as never;
    await log.persist(ctx, { status: 200, upstreamCode: null, acc: a, firstByteMs: 5, note: '' });

    const row = db.prepare('SELECT credits, note FROM requests ORDER BY id DESC LIMIT 1').get() as {
      credits: number | null;
      note: string;
    };
    expect(row.credits).toBeNull();
    expect(row.note).toContain('usage_missing');
    expect(row.note).toContain('credits_unknown');
  });
});

/**
 * 落库幂等（task#37）：一次请求**恰好一行**，任何路径重复调用都被去重。
 *
 * 缺陷：生成器已成功落库后，若 `reply.send` 抛错冒泡到 controller catch，
 * `logRejection` 会**再落一行** → 同一请求两行 → 积分被重复计入用量统计。
 * 根因是"已落库"标记做成了局部变量/普通字段，跨 `{ ...ctx }` 浅拷贝共享不到。
 */
describe('persist 幂等 · 一次请求恰好一行', () => {
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;

  function ctxOf(modelId: string) {
    const ctx = beginContext({ keyContext: undefined, remoteIp: null, ua: null, originalStream: false });
    ctx.modelId = modelId;
    ctx.modelDisplay = modelId;
    return ctx;
  }

  function makeProxy(): ProxyService {
    const config = {
      get: () => ({
        limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
        upstream: { spoofUA: true, userAgent: 'relay-station/0.4.1', baseUrl: 'https://copilot.tencent.com' },
        logs: { recordRequestBody: false, recordResponseBody: false },
      }),
      upstreamKey: 'ck_test_0123456789abcdef',
    } as unknown as RelayConfigService;
    return new ProxyService(config, catalog, log);
  }

  it('★ 成功落库后再 persistFailure（浅拷贝 ctx）→ 仍只有一行', async () => {
    catalog.seed('p_test', [{ id: 'm1', displayName: 'M1', tag: null, multiplier: 1 }]);
    const ctx = ctxOf('m1');

    await log.persist(ctx, { status: 200, upstreamCode: null, acc: acc('m1', 10, 5), firstByteMs: 5, note: '' });
    expect(count()).toBe(1);

    // 模拟 fail()/logRejection() 的做法：浅拷贝 ctx（共享同一 persistGuard 引用）
    log.persistFailure(
      { ...ctx, traceId: 'late-trace' },
      { status: 500, upstreamCode: null, note: 'late' },
    );

    expect(count()).toBe(1); // ← 旧实现这里会是 2（重复计行 → 积分被重复计入）
  });

  it('★ 成功落库后再走 proxy.logRejection → 仍只有一行（跨模块幂等）', async () => {
    catalog.seed('p_test', [{ id: 'm1', displayName: 'M1', tag: null, multiplier: 1 }]);
    const proxy = makeProxy();
    const ctx = ctxOf('m1');

    await log.persist(ctx, { status: 200, upstreamCode: null, acc: acc('m1', 10, 5), firstByteMs: 5, note: '' });
    expect(count()).toBe(1);

    proxy.logRejection(
      ctx,
      new RelayHttpError({ httpStatus: 500, code: 'internal_error', message: 'reply.send 抛错' }),
    );

    expect(count()).toBe(1); // 跨模块（ProxyService → ProxyLogger）同样只落一行
  });
});

/**
 * ★★ 缓存命中落库（task#62 防陷阱回归）★★
 *
 * 陷阱：上游 usage 顶层 `cached_tokens` **恒 0 是假的**，真值在
 * `usage.prompt_tokens_details.cached_tokens`。若采集读错字段，命中率会**永为 0 却不报错**。
 * 这一组直接从 **数据库里回读落库值**，断言是 7 不是 0 —— 是对整条采集链路的端到端验证。
 */
describe('persist × 缓存命中 cached_tokens（task#62）', () => {
  /** 造一个 usage 带陷阱的 Accumulator。 */
  function accWithUsage(usage: Accumulator['usage']): Accumulator {
    return {
      id: null,
      model: 'm1',
      created: null,
      role: 'assistant',
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      finishReason: 'stop',
      usage,
      chunkCount: 1,
      emptyChunkCount: 0,
    };
  }

  async function persistUsage(usage: Accumulator['usage']) {
    catalog.seed('p_test', [{ id: 'm1', displayName: 'M1', tag: null, multiplier: 1 }]);
    const ctx = beginContext({ keyContext: undefined, remoteIp: null, ua: null, originalStream: true });
    ctx.modelId = 'm1';
    ctx.modelDisplay = 'M1';
    await log.persist(ctx, { status: 200, upstreamCode: null, acc: accWithUsage(usage), firstByteMs: 3, note: '' });
  }

  const lastRow = () =>
    db.prepare('SELECT prompt_tokens, cached_tokens FROM requests ORDER BY id DESC LIMIT 1').get() as {
      prompt_tokens: number;
      cached_tokens: number;
    };

  it('★★ 顶层 cached_tokens:0 + 嵌套 prompt_tokens_details.cached_tokens:7 → 落库 cached_tokens=7（不是 0）', async () => {
    await persistUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 0, // 假
      prompt_tokens_details: { cached_tokens: 7 }, // 真
    });
    const row = lastRow();
    expect(row.prompt_tokens).toBe(100);
    expect(row.cached_tokens).toBe(7); // ← 读错字段这里会是 0
  });

  it('回落：DeepSeek 系 prompt_cache_hit_tokens 也能采集到', async () => {
    await persistUsage({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_cache_hit_tokens: 12 });
    expect(lastRow().cached_tokens).toBe(12);
  });

  it('无缓存信息 → 落库 0（不估算）', async () => {
    await persistUsage({ prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 });
    expect(lastRow().cached_tokens).toBe(0);
  });

  it('聚合表同步累加 cached_tokens（hour/model 桶）', async () => {
    await persistUsage({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100, prompt_tokens_details: { cached_tokens: 7 } });
    await persistUsage({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100, prompt_tokens_details: { cached_tokens: 3 } });
    const agg = db
      .prepare("SELECT cached_tokens FROM aggregates WHERE dim = 'model' AND dim_value = 'm1'")
      .get() as { cached_tokens: number };
    expect(agg.cached_tokens).toBe(10); // 7 + 3
  });
});

/**
 * [2026-10-07 / v0.5.8] 上游实扣优先 —— 且是**唯一**来源：usage 里带 `credit` 字段
 * （真实账单，已含倍率与缓存折扣；校准锚点：2,604 无缓存 tokens → 0.08）。
 * persist 必须**原值直采**；该字段缺失时记 NULL（未知），不再有任何本地兜底公式。
 */
describe('persist × 上游实扣 credit（唯一来源）', () => {
  async function persistRow(usage: Record<string, unknown> | null, modelId = 'm2') {
    catalog.seed('p_test', [{ id: 'm2', displayName: 'M2', tag: null, multiplier: 2 }]);
    const ctx = beginContext({ keyContext: undefined, remoteIp: null, ua: null, originalStream: true });
    ctx.modelId = modelId;
    ctx.modelDisplay = modelId;
    const a = acc(modelId, 10000, 100);
    a.usage = (usage ?? undefined) as never;
    await log.persist(ctx, { status: 200, upstreamCode: null, acc: a, firstByteMs: 5, note: '' });
    return db.prepare('SELECT credits, note FROM requests ORDER BY id DESC LIMIT 1').get() as {
      credits: number | null;
      note: string;
    };
  }

  it('★ usage 带 credit → 原值直采（不乘倍率、不打折），note 含 credits_from_upstream', async () => {
    const row = await persistRow({ prompt_tokens: 10000, completion_tokens: 100, credit: 0.08 });
    expect(row.credits).toBe(0.08); // 上游原值
    expect(row.note).toContain('credits_from_upstream');
    expect(row.note).not.toContain('credits_unknown');
  });

  it('★ credit 缺失 → credits = NULL（未知），note 含 credits_unknown（旧实现会兜底算出 5.66）', async () => {
    const row = await persistRow({ prompt_tokens: 10000, completion_tokens: 100 });
    expect(row.credits).toBeNull();
    expect(row.note).toContain('credits_unknown');
    expect(row.note).not.toContain('credits_from_upstream');
  });

  it('credit=0 合法（免费模型）：采用 0，且**不**标 credits_unknown（0 是上游给的事实）', async () => {
    const row = await persistRow({ prompt_tokens: 10000, completion_tokens: 100, credit: 0 });
    expect(row.credits).toBe(0);
    expect(row.note).toContain('credits_from_upstream');
    expect(row.note).not.toContain('credits_unknown');
  });

  it('credit 非法（负数/字符串）→ 视为无此数据 → NULL + credits_unknown', async () => {
    const neg = await persistRow({ prompt_tokens: 10000, completion_tokens: 100, credit: -1 });
    expect(neg.credits).toBeNull();
    expect(neg.note).toContain('credits_unknown');
    const str = await persistRow({ prompt_tokens: 10000, completion_tokens: 100, credit: '0.08' });
    expect(str.credits).toBeNull();
    expect(str.note).not.toContain('credits_from_upstream');
  });

  it('usage 整体缺失（usage_missing）→ credits = NULL，不估算', async () => {
    const row = await persistRow(null);
    expect(row.credits).toBeNull();
    expect(row.note).toContain('usage_missing');
  });
});
