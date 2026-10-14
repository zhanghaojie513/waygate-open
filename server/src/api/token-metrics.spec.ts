import { describe, expect, it } from 'vitest';
import { computeCacheHitRate } from './token-metrics';

/**
 * 缓存命中率口径（task#62）。
 *
 * team-lead 的硬要求：**命中率为 0 就是 0，绝不说「上游未提供」**。
 * 这些断言把「0 是真值、不是缺失」这件事钉在服务端 —— 前端只会拿到一个数字。
 */
describe('computeCacheHitRate · 命中率口径', () => {
  it('常规：cached/prompt 的比例，保留 4 位小数', () => {
    expect(computeCacheHitRate(7, 100)).toBe(0.07);
    expect(computeCacheHitRate(1, 3)).toBe(0.3333);
  });

  it('★ 命中 0 → 返回 0（真值，不是「无数据」）', () => {
    expect(computeCacheHitRate(0, 100)).toBe(0);
  });

  it('★ prompt 为 0（失败行 / 无 usage）→ 分母为 0，定义为 0，不是 NaN/Infinity', () => {
    const r = computeCacheHitRate(0, 0);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it('全部命中 → 1', () => {
    expect(computeCacheHitRate(100, 100)).toBe(1);
  });

  it('防御：cached > prompt 的脏数据被夹到 1（不让界面出现 >100%）', () => {
    expect(computeCacheHitRate(150, 100)).toBe(1);
  });

  it('负数 / 非有限值 → 0', () => {
    expect(computeCacheHitRate(-1, 100)).toBe(0);
    expect(computeCacheHitRate(NaN, 100)).toBe(0);
    expect(computeCacheHitRate(1, NaN)).toBe(0);
    expect(computeCacheHitRate(Infinity, 100)).toBe(0);
  });
});
