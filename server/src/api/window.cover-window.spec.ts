/**
 * [v1.6.31] 趋势图必须覆盖**整个窗口**，首桶不能因为「不满一格」被丢弃。
 *
 * ## 缺陷
 * `fillEmptyBuckets` 以 `to` 对齐到整点/整日后**向前数固定格数**（24h = 24 格、
 * 7d = 7 格），而窗口起点是 `now - 24h` / `now - 7d`（**不对齐**）。
 * 于是窗口最老的残桶被整桶丢掉：
 *
 *   now = 15:30 时，24h 窗口 = [昨日 15:30, 今日 15:30]，图却从昨日 **16:00** 开始
 *   → 昨日 15:30–16:00 的请求既不在图上、也不在任何柱子里。
 *
 * 实测：某一时刻 24h 窗口 766 条请求里，图上只体现 700 条（差 12%），
 * 而卡片写的是 766 —— 用户对不上账。
 *
 * ## 修法
 * 桶序列的**起点向下对齐到桶边界**（`floor(from)`），终点仍是当前桶。
 * 这样图的覆盖区间 ⟨⊇⟩ 窗口区间，窗口内每一行都落进某个桶，于是
 * `Σtrend === metrics` 恒成立；首桶如实代表「窗口在那一格里的剩余部分」。
 *
 * 柱数因此随窗口变化（24h → 25 格），这是**正确**的：图的职责是覆盖窗口，
 * 不是凑一个好看的整数。
 */
import { describe, expect, it } from 'vitest';
import { fillEmptyBuckets, markPartialBuckets, resolveWindow, windowRange } from './window';

type Row = { bucket: string; requests: number; credits: number; tokens: number; errors: number; models: never[] };
const empty = (bucket: string): Row => ({ bucket, requests: 0, credits: 0, tokens: 0, errors: 0, models: [] });

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 本地时间构造（与 window.ts 的桶标签同用本地时区）。 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();
const hourLabel = (y: number, mo: number, d: number, h: number) =>
  `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
const dayLabel = (y: number, mo: number, d: number) =>
  `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

describe('fillEmptyBuckets · 覆盖整个窗口（首桶不得丢弃）', () => {
  it('★ 24h：起点对齐到窗口起点的整点 —— 首桶就是「昨日 15:00」，不是 16:00', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    /* 窗口 = [18 日 15:30, 19 日 15:30]；向下对齐后首桶 = 18 日 15:00，
       末桶 = 19 日 15:00。共 25 格（首尾各是一个不满整点的小时，但都在窗口内）。 */
    expect(out[0]!.bucket).toBe(hourLabel(2026, 10, 18, 15));
    expect(out[out.length - 1]!.bucket).toBe(hourLabel(2026, 10, 19, 15));
    expect(out).toHaveLength(25);
  });

  it('★ 首桶里的请求必须出现在图上（放在首桶，而不是消失）', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);

    /* 一条落在「昨日 15:40」的请求 —— 在窗口内，但旧实现因为首桶被丢而看不见它。 */
    const inFirstPartial = hourLabel(2026, 10, 18, 15);
    const rows: Row[] = [{ bucket: inFirstPartial, requests: 7, credits: 3, tokens: 100, errors: 0, models: [] }];

    const out = fillEmptyBuckets(rows, spec, from, to, empty);

    expect(out[0]!.bucket).toBe(inFirstPartial);
    expect(out[0]!.requests).toBe(7); // ★ 不再消失
  });

  it('★ 7d：起点对齐到窗口起点的当日零点（8 个日桶）', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('7d');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    expect(out[0]!.bucket).toBe(dayLabel(2026, 10, 12)); // 19 日减 7 天
    expect(out[out.length - 1]!.bucket).toBe(dayLabel(2026, 10, 19));
    expect(out).toHaveLength(8);
  });

  it('★ 30d：31 个日桶（首日残段也要有位置）', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('30d');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);
    expect(out).toHaveLength(31);
  });

  it('★ today：不变（起点本就是零点，桶数 = 当前小时 + 1）', () => {
    const now = local(2026, 10, 19, 5, 20);
    const spec = resolveWindow('today');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    expect(out).toHaveLength(6); // 00..05
    expect(out[0]!.bucket).toBe(hourLabel(2026, 10, 19, 0));
  });

  it('★ 1h：2 个桶（跨两个整点），而不是 1 个', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('1h');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    expect(out).toHaveLength(2);
    expect(out[0]!.bucket).toBe(hourLabel(2026, 10, 19, 14));
    expect(out[1]!.bucket).toBe(hourLabel(2026, 10, 19, 15));
  });

  it('★ 桶序列连续且严格递增（不能因跨 DST/月份出现重复或空洞）', () => {
    const now = local(2026, 11, 2, 3, 10); // 跨美/欧 DST 切换日的邻近日
    const spec = resolveWindow('7d');
    const { from, to } = windowRange(spec, now);
    const out = fillEmptyBuckets<Row>([], spec, from, to, empty);

    const stamps = out.map((r) => new Date(r.bucket + 'T00:00:00').getTime());
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBe(DAY);
    }
  });
});

/**
 * [v1.6.31] `markPartialBuckets` —— 首/末桶不足一整格时如实标注。
 *
 * 为什么需要：窗口按 `now` 滚动、不对齐整点，首桶往往只有半小时。
 * 数字是真的（只统计窗口内），但界面若把首桶读成「一整个小时」，
 * 会误判成「那段时间流量很低」。
 */
describe('markPartialBuckets · 不足一格的桶要标出来', () => {
  it('★ now=15:30 的 24h：首桶(昨 15 点)与末桶(今 15 点)都是 partial，中间不是', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);

    const buckets = [
      hourLabel(2026, 10, 18, 15), // 首：只覆盖 15:30–16:00（30 分钟）
      hourLabel(2026, 10, 18, 16), // 满
      hourLabel(2026, 10, 19, 14), // 满
      hourLabel(2026, 10, 19, 15), // 末：只覆盖 15:00–15:30（30 分钟）
    ].map((bucket) => ({ bucket }));

    const out = markPartialBuckets(buckets, spec, from, to);
    expect(out.map((b) => b.partial)).toEqual([true, false, false, true]);
  });

  it('★ now 恰好整点：首桶也满（不误标）', () => {
    const now = local(2026, 10, 19, 15, 0);
    const spec = resolveWindow('24h');
    const { from, to } = windowRange(spec, now);

    /* from=昨 15:00 整 → 首桶从 15:00 开始，覆盖满 1 小时。末桶 = 今 15:00，
       窗口到 15:00 为止 —— 末桶只覆盖 0 秒，是 partial。 */
    const out = markPartialBuckets([{ bucket: hourLabel(2026, 10, 18, 15) }], spec, from, to);
    expect(out[0]!.partial).toBe(false);
  });

  it('★ 7d：首日残段标 partial，中间满日不标', () => {
    const now = local(2026, 10, 19, 15, 30);
    const spec = resolveWindow('7d');
    const { from, to } = windowRange(spec, now);

    const out = markPartialBuckets(
      [{ bucket: dayLabel(2026, 10, 12) }, { bucket: dayLabel(2026, 10, 15) }],
      spec,
      from,
      to,
    );
    expect(out[0]!.partial).toBe(true); // 12 日只从 15:30 起算
    expect(out[1]!.partial).toBe(false);
  });
});
