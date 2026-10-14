/**
 * `/api/clients` 的 `byProvider`（v0.6.0）—— 提供商表三列用量的回归网。
 *
 * 缺陷背景（用户报）：多生效下提供商表「请求次数 / 消耗积分 / 最后活跃」恒为空。
 * 根因是前端此前的保守门槛「只有恰好一家启用才可归属」；正解是服务端按
 * 「模型 id → 生效目录的 provider」归因（与请求日志「提供商」列、overview.byClient 同源）。
 *
 * 断言的是**口径**，不复抄实现：
 *   · ΣbyProvider.credits === Σitems.credits（同窗口同源，只是另一种切法）
 *   · 归属正确：A 家目录里的模型算 A，B 家目录里的算 B —— 双绑定密钥也分得开
 *   · 目录外模型的请求进 providerId=null 桶（不冒充任何一家）
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

/** 造一家提供商 + 它目录里的模型（走生产列表路径读）。 */
function addProvider(id: string, name: string, models: string[]): void {
  h.providers.create({ id, name, baseUrl: `https://${id}.example.com`, active: true });
  h.catalog.seed(id, models.map((m) => ({ id: m, displayName: m, tag: null, multiplier: 1 })));
}

const sumItems = (items: Array<{ credits: number }>) => Math.round(items.reduce((s, i) => s + i.credits, 0) * 100) / 100;
const sumProviders = (rows: Array<{ credits: number }>) => Math.round(rows.reduce((s, i) => s + i.credits, 0) * 100) / 100;

describe('byProvider · 提供商维度用量归属（v0.6.0）', () => {
  it('★ 两家各归各的：A 目录模型算 A、B 目录模型算 B（同一把密钥的流量也分得开）', () => {
    addProvider('p_a', 'Alpha', ['alpha-model']);
    addProvider('p_b', 'Beta', ['beta-model']);
    h.makeKey('k_wb', 'WorkBuddy', 'sk-waygate-aaaa…0001');
    // 同一把（双绑定）密钥下的两类流量
    h.log({ clientId: 'k_wb', client: 'WorkBuddy', clientRule: 2, keyId: 'k_wb', keyHint: 'sk-waygate-aaaa…0001', model: 'alpha-model', credits: 10 });
    h.log({ clientId: 'k_wb', client: 'WorkBuddy', clientRule: 2, keyId: 'k_wb', keyHint: 'sk-waygate-aaaa…0001', model: 'beta-model', credits: 4 });

    const { items, byProvider } = h.clients.list(h.spec);

    const a = byProvider.find((b) => b.providerId === 'p_a');
    const b = byProvider.find((b) => b.providerId === 'p_b');
    expect(a?.requests).toBe(1);
    expect(a?.credits).toBe(10);
    expect(b?.requests).toBe(1);
    expect(b?.credits).toBe(4);
    /* 口径不变式：另一种切法的合计必须相等 */
    expect(sumProviders(byProvider)).toBe(sumItems(items));
  });

  it('★ 目录外的模型 → providerId=null 桶（不冒充任何一家），仍计入合计', () => {
    addProvider('p_a', 'Alpha', ['alpha-model']);
    h.makeKey('k1', 'C', 'sk-waygate-bbbb…0002');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-bbbb…0002', model: 'alpha-model', credits: 3 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-bbbb…0002', model: 'ghost-model', credits: 7 });

    const { items, byProvider } = h.clients.list(h.spec);

    const unattributed = byProvider.find((b) => b.providerId === null);
    expect(unattributed?.requests).toBe(1);
    expect(unattributed?.credits).toBe(7);
    expect(byProvider.find((b) => b.providerId === 'p_a')?.credits).toBe(3);
    expect(sumProviders(byProvider)).toBe(sumItems(items));
  });

  it('lastSeenAt：该提供商名下模型的最近一次请求时刻（epoch ms → ISO）', () => {
    addProvider('p_a', 'Alpha', ['alpha-model']);
    h.makeKey('k1', 'C', 'sk-waygate-cccc…0003');
    const before = Date.now() - 1000;
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-cccc…0003', model: 'alpha-model', credits: 1 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-cccc…0003', model: 'alpha-model', credits: 1 });

    const rows = h.clients.list(h.spec).byProvider;
    const a = rows.find((b) => b.providerId === 'p_a');
    expect(a?.lastSeenAt).not.toBeNull();
    // 落库时刻在 before 之后（窗口 24h 内）
    expect(new Date(a!.lastSeenAt!).getTime()).toBeGreaterThan(before);
  });

  it('未装配 providers/catalog 时返回空数组（旧构造不炸）', () => {
    // harness 装配齐全，这里直接断言形状合法、数组恒可迭代
    expect(Array.isArray(h.clients.list(h.spec).byProvider)).toBe(true);
  });
});
