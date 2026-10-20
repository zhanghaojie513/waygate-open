/**
 * [v1.6.30] 提供商归属 = **实际路由结果**，不是事后按目录反解。
 *
 * ## 缺陷形态（本文件要钉住的）
 * 同一模型 id 同时存在于两家目录（生产真实存在：`MiniMax-M2.7` / `M3` /
 * `M3.1-Flash-Preview` 同时在「MiniMax Code」与「MiniMax Code2」）。
 *
 * 两条顺序规则不一致：
 *   · **路由** `resolveRoute`：密钥绑定的提供商优先 → 其余按创建序
 *   · **归属** 反解：纯按创建序（`listActive()` = ORDER BY created_at ASC）
 *
 * ⇒ 密钥绑定的是**晚创建**那家时：请求实际打到 B，统计记到 A。
 *
 * 修复后：落库时把真实路由结果写进 `requests.provider_id`，归属直接读它；
 * 只有迁移前的老行（该列为 NULL）才回落到目录反解。
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

/**
 * 两家提供同一模型 id（模拟 Code / Code2）。
 *
 * `create()` 用 `Date.now()` 作 created_at，同一毫秒内插入会并列 → 归属反解的
 * 「先到先得」就不确定了。这里显式把时间戳拉开，让**创建序**成为确定事实：
 *   p_early 更早（反解会选它），p_late 更晚（实际路由会选它，因为密钥绑定它）。
 */
function addSharedModelProviders(): void {
  h.providers.create({ id: 'p_early', name: 'MiniMax Code', baseUrl: 'https://a.example.com', active: true });
  h.catalog.seed('p_early', [{ id: 'MiniMax-M3', displayName: 'MiniMax-M3', tag: null, multiplier: 1 }]);
  h.providers.create({ id: 'p_late', name: 'MiniMax Code2', baseUrl: 'https://b.example.com', active: true });
  h.catalog.seed('p_late', [{ id: 'MiniMax-M3', displayName: 'MiniMax-M3', tag: null, multiplier: 1 }]);
  h.db.prepare('UPDATE providers SET created_at = ? WHERE id = ?').run(1_000_000, 'p_early');
  h.db.prepare('UPDATE providers SET created_at = ? WHERE id = ?').run(2_000_000, 'p_late');
}

describe('提供商归属 · 必须等于实际路由结果', () => {
  it('★ 同一模型在两家目录：归属到**实际承接**的那家，不是创建序最早的那家', () => {
    addSharedModelProviders();
    h.makeKey('k_bind_late', 'C', 'sk-waygate-bind…0001');

    /* 请求实际路由到了「晚创建」的 p_late（因为密钥绑定它，路由优先绑定）。
       落库时 provider_id 记的就是这个事实。 */
    h.log({
      clientId: 'k_bind_late',
      client: 'C',
      clientRule: 2,
      keyId: 'k_bind_late',
      keyHint: 'sk-waygate-bind…0001',
      model: 'MiniMax-M3',
      credits: 5,
      providerId: 'p_late',
    });

    const ov = h.overview.build(h.spec);
    const late = ov.byProvider.find((p) => p.providerId === 'p_late');
    const early = ov.byProvider.find((p) => p.providerId === 'p_early');

    expect(late?.requests).toBe(1); // ★ 归属到实际承接方
    expect(late?.credits).toBe(5);
    expect(early).toBeUndefined(); // 不能算到另一家头上（旧实现会算到 p_early）
  });

  it('★ /api/clients 的 byProvider 同一口径（两处不能各说各话）', () => {
    addSharedModelProviders();
    h.makeKey('k2', 'C', 'sk-waygate-bind…0002');
    h.log({
      clientId: 'k2', client: 'C', clientRule: 2, keyId: 'k2', keyHint: 'sk-waygate-bind…0002',
      model: 'MiniMax-M3', credits: 3, providerId: 'p_late',
    });

    const cl = h.clients.list(h.spec);
    expect(cl.byProvider.find((p) => p.providerId === 'p_late')?.requests).toBe(1);
    expect(cl.byProvider.find((p) => p.providerId === 'p_early')).toBeUndefined();
  });

  it('★ 老行（provider_id 为 NULL）仍按目录反解 —— 降级兜底不丢历史用量', () => {
    addSharedModelProviders();
    h.makeKey('k3', 'C', 'sk-waygate-bind…0003');
    // 迁移前的行：没有 provider_id
    h.log({
      clientId: 'k3', client: 'C', clientRule: 2, keyId: 'k3', keyHint: 'sk-waygate-bind…0003',
      model: 'MiniMax-M3', credits: 2, providerId: null,
    });

    const ov = h.overview.build(h.spec);
    /* 反解按创建序 → p_early。关键是「不丢」：老行仍有归属，只是归属是猜的。 */
    expect(ov.byProvider.find((p) => p.providerId === 'p_early')?.requests).toBe(1);
  });

  it('★ 同名模型分属两家时，两批请求各自归各自（互不串味）', () => {
    addSharedModelProviders();
    h.makeKey('k4', 'C', 'sk-waygate-bind…0004');
    h.log({ clientId: 'k4', client: 'C', clientRule: 2, keyId: 'k4', keyHint: 'sk-waygate-bind…0004', model: 'MiniMax-M3', credits: 1, providerId: 'p_early' });
    h.log({ clientId: 'k4', client: 'C', clientRule: 2, keyId: 'k4', keyHint: 'sk-waygate-bind…0004', model: 'MiniMax-M3', credits: 9, providerId: 'p_late' });

    const ov = h.overview.build(h.spec);
    expect(ov.byProvider.find((p) => p.providerId === 'p_early')?.credits).toBe(1);
    expect(ov.byProvider.find((p) => p.providerId === 'p_late')?.credits).toBe(9);
    // 合计仍等于 metrics（同源不变式）
    const sum = ov.byProvider.reduce((s, p) => s + (p.credits ?? 0), 0);
    expect(Math.round(sum * 100) / 100).toBe(ov.metrics.creditsUsed);
  });
});
