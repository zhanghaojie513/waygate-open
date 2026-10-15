/**
 * OverviewService 单测（task#20）：
 *   ① `byModel` 每行带 `multiplier`（`null` = 倍率未知，该行 `credits` 是 1.0 估算）——
 *      让前端能在「按模型消耗明细」里标注哪一行是估的，而不是把估算当真实数字展示；
 *   ② 守住契约最硬的一条（免费回归网）：
 *      `creditsUsed === ΣbyModel === ΣbyClient`（同源同区间，LIMIT 20 内应完全相等）。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_MODEL_SLICE, OverviewService } from './overview.service';
import { QuotaSourceService } from '../proxy/quota/quota-source.service';
import { resolveWindow } from './window';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');

let db: Database.Database;
let catalog: ModelCatalogRepository;
let providers: ProvidersRepository;
let requests: RequestsRepository;
let service: OverviewService;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
  catalog = new ModelCatalogRepository(db);
  providers = new ProvidersRepository(db);
  providers.create({ id: 'p_test', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  service = new OverviewService(db, {
    block: () => ({ available: false, reason: 'pending', remain: null, total: null, resetAt: null, stale: false, low: false, message: '（测试桩）' }),
    snapshot: () => ({ ledger: [], fetchedAt: null }),
  } as unknown as QuotaSourceService, { allBlocks: () => [] } as unknown as import('../proxy/anthropic-upstream/minimax-credit.service').MinimaxCreditService, catalog, providers, undefined);
});

afterEach(() => db.close());

/** 造一行成功请求。 */
function seedReq(
  model: string,
  credits: number,
  clientId = 'k1',
  status = 200,
  ts = Date.now(),
  ua: string | null = null,
  totalTokens = 2,
  ms = 1,
  firstByteMs = 1,
): void {
  requests.log({
    ts,
    traceId: `t-${Math.random().toString(36).slice(2)}`,
    clientId,
    client: 'C',
    clientRule: 2,
    keyId: null,
    keyHint: null,
    model,
    modelDisplay: null,
    status,
    upstreamCode: null,
    ms,
    queuedMs: 0,
    firstByteMs,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens,
    cachedTokens: 0,
    credits,
    stream: true,
    retryCount: 0,
    note: '',
    remoteIp: null,
    ua,
    requestBody: null,
    responseBody: null,
  });
}

function sumCredits(rows: Array<{ credits: number | null }>): number {
  /* [v0.6.4] credits 可空（窗口内全未回报时为 null）—— 未知按 0 计入合计，
     与后端 modelSum / metrics.creditsUsed 口径一致。 */
  return Math.round(rows.reduce((s, r) => s + (r.credits ?? 0), 0) * 100) / 100;
}

describe('OverviewService.byModel × 倍率可追溯', () => {
  it('★ 每行带 multiplier：已知倍率为数字，倍率未知为 null', () => {
    catalog.seed('p_test', [{ id: 'known', displayName: 'Known', tag: null, multiplier: 2 }]);
    // mergeSync 支持 multiplier=null（上游模型无倍率的真实形态）
    catalog.mergeSync('p_test', [{ id: 'unknown', displayName: 'Unknown', source: 'upstream', multiplier: null, tag: null }]);

    seedReq('known', 20);
    seedReq('unknown', 15);

    const p = service.build(resolveWindow('24h'));
    const known = p.byModel.find((m) => m.model === 'known');
    const unknown = p.byModel.find((m) => m.model === 'unknown');

    // 每行都必须带 multiplier 键 —— 前端据此决定是否渲染「倍率未知」
    expect(p.byModel.every((m) => 'multiplier' in m)).toBe(true);
    expect(known?.multiplier).toBe(2);
    expect(unknown?.multiplier).toBeNull();
  });

  it('目录里没有该模型 → byModel.multiplier 也是 null（未知，不编造）', () => {
    seedReq('never-seen', 7);

    const p = service.build(resolveWindow('24h'));

    expect(p.byModel.find((m) => m.model === 'never-seen')?.multiplier).toBeNull();
  });

  it('★ 口径不破：creditsUsed === ΣbyModel === ΣbyClient', () => {
    catalog.seed('p_test', [{ id: 'known', displayName: 'Known', tag: null, multiplier: 2 }]);
    catalog.mergeSync('p_test', [{ id: 'unknown', displayName: 'Unknown', source: 'upstream', multiplier: null, tag: null }]);
    seedReq('known', 20, 'k1');
    seedReq('unknown', 15, 'k2');
    seedReq('known', 5, 'k1');

    const p = service.build(resolveWindow('24h'));

    expect(sumCredits(p.byModel)).toBe(p.metrics.creditsUsed);
    expect(sumCredits(p.byClient)).toBe(p.metrics.creditsUsed);
    expect(p.metrics.creditsUsed).toBe(40); // 20 + 15 + 5
  });
});

/**
 * ★★ 2026-10-11 线上两个真实缺陷的回归网 ★★
 *
 * ① **目录 JOIN 行放大**：`model_catalog` 主键 `(provider_id, id)`，同一 model id 可同时
 *    存在于多家 active 提供商的清单里。旧写法 `JOIN ... ON mc.id = r.model` 会让一行请求
 *    配出多行 → COUNT/SUM 成倍放大 → 「模型用量摘要」占比 195%（告警日志实测
 *    `creditsUsed=41.22 / byModel=81.4`）。
 * ② **byClient 漏了 tokens**：契约 §3.4 要求该字段（v0.5.2 起），但 SQL 里没有
 *    `SUM(total_tokens)` → 接口回 `undefined` → 前端整列显示 0。
 */
describe('OverviewService × 聚合不放大 / 客户端带 tokens', () => {
  /** 再建一家 active 提供商，并把同一个 model id 也写进它的目录（线上真实形态）。 */
  function addSecondProviderWithSameModel(id: string): void {
    const providers = new ProvidersRepository(db);
    providers.create({ id: 'p_second', name: 'SecondUpstream', baseUrl: 'https://up2.example.com', active: true });
    catalog.seed('p_second', [{ id, displayName: 'Second Listing', tag: null, multiplier: 3 }]);
  }

  it('★ 同一 model id 落在两家 active 提供商 → requests/credits/tokens 都不翻倍', () => {
    catalog.seed('p_test', [{ id: 'MiniMax-M3.1-Flash-Preview', displayName: 'M3.1', tag: null, multiplier: null }]);
    addSecondProviderWithSameModel('MiniMax-M3.1-Flash-Preview');

    seedReq('MiniMax-M3.1-Flash-Preview', 40.18, 'k1');
    seedReq('MiniMax-M3.1-Flash-Preview', 0.5, 'k1');

    const p = service.build(resolveWindow('24h'));
    const row = p.byModel.find((m) => m.model === 'MiniMax-M3.1-Flash-Preview')!;

    expect(row.requests).toBe(2); // ← 旧实现是 4（每条请求被目录行数放大）
    expect(row.credits).toBe(40.68); // ← 旧实现是 81.36
    expect(row.tokens).toBe(4); // 每行 totalTokens=2，2 行
    db.close();
  });

  /**
   * ★ 占比不可能超过 100%（放大被修掉的直接体现）
    catalog.seed('p_test', [{ id: 'MiniMax-M3.1-Flash-Preview', displayName: 'M3.1', tag: null, multiplier: null }]);
    addSecondProviderWithSameModel('MiniMax-M3.1-Flash-Preview');
    seedReq('MiniMax-M3.1-Flash-Preview', 40.18, 'k1');

    const p = service.build(resolveWindow('24h'));

    // 旧实现这里 share=2（200%）：单模型积分被翻倍，而 totals 没翻。
    for (const m of p.byModel) expect(m.share).toBeLessThanOrEqual(1);
    expect(p.byModel[0].share).toBe(1);
    db.close();
  });

  /**
   * ★ 占比口径回归（2026-10-11 用户报障）。
   *
   * 症状：用量页/概览页的模型与客户端表都**按 tokens 排序**，占比却按**积分**算 ——
   * 表格自上而下百分比不再单调、条形长度与排序顺序互相矛盾（上面一行反而更短）。
   * 修法：`share` 统一为 token 占比。本用例用「两种口径结论相反」的数据钉住它：
   * a 积分高但 token 少、b 反之 —— 若有人把口径改回积分，这两条断言会立刻反过来失败。
   */
  it('★ 占比按 tokens 算（不是积分）：两种口径结论相反时跟随 token', () => {
    seedReq('a', 100, 'k1', 200, Date.now(), null, 10); // 积分 100，tokens 10
    seedReq('b', 1, 'k2', 200, Date.now(), null, 990); // 积分 1，tokens 990

    const p = service.build(resolveWindow('24h'));
    const a = p.byModel.find((m) => m.model === 'a')!;
    const b = p.byModel.find((m) => m.model === 'b')!;

    expect(a.share).toBe(0.01); // 10 / 1000 —— 按积分算会是 0.99
    expect(b.share).toBe(0.99); // 990 / 1000 —— 按积分算会是 0.01
    expect(a.share + b.share).toBe(1);
    // byClient / byTool 同口径（同一份请求的另外两种切法）
    expect(p.byClient.find((c) => c.clientId === 'k1')?.share).toBe(0.01);
    expect(p.byTool.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 2);
    db.close();
  });

  it('★ 口径在放大场景下依然不破（三路相等）', () => {
    catalog.seed('p_test', [{ id: 'dup', displayName: 'Dup', tag: null, multiplier: null }]);
    addSecondProviderWithSameModel('dup');
    seedReq('dup', 40.18, 'k1');
    seedReq('other', 1.02, 'k2');

    const p = service.build(resolveWindow('24h'));

    expect(sumCredits(p.byModel)).toBe(p.metrics.creditsUsed);
    expect(sumCredits(p.byClient)).toBe(p.metrics.creditsUsed);
    expect(p.metrics.creditsUsed).toBe(41.2);
    db.close();
  });

  it('★ byClient 带 tokens（= 窗口内 SUM(total_tokens)），不是 undefined', () => {
    seedReq('m', 1, 'k1');
    seedReq('m', 1, 'k1');
    seedReq('m', 1, 'k2');

    const p = service.build(resolveWindow('24h'));

    // seedReq 每行 totalTokens = 2
    expect(p.byClient.find((c) => c.clientId === 'k1')?.tokens).toBe(4);
    expect(p.byClient.find((c) => c.clientId === 'k2')?.tokens).toBe(2);
    expect(p.byClient.every((c) => typeof c.tokens === 'number')).toBe(true);
    db.close();
  });

  /**
   * ★ byClient 的**按模型切片**（2026-10-11 用户要求：两页「按客户端」模块的悬停提示
   * 要回答「这个客户端的量花在哪些模型上」）。
   *
   * 钉三件事：① 按 tokens 降序；② Σ切片 tokens === 该客户端 tokens（提示不能比它自己还多）；
   * ③ 超过 CLIENT_MODEL_SLICE 时截断，但 `modelCount` 如实给出真实模型数。
   */
  it('★ byClient[].models 按模型切片：降序、求和等于客户端合计', () => {
    seedReq('mA', 1, 'k1', 200, Date.now(), null, 100);
    seedReq('mB', 1, 'k1', 200, Date.now(), null, 300);
    seedReq('mC', 1, 'k1', 200, Date.now(), null, 200);

    const p = service.build(resolveWindow('24h'));
    const c = p.byClient.find((x) => x.clientId === 'k1')!;

    expect(c.tokens).toBe(600);
    expect(c.models.map((m) => m.model)).toEqual(['mB', 'mC', 'mA']); // 按 tokens 降序
    expect(c.models.reduce((s, m) => s + m.tokens, 0)).toBe(600); // Σ 切片 = 客户端合计
    expect(c.modelCount).toBe(3);
    db.close();
  });

  it('★ 模型数超过切片上限时截断，且 modelCount 如实给真实数量', () => {
    for (let i = 0; i < CLIENT_MODEL_SLICE + 3; i += 1) {
      seedReq(`m${i}`, 1, 'k1', 200, Date.now(), null, 10);
    }

    const p = service.build(resolveWindow('24h'));
    const c = p.byClient.find((x) => x.clientId === 'k1')!;

    expect(c.models).toHaveLength(CLIENT_MODEL_SLICE); // 只给前 5
    expect(c.modelCount).toBe(CLIENT_MODEL_SLICE + 3); // 但真实数如实
    db.close();
  });
});

/**
 * [v0.5.15] byClient 归属口径：模型 id → 目录 provider（与请求日志「提供商」同源）。
 * 直接动因：双绑定密钥（wb：WorkBuddy + MiniMax Code）的全部流量此前都记在
 * 第一个绑定下；E2E 清理删掉 mini 密钥唯一探测行后，摘要里 MiniMax Code 整条消失。
 */
describe('OverviewService.byClient × 客户端归属（v0.5.15）', () => {
  it('★ 目录内模型归 provider 桶，目录外模型回落密钥归属 —— 双绑定密钥的流量由此分开', () => {
    catalog.seed('p_test', [{ id: 'MiniMax-M3', displayName: 'M3', tag: null, multiplier: 1 }]);
    // 同一把密钥（k_wb）上的两类流量：一个模型在目录里，一个不在
    seedReq('MiniMax-M3', 10, 'k_wb');
    seedReq('MiniMax-M3', 10, 'k_wb');
    seedReq('glm-not-in-catalog', 4, 'k_wb');

    const p = service.build(resolveWindow('24h'));

    const mm = p.byClient.find((c) => c.clientId === 'TestUpstream');
    expect(mm?.client).toBe('TestUpstream');
    expect(mm?.requests).toBe(2);
    expect(mm?.credits).toBe(20);

    const fallback = p.byClient.find((c) => c.clientId === 'k_wb');
    expect(fallback?.requests).toBe(1);
    expect(fallback?.credits).toBe(4);

    expect(sumCredits(p.byClient)).toBe(p.metrics.creditsUsed);
  });

  it('★ 同一 model id 在两家 active 提供商 → 归并进一个桶（先到先得），不放大不分裂', () => {
    catalog.seed('p_test', [{ id: 'dup', displayName: 'Dup', tag: null, multiplier: 1 }]);
    providers.create({ id: 'p_second', name: 'SecondUpstream', baseUrl: 'https://up2.example.com', active: true });
    catalog.seed('p_second', [{ id: 'dup', displayName: 'Dup2', tag: null, multiplier: 1 }]);

    seedReq('dup', 5, 'k1');
    seedReq('dup', 5, 'k1');

    const p = service.build(resolveWindow('24h'));

    expect(p.byClient).toHaveLength(1);
    expect(p.byClient[0].requests).toBe(2); // 旧式 JOIN 会翻倍到 4
    expect(p.byClient[0].credits).toBe(10);
  });
});

/**
 * [v0.5.11] 趋势图的量纲从积分换成 token —— `trend[].tokens` 与每桶的按模型切片。
 * 钉三件事：① Σtrend.tokens === metrics.totalTokens（同源同窗口，图才不说谎）；
 * ② 每桶 models 按 token 降序、最多 5 条（tooltip 的排序契约）；
 * ③ 切片只允许截断（Σ ≤ 桶总额），超出即编数。
 */
describe('OverviewService.trend × token 量纲与按模型切片', () => {
  /** 造一行带指定 tokens 的请求（落在「现在」这个桶里）。 */
  function seedTok(model: string, totalTokens: number): void {
    requests.log({
      ts: Date.now(),
      traceId: `t-${Math.random().toString(36).slice(2)}`,
      clientId: 'k1',
      client: 'C',
      clientRule: 2,
      keyId: null,
      keyHint: null,
      model,
      modelDisplay: null,
      status: 200,
      upstreamCode: null,
      ms: 1,
      queuedMs: 0,
      firstByteMs: 1,
      promptTokens: Math.floor(totalTokens / 2),
      completionTokens: totalTokens - Math.floor(totalTokens / 2),
      totalTokens,
      cachedTokens: 0,
      credits: 1,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: null,
      ua: null,
      requestBody: null,
      responseBody: null,
    });
  }

  it('★ Σtrend.tokens === metrics.totalTokens（同一份 requests 的两种切法）', () => {
    seedTok('a', 300);
    seedTok('b', 120);
    seedTok('a', 80);

    const p = service.build(resolveWindow('24h'));
    const sumTrend = p.trend.reduce((s, t) => s + t.tokens, 0);

    expect(sumTrend).toBe(p.metrics.totalTokens);
    expect(sumTrend).toBe(500);
  });

  it('★ 每桶 models 按 token 降序、最多 5 条、Σ 不超过桶总额（截断只许少）', () => {
    for (let i = 0; i < 7; i++) seedTok(`model-${i}`, 100 + i); // 7 个模型 → top-5 截断
    seedTok('model-3', 500); // model-3 总量最大，必须排第一

    const p = service.build(resolveWindow('24h'));
    const bucket = p.trend[p.trend.length - 1]; // 当前小时桶

    expect(bucket.models.length).toBeLessThanOrEqual(5);
    const tokensList = bucket.models.map((m) => m.tokens);
    expect([...tokensList].sort((a, b) => b - a)).toEqual(tokensList); // 降序
    expect(bucket.models[0].model).toBe('model-3');
    expect(bucket.models[0].tokens).toBe(603); // 103（循环里那次）+ 500
    expect(bucket.models.reduce((s, m) => s + m.tokens, 0)).toBeLessThanOrEqual(bucket.tokens);
  });

  it('趋势口径保留：credits / requests / errors 仍在（切量纲不删旧字段）', () => {
    seedTok('a', 100);

    const p = service.build(resolveWindow('24h'));

    expect(p.trend.every((t) => typeof t.credits === 'number' && typeof t.requests === 'number' && typeof t.errors === 'number')).toBe(true);
  });
});

/**
 * task#62：概览暴露 tokens 指标与缓存命中率（替换不可得的订阅积分）。
 */
describe('OverviewService.metrics × tokens 指标', () => {
  /** 造一行带指定 tokens 的请求。 */
  function seedTokens(prompt: number, completion: number, cached: number): void {
    requests.log({
      ts: Date.now(),
      traceId: `t-${Math.random().toString(36).slice(2)}`,
      clientId: 'k1',
      client: 'C',
      clientRule: 2,
      keyId: null,
      keyHint: null,
      model: 'm1',
      modelDisplay: null,
      status: 200,
      upstreamCode: null,
      ms: 1,
      queuedMs: 0,
      firstByteMs: 1,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      cachedTokens: cached,
      credits: 1,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: null,
      ua: null,
      requestBody: null,
      responseBody: null,
    });
  }

  it('窗口内 tokens 合计正确（prompt / completion / total / cached）', () => {
    seedTokens(100, 20, 7);
    seedTokens(50, 10, 3);

    const p = service.build(resolveWindow('24h'));

    expect(p.metrics.promptTokens).toBe(150);
    expect(p.metrics.completionTokens).toBe(30);
    expect(p.metrics.totalTokens).toBe(180);
    expect(p.metrics.cachedTokens).toBe(10);
  });

  it('★ 命中率 = cached / prompt（10 / 150 ≈ 0.0667）', () => {
    seedTokens(100, 0, 7);
    seedTokens(50, 0, 3);

    const p = service.build(resolveWindow('24h'));

    expect(p.metrics.cacheHitRate).toBeCloseTo(10 / 150, 4);
  });

  it('★ 无任何缓存命中 → 命中率 0（不是缺失、不是 NaN）', () => {
    seedTokens(100, 0, 0);

    const p = service.build(resolveWindow('24h'));

    expect(p.metrics.cacheHitRate).toBe(0);
    expect(Number.isNaN(p.metrics.cacheHitRate)).toBe(false);
  });

  it('窗口内无请求 → tokens 与命中率全 0（分母为 0 不炸）', () => {
    const p = service.build(resolveWindow('24h'));

    expect(p.metrics.promptTokens).toBe(0);
    expect(p.metrics.totalTokens).toBe(0);
    expect(p.metrics.cacheHitRate).toBe(0);
  });
});

/**
 * [2026-10-08] 「请求来自哪个工具」—— `byTool` / `unknownUas`。
 *
 * 这一组钉的是**四个容易静默错的地方**：
 *   ① 口径：`byTool` 必须和 `byModel`/`byClient` 一样遵守 Σ === creditsUsed
 *      （它是同一份 requests 的第三种切法，不是另一套数）；
 *   ② 同工具的多个 UA 版本必须**合并成一行**（按工具名再聚合一次）——
 *      漏了这步会让 Claude Code 出现好几行，占比全是错的；
 *   ③ 认不出来的 UA 必须进 `null` 桶，且原文出现在 `unknownUas` 里 ——
 *      没有原文，那一桶就是个死胡同（用户不知道该往关键词表加什么）；
 *   ④ 空 UA **不进** `unknownUas`（「没采到」≠「某个未知工具」）。
 */
describe('OverviewService.byTool × 请求来自哪个工具', () => {
  it('★ 口径不破：creditsUsed === ΣbyTool（与 byModel/byClient 同一条纪律）', () => {
    seedReq('known', 20, 'k1', 200, Date.now(), 'claude-cli/1.0');
    seedReq('known', 15, 'k1', 200, Date.now(), 'Cursor/0.42');
    seedReq('known', 5, 'k2', 200, Date.now(), 'python-requests/2.32');

    const p = service.build(resolveWindow('24h'));

    expect(sumCredits(p.byTool)).toBe(p.metrics.creditsUsed);
  });

  it('★ 工具的多个 UA 版本合并成一行（不是每个版本一行）', () => {
    seedReq('m', 10, 'k1', 200, Date.now(), 'claude-cli/1.0.60 (external, cli)');
    seedReq('m', 20, 'k1', 200, Date.now(), 'claude-cli/0.9.1');
    seedReq('m', 30, 'k1', 200, Date.now(), 'Cursor/0.42.3');

    const p = service.build(resolveWindow('24h'));

    const cc = p.byTool.filter((t) => t.tool === 'Claude Code');
    expect(cc).toHaveLength(1);
    expect(cc[0].requests).toBe(2);
    expect(cc[0].credits).toBe(30);
    expect(p.byTool.map((t) => t.tool)).toContain('Cursor');
  });

  it('★ 认不出来的 UA 进 null 桶，并且原文出现在 unknownUas 里', () => {
    seedReq('m', 10, 'k1', 200, Date.now(), 'WeirdClient/9.9');
    seedReq('m', 5, 'k1', 200, Date.now(), 'claude-cli/1.0');

    const p = service.build(resolveWindow('24h'));

    expect(p.byTool.find((t) => t.tool === null)?.requests).toBe(1);
    expect(p.unknownUas).toEqual([{ ua: 'WeirdClient/9.9', requests: 1 }]);
  });

  it('空 UA 不进 unknownUas（那是「没采到」，不是「某个未知工具」）', () => {
    seedReq('m', 10, 'k1', 200, Date.now(), null);
    seedReq('m', 10, 'k1', 200, Date.now(), '');

    const p = service.build(resolveWindow('24h'));

    // 两条都归进 null 桶（都认不出来）
    expect(p.byTool.find((t) => t.tool === null)?.requests).toBe(2);
    // 但原文列表为空 —— 不能让人以为漏配了一个关键词
    expect(p.unknownUas).toEqual([]);
  });

  it('byTool 与 byClient 是两个维度：同一把密钥的多种工具会分开', () => {
    // 同一个 client_id（同一把密钥），两个不同的工具
    seedReq('m', 10, 'k1', 200, Date.now(), 'claude-cli/1.0');
    seedReq('m', 20, 'k1', 200, Date.now(), 'Cursor/0.42');

    const p = service.build(resolveWindow('24h'));

    // 客户端维度：1 行（同一把密钥）
    expect(p.byClient).toHaveLength(1);
    // 工具维度：2 行（同一把钥匙被两个工具用了 —— 这正是要能看出来的情形）
    expect(p.byTool).toHaveLength(2);
  });
});
