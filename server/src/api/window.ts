/**
 * 时间窗口与时间桶工具（api-contract §3.4 / §0.3）。
 *
 * 契约要求所有时间字段是 **ISO 8601 UTC 字符串**（`toISOString()`），
 * 而 aggregates 的 bucket 是 **本地时区的** `YYYY-MM-DDTHH` / `YYYY-MM-DD`。
 * 两者混用是这里最容易出错的地方，所以解析/格式化都收敛到本文件。
 */

export type WindowKey = 'today' | '1h' | '24h' | '7d' | '30d';

export const WINDOWS: readonly WindowKey[] = ['today', '1h', '24h', '7d', '30d'];

/**
 * 缺省窗口 —— 产品默认「今日」（2026-10-09）。
 * 控制台三个页面都**显式**传窗口，这里只决定"不传时"的回落；
 * 它必须与契约 §3.4 写的「默认」一致，否则文档与实现就对不上。
 */
export const DEFAULT_WINDOW_KEY: WindowKey = 'today';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export interface WindowSpec {
  key: WindowKey;
  /** 窗口长度，毫秒。'today' 不用固定长度（见 windowRange），此处为占位 -1。 */
  ms: number;
  /** 趋势图的 bucket 粒度。today/1h/24h 用小时桶，7d/30d 用天桶 */
  bucket: 'hour' | 'day';
}

export function resolveWindow(raw: string | undefined): WindowSpec {
  const key = (raw ?? DEFAULT_WINDOW_KEY) as WindowKey;
  switch (key) {
    case 'today':
      /* [2026-10-08] 今日 = 本地零点到现在（**日历日**语义，不是滚动的 24h）。
         用户要的是"今天到目前为止花了多少"，跨夜清零才符合直觉。 */
      return { key, ms: -1, bucket: 'hour' };
    case '1h':
      return { key, ms: HOUR, bucket: 'hour' };
    case '7d':
      return { key, ms: 7 * DAY, bucket: 'day' };
    case '30d':
      return { key, ms: 30 * DAY, bucket: 'day' };
    case '24h':
    default:
      /* 认不出来的值仍回落到 24h（既有行为，未改）；**缺省**走上面的 'today' 分支。 */
      return { key: '24h', ms: DAY, bucket: 'hour' };
  }
}

/** 窗口 → [from, to) 毫秒区间。`to` 取 now 对齐到秒，避免同一次响应里三处 now 不同值。 */
export function windowRange(spec: WindowSpec, now = Date.now()): { from: number; to: number } {
  if (spec.key === 'today') {
    const d = new Date(now);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from, to: now + 1 };
  }
  return { from: now - spec.ms, to: now + 1 };
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 本地时区小时桶，与 `requests.repo.ts` 里 `hourBucket` 的格式必须逐字一致，
 * 否则趋势图会查不到数据（这是静默空图，没有报错，很难发现）。
 */
export function hourBucket(ms: number): string {
  const d = new Date(ms);
  return `${localDate(d)}T${pad(d.getHours())}`;
}

export function dayBucket(ms: number): string {
  return localDate(new Date(ms));
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 取整到分：积分一律 2 位小数，避免浮点尾数泄漏到前端（如 1157.9999999998）。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `round2` 的**可空版**：`null` 原样返回。
 *
 * [v0.5.8] 必须用它处理 `requests.credits` 的**行级**取值：`credits = NULL` 表示
 * 「上游未回报该次费用（未知）」，而 `Math.round(null * 100) / 100` 会算出 **0** ——
 * 那就把「不知道」变成了「没花钱」，正是口径铁律禁止的自标定。
 * （列级合计用 `COALESCE(SUM(credits), 0)`：未知行对**合计**的贡献就是 0，这是求和语义。）
 */
export function round2OrNull(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : round2(n);
}

/** 占比：0 分母返回 0（不是 NaN）。保留 3 位小数（契约示例是 0.562）。 */
export function share(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 1000;
}

/**
 * [v0.6.6] 把「只含非空桶」的聚合结果**补齐为空桶也有的完整时间序列**。
 *
 * 为什么需要：`trend` 的 SQL 是 `GROUP BY bucket`，**只返回有请求的桶**。
 * 24h 窗口里若有几小时没流量，图上就少几根柱 —— 而图表要求**等距时间轴**
 * （每根柱代表固定时长），否则柱宽随数据量漂移、同一窗口两次刷新还可能不同。
 *
 * 口径与 mock 的 `hourlyTrend(count, nowMs, …)` 一致：
 *   · hour 桶：从 `to` 对齐到整点，向前生成 `count` 个连续桶；
 *     `today` 取「本地零点 → 当前小时」的桶数（日历日语义，跨夜清零）。
 *   · day 桶：从 `to` 当天起向前 `count` 个连续日。
 * 桶标签格式与 SQL 的 `strftime('%Y-%m-%dT%H' / '%Y-%m-%d', 'localtime')` 逐字一致，
 * 保证与真实数据行能对上（对不上的桶视为空）。
 *
 * 只影响**图**：`metrics` / `byModel` / `byClient` 仍由各自 SQL 聚合，不经过这里。
 */
export function fillEmptyBuckets<T extends { bucket: string }>(
  rows: T[],
  spec: WindowSpec,
  from: number,
  to: number,
  makeEmpty: (bucket: string) => T,
): T[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = (d: Date): string =>
    spec.bucket === 'hour'
      ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* 桶序列：以 `to - 1ms` 所在的桶为最后一格，向前推。 */
  const stamps: string[] = [];
  if (spec.bucket === 'hour') {
    const end = new Date(to - 1);
    end.setMinutes(0, 0, 0);
    /* today：桶数 = 本地零点 → 当前小时（含），与 windowRange 的日历日语义一致。 */
    const start = spec.key === 'today' ? new Date(from) : new Date(end.getTime() - (spec.ms / HOUR - 1) * HOUR);
    for (let t = start.getTime(); t <= end.getTime(); t += HOUR) stamps.push(label(new Date(t)));
  } else {
    const end = new Date(to - 1);
    end.setHours(0, 0, 0, 0);
    const days = Math.round(spec.ms / DAY);
    for (let i = days - 1; i >= 0; i -= 1) stamps.push(label(new Date(end.getTime() - i * DAY)));
  }

  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return stamps.map((b) => byKey.get(b) ?? makeEmpty(b));
}
