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
 * [v1.6.31 修] **起点向下对齐到桶边界**，不再「从末尾往前数固定格数」。
 *
 * 旧实现以 `to` 对齐整点后往前数 `ms/HOUR` 格（24h → 恰好 24 格），而窗口起点
 * 是 `now - 24h`（**不对齐**）。于是窗口最老的残桶被整桶丢掉：
 *   now=15:30 时窗口 = [昨日 15:30, 今日 15:30]，图却从昨日 **16:00** 起 →
 *   昨日 15:30–16:00 的请求既不在图上、也不在任何柱子里。
 * 实测量级：某一时刻 24h 窗口 766 条请求图上只体现 700 条（差 12%），
 * 而卡片写的是 766 —— 用户对不上账。
 *
 * 现在桶序列覆盖 ⟨⊇⟩ 窗口区间，窗口内每一行都落进某个桶，
 * `Σtrend === metrics` 恒成立。柱数因此随窗口变化（24h → 25 格）——
 * 图的职责是覆盖窗口，不是凑一个整数。
 *
 * 首/末桶可能代表不足一格的时间：这是**如实**的（它们就是窗口在那一格里
 * 覆盖到的部分），前端 tooltip 会显示真实区间。
 *
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

  /* 起点**向下对齐**到桶边界、终点当前桶 —— 两者都从窗口区间推出来，
     所以序列必然覆盖 [from, to)。 */
  const start = new Date(from);
  const end = new Date(to - 1);
  if (spec.bucket === 'hour') {
    start.setMinutes(0, 0, 0);
    end.setMinutes(0, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
  }
  const step = spec.bucket === 'hour' ? HOUR : DAY;

  const stamps: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += step) stamps.push(label(new Date(t)));

  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return stamps.map((b) => byKey.get(b) ?? makeEmpty(b));
}

/**
 * [v1.6.31] 给趋势桶标注「是否只覆盖窗口的一部分」。
 *
 * 首桶与末桶可能各是半个/几分钟的小时（窗口按 `now` 滚动，不对齐整点）。
 * 数字本身是**真实**的（窗口内的行都算进去了），但如果界面上把首桶也读成
 * 「一整个小时」，就会把它和中间那些满桶混为一谈 —— 例如看起来「首小时流量很低」。
 * 前端据此在 tooltip 里注明「本段不足 1 小时/1 天」。
 *
 * 判定用桶的真实时间跨度：`[桶起点, 桶起点 + step)` 与窗口 `[from, to)` 的交集
 * 是否短于 step。
 */
export function markPartialBuckets<T extends { bucket: string }>(
  rows: T[],
  spec: WindowSpec,
  from: number,
  to: number,
): Array<T & { partial: boolean }> {
  const step = spec.bucket === 'hour' ? HOUR : DAY;
  const bucketStart = (bucket: string): number => {
    /* 标签是本地时区的 `YYYY-MM-DDTHH` / `YYYY-MM-DD`，直接交给 Date 解析
       （不带时区后缀时按本地时区解释，与生成侧一致）。 */
    return new Date(bucket.includes('T') ? `${bucket}:00:00` : `${bucket}T00:00:00`).getTime();
  };
  return rows.map((r) => {
    const s = bucketStart(r.bucket);
    const covered = Math.min(s + step, to) - Math.max(s, from);
    return { ...r, partial: covered < step - 1 }; // 1ms 容差：窗口末端是 now+1
  });
}
