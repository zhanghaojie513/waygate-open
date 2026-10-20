/**
 * [2026-10-18] 「积分未知」在三个维度上的口径必须一致。
 *
 * ## 缺陷背景
 * 项目铁律：`credits = NULL` 表示**上游未回报该次费用（未知）**，界面显示 `--`；
 * `0` 是**事实上的零**（如本地拒绝、免费档实扣 0）。两者绝不能混。
 * 行级与 byModel 都遵守（`overview.service.ts` 用 `knownCount` 保住 null），
 * 但 byClient / byProvider 的 credits 初值是 `0`、且数据源在
 * `clientModelRows` 里就被 `creditsRaw ?? 0` 抹平了 —— 于是**同一份数据**：
 *   · 模型明细表里显示 `--`
 *   · 提供商摘要 / 用量页「按提供商消耗」里显示 `0.00`
 * 生产实证：`MiniMax-M3.1-Flash-Preview` 一批请求 21 条**全部未回报**，
 * 模型维度 `--`、提供商维度 `0.00`。
 *
 * ## 修法与不变式
 * 桶内若**全部**请求都未回报 → `credits = null`；只要有一条回报过 → 求和（未知按 0）。
 * 这与 byModel 的 `knownCount > 0 ? round2(sum ?? 0) : null` 完全同构。
 * 合计口径不变：`Σ(null 当 0) === metrics.creditsUsed`。
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

/** 造一家带目录的生效提供商。 */
function addProvider(id: string, name: string, models: string[]): void {
  h.providers.create({ id, name, baseUrl: `https://${id}.example.com`, active: true });
  h.catalog.seed(id, models.map((m) => ({ id: m, displayName: m, tag: null, multiplier: 1 })));
}

describe('credits 可空 · byClient / byProvider 不得把「未知」显示成 0', () => {
  it('★ 全未回报的提供商：byProvider.credits 必须是 null（不是 0）', () => {
    addProvider('p_mm', 'MiniMax Code', ['mm-model']);
    h.makeKey('k1', 'C', 'sk-waygate-null…0001');
    // 两条都未回报
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-null…0001', model: 'mm-model', credits: null });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-null…0001', model: 'mm-model', credits: null });

    const ov = h.overview.build(h.spec);
    const p = ov.byProvider.find((x) => x.providerId === 'p_mm');
    expect(p).toBeDefined();
    expect(p!.credits).toBeNull(); // ★ 未知，不是 0.00
    expect(ov.metrics.creditsUnknownCount).toBe(2); // 条数仍如实上报
  });

  it('★ 全未回报的客户端：byClient.credits 必须是 null', () => {
    addProvider('p_mm', 'MiniMax Code', ['mm-model']);
    h.makeKey('k1', 'C', 'sk-waygate-null…0002');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-null…0002', model: 'mm-model', credits: null });

    const ov = h.overview.build(h.spec);
    const c = ov.byClient.find((x) => x.requests > 0);
    expect(c!.credits).toBeNull();
  });

  it('★ 部分回报：按已知部分求和（未知当 0），不是 null', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    h.makeKey('k1', 'C', 'sk-waygate-mix…0003');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-mix…0003', model: 'a-model', credits: 2.5 });
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-mix…0003', model: 'a-model', credits: null });

    const ov = h.overview.build(h.spec);
    expect(ov.byProvider.find((x) => x.providerId === 'p_a')!.credits).toBe(2.5);
    expect(ov.byClient.find((x) => x.requests > 0)!.credits).toBe(2.5);
    expect(ov.metrics.creditsUsed).toBe(2.5);
  });

  it('★ 不变式不破：Σ(byClient.credits，null 当 0) === creditsUsed', () => {
    addProvider('p_a', 'Alpha', ['a-model']);
    addProvider('p_mm', 'MiniMax Code', ['mm-model']);
    h.makeKey('k1', 'C', 'sk-waygate-sum…0004');
    h.makeKey('k2', 'D', 'sk-waygate-sum…0005');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-sum…0004', model: 'a-model', credits: 3 });
    h.log({ clientId: 'k2', client: 'D', clientRule: 2, keyId: 'k2', keyHint: 'sk-waygate-sum…0005', model: 'mm-model', credits: null });

    const ov = h.overview.build(h.spec);
    const sum = ov.byClient.reduce((s, c) => s + (c.credits ?? 0), 0);
    expect(Math.round(sum * 100) / 100).toBe(ov.metrics.creditsUsed);
    expect(ov.metrics.creditsUsed).toBe(3); // 未知不贡献
  });

  it('★ 真正的 0（本地拒绝/免费档）仍是 0，不能被当成未知', () => {
    addProvider('p_q', 'Qoder CN', ['q-model']);
    h.makeKey('k1', 'C', 'sk-waygate-zero…0006');
    h.log({ clientId: 'k1', client: 'C', clientRule: 2, keyId: 'k1', keyHint: 'sk-waygate-zero…0006', model: 'q-model', credits: 0 });

    const ov = h.overview.build(h.spec);
    const p = ov.byProvider.find((x) => x.providerId === 'p_q')!;
    expect(p.credits).toBe(0); // 必须是 0，不是 null
    expect(p.credits).not.toBeNull();
  });
});
