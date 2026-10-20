/**
 * `fillEmptyBuckets`（v0.6.6）—— 趋势图「只返回有请求的桶」的回归网。
 *
 * 缺陷背景（用户报）：选 24 小时窗口，x 轴柱数不是 24。
 * 根因：trend 的 SQL 是 `GROUP BY bucket`，**只返回有请求的桶**，没流量的小时直接缺失。
 * 图表的语义要求**等距时间轴**（每根柱 = 固定时长），故须补齐空桶。
 *
 * [v1.6.31] 柱数**不再是 24 / 7 / 30**：桶序列改为「从窗口起点向下对齐到桶边界，
 * 到当前桶为止」，这样图才能覆盖**整个窗口**（旧实现从末尾往前数固定格数，
 * 把窗口最老的残桶整桶丢了 —— 24h 实测最多丢 12% 的请求，见
 * `window.cover-window.spec.ts`）。所以 24h → 25 格、7d → 8 格、30d → 31 格。
 *
 * 断言的是**形状与对齐**（不复抄实现）：
 *   · 24h → 25 个连续整点桶、末尾是当前小时、首桶是窗口起点的整点；
 *   · 空桶补 0 且带正确 bucket 标签；有数据的桶原样保留；
 *   · today → 桶数 = 本地零点到当前小时（日历日语义，不受本次改动影响）；
 *   · day 桶 → 7d/30d 各 8 / 31 个连续日。
 */
import { describe, expect, it } from 'vitest';
import { fillEmptyBuckets, resolveWindow, windowRange } from './window';

type Row = { bucket: string; requests: number; credits: number; tokens: number; errors: number; models: never[] };
const empty = (bucket: string): Row => ({ bucket, requests: 0, credits: 0, tokens: 0, errors: 0, models: [] });

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('fillEmptyBuckets · 趋势图等距时间轴', () => {
  it('★ 24h：无数据时也补齐 25 个连续整点桶（覆盖整个窗口）', () => {
    const now = new Date('2026-10-12T15:30:00').getTime(); // 本地时间
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    /* 窗口 [11 日 15:30, 12 日 15:30]；向下对齐后 11 日 15:00 → 12 日 15:00 = 25 格。 */
    expect(out).toHaveLength(25);
    expect(out[0]!.bucket.endsWith('T15')).toBe(true);
    expect(out[0]!.bucket.startsWith('2026-10-11')).toBe(true);
    expect(out.every((r) => r.requests === 0)).toBe(true);
    // 连续整点：逐桶相差 1 小时
    for (let i = 1; i < out.length; i += 1) {
      const a = new Date(out[i - 1]!.bucket.replace('T', ' ') + ':00').getTime();
      const b = new Date(out[i]!.bucket.replace('T', ' ') + ':00').getTime();
      expect(b - a).toBe(HOUR);
    }
    // 末桶 = 当前小时（15 点）
    expect(out[out.length - 1]!.bucket.endsWith('T15')).toBe(true);
  });

  it('★ 有数据的桶原样保留、空桶补零，顺序按时间', () => {
    const now = new Date('2026-10-12T15:30:00').getTime();
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);
    const stamp = (h: number) => `2026-10-12T${String(h).padStart(2, '0')}`;
    const rows: Row[] = [{ bucket: stamp(13), requests: 7, credits: 3, tokens: 100, errors: 1, models: [] }];

    const out = fillEmptyBuckets(rows, spec, from, to, empty);

    expect(out).toHaveLength(25); // v1.6.31：覆盖整个窗口，故 25 格
    const hit = out.find((r) => r.bucket === stamp(13));
    expect(hit).toMatchObject({ requests: 7, credits: 3, tokens: 100, errors: 1 });
    expect(out.filter((r) => r.requests > 0)).toHaveLength(1);
  });

  it('★ today：桶数 = 本地零点 → 当前小时（含），不是固定 24', () => {
    const now = new Date('2026-10-12T05:20:00').getTime(); // 清晨 5 点
    const spec = resolveWindow('today');
    const { from, to } = windowRange(spec, now);

    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    // 0,1,2,3,4,5 → 6 个桶
    expect(out).toHaveLength(6);
    expect(out[0]!.bucket.endsWith('T00')).toBe(true);
    expect(out[5]!.bucket.endsWith('T05')).toBe(true);
  });

  it('day 桶：7d / 30d 各补成 8 / 31 个连续日（覆盖整个窗口）', () => {
    const now = new Date('2026-10-12T15:30:00').getTime();
    for (const [key, n] of [['7d', 8], ['30d', 31]] as const) {
      const spec = resolveWindow(key);
      const { from, to } = windowRange(spec, now);
      const out = fillEmptyBuckets<Row>([], spec, from, to, empty);
      expect(out, `${key} 应有 ${n} 个日桶`).toHaveLength(n);
      // 桶标签是 YYYY-MM-DD（无 T）
      expect(out.every((r) => !r.bucket.includes('T'))).toBe(true);
      // 连续日
      const d0 = new Date(out[0]!.bucket + 'T00:00:00').getTime();
      const d1 = new Date(out[1]!.bucket + 'T00:00:00').getTime();
      expect(d1 - d0).toBe(DAY);
      // 末桶 = 今天
      expect(out[out.length - 1]!.bucket).toBe('2026-10-12');
    }
  });

  it('乱序/重复输入不破坏桶序列（按 bucket 建索引）', () => {
    const now = new Date('2026-10-12T15:30:00').getTime();
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);
    const rows: Row[] = [
      { bucket: '2026-10-12T14', requests: 2, credits: 0, tokens: 20, errors: 0, models: [] },
      { bucket: '2026-10-12T10', requests: 5, credits: 0, tokens: 50, errors: 0, models: [] },
    ];
    const out = fillEmptyBuckets(rows, spec, from, to, empty);
    expect(out).toHaveLength(25); // v1.6.31：覆盖整个窗口
    // 顺序是时间序（10 在 14 之前）
    const i10 = out.findIndex((r) => r.bucket.endsWith('T10'));
    const i14 = out.findIndex((r) => r.bucket.endsWith('T14'));
    expect(i10).toBeLessThan(i14);
  });
});
