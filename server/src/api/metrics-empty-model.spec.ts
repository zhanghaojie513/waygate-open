/**
 * [2026-10-18] `model = ''` 的本地拒绝行（并发闸 429）在各视图里的口径必须一致。
 *
 * ## 缺陷背景
 * 请求在**模型解析之前**被并发闸挡下时，`requests.model` 落空串。实测生产库 36 行，
 * 全部是 `429 concurrency limit`。主聚合查询加了 `AND model <> ''` 排除它们，
 * 但代码注释写的是「metrics.requests 仍计入（被拒也是一次请求），仅摘要剔除」——
 * **实现与注释相反**：totals 是从已过滤的 groups 累加的，所以 metrics.requests 也排除了。
 *
 * 与此同时 trend / byTool / /api/clients 三条查询**没有**这个过滤，于是同窗口下：
 *   · `Σtrend.requests > metrics.requests`
 *   · `ΣbyTool.requests > metrics.requests`
 *   · byProvider（overview）与 byProvider（/api/clients）不相等
 *
 * ## 正确口径（本次钉死）
 * 「被拒也是一次请求」—— 计数类指标（requests / errors / successRate）必须包含它们，
 * 否则成功率虚高、且用户对不上「日志里有多少条」。但**摘要按模型/提供商拆分时排除**
 * （空 model 不属于任何模型，进 byModel 只会多一行「未知模型」0 token）。
 *
 * 即：`metrics.requests` = 窗口全部行；`ΣbyModel.requests` = 排除空 model 后；
 * 两者**本来就不该相等**，差值 = 空 model 行数（暴露为 `requestsWithoutModel`）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './client-harness';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.db.close();
});

function addProvider(id: string, name: string, models: string[]): void {
  h.providers.create({ id, name, baseUrl: `https://${id}.example.com`, active: true });
  h.catalog.seed(id, models.map((m) => ({ id: m, displayName: m, tag: null, multiplier: 1 })));
}

describe("model='' 行（本地 429 拒绝）的口径", () => {
  it('★ metrics.requests / errors / successRate 必须计入这些行', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0001');
    // 两条正常 + 一条模型解析前被拒（model=''，status=429）
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0001', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0001', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0001', model: '', credits: 0, status: 429 });

    const ov = h.overview.build(h.spec);

    expect(ov.metrics.requests).toBe(3); // ★ 被拒也是一次请求
    expect(ov.metrics.errors).toBe(1);
    expect(ov.metrics.successRate).toBe(0.667); // 2/3，不是 2/2=1
    expect(ov.metrics.requestsWithoutModel).toBe(1); // 差值可查
  });

  it('★ 摘要（byModel/byClient/byProvider）排除空 model，合计=metrics 减去空 model 行', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0002');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0002', model: 'a-model', credits: 2 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0002', model: '', credits: 0, status: 429 });

    const ov = h.overview.build(h.spec);

    expect(ov.byModel.reduce((s, m) => s + m.requests, 0)).toBe(1); // 只有 a-model
    expect(ov.byModel.find((m) => m.model === '')).toBeUndefined(); // 不出现「未知模型」行
    expect(ov.metrics.creditsUsed).toBe(2); // 拒绝行 credits=0，不影响积分
  });

  it('★ 三条查询同集合：Σtrend.requests 与 metrics 口径一致（含或不含空 model 都要统一）', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0003');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0003', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0003', model: '', credits: 0, status: 429 });

    const ov = h.overview.build(h.spec);
    const sumTrend = ov.trend.reduce((s, t) => s + t.requests, 0);

    /* 趋势图是「请求量随时间」，与 metrics.requests 同源同集合 —— 含 429。
       （另有一条独立缺陷：24h 窗口的首个残桶被丢，见 trends-bucket.spec.ts；
       这里用 today 窗口且数据落在当前小时，不受它影响。） */
    expect(sumTrend).toBe(ov.metrics.requests);
  });

  it('★ byTool 与 metrics 同集合（工具维度也是「谁发的」，含被拒请求）', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0004');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0004', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0004', model: '', credits: 0, status: 429 });

    const ov = h.overview.build(h.spec);
    const sumTool = ov.byTool.reduce((s, t) => s + t.requests, 0);

    expect(sumTool).toBe(ov.metrics.requests);
  });

  it('★ /api/clients 的 byProvider 与 overview.byProvider 同口径（都排除空 model）', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0005');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0005', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0005', model: '', credits: 0, status: 429 });

    const ov = h.overview.build(h.spec);
    const cl = h.clients.list(h.spec);

    const ovTotal = ov.byProvider.reduce((s, p) => s + p.requests, 0);
    const clTotal = cl.byProvider.reduce((s, p) => s + p.requests, 0);
    expect(clTotal).toBe(ovTotal); // 两个「提供商」视图必须同数
    expect(ovTotal).toBe(1); // 空 model 那行不进任何提供商
  });

  it('★ /api/clients 的 items 仍包含被拒请求（「这个客户端打了多少次」含失败）', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-empty…0006');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0006', model: 'a-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-empty…0006', model: '', credits: 0, status: 429 });

    const cl = h.clients.list(h.spec);
    const row = cl.items.find((i) => i.clientId === 'k1')!;
    expect(row.requests).toBe(2); // 含 429
  });
});

/**
 * [v1.6.31] 趋势必须覆盖整个窗口 —— 这是「卡片与柱子对得上账」的结构性保证。
 *
 * 旧实现从末尾往前数固定格数（24h = 24 格），而窗口起点不对齐整点，
 * 于是首桶被整桶丢弃。测试此前没抓到，是因为数据全写在 `Date.now()`（落末桶）。
 * 这里**故意把数据放在窗口起点的那个残桶里**（now-24h 之后、首桶结束之前），
 * 旧实现下它会从图上消失。
 */
describe('trend 覆盖整个窗口', () => {
  it('★ 落在窗口起点残桶里的请求，必须出现在 trend 上', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k_edge', 'C', 'sk-waygate-edge…0007');

    /* 不用 harness 的默认 ts（= now），而是直接写一行在「窗口起点 + 1 分钟」。
       这个时刻在 [from, 首桶结束) 区间内 —— 正是旧实现丢掉的那一段。 */
    const from = Date.now() - 24 * 3600 * 1000;
    h.requestsRepo.log({
      ts: from + 60_000,
      traceId: 't-edge',
      clientId: 'k_edge',
      client: 'C',
      clientRule: 2,
      keyId: 'k_edge',
      keyHint: 'sk-waygate-edge…0007',
      model: 'a-model',
      modelDisplay: null,
      status: 200,
      upstreamCode: null,
      ms: 10,
      queuedMs: 0,
      firstByteMs: 5,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cachedTokens: 0,
      credits: 1,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: null,
      ua: null,
      requestBody: null,
      responseBody: null,
      providerId: 'p_a',
    } as never);

    const ov = h.overview.build(h.spec);
    const sumTrend = ov.trend.reduce((s, t) => s + t.requests, 0);

    expect(ov.metrics.requests).toBe(1);
    expect(sumTrend).toBe(1); // ★ 旧实现这里会是 0
  });
});
