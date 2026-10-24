/**
 * 纯展示格式化函数。无业务、无副作用。
 * 时间一律按本地时区渲染（服务端给 ISO 8601 UTC，见 api-contract.md §0.3）。
 */

import type { KeyScope, RequestLogRow } from '../types/api';

const numFmt = new Intl.NumberFormat('zh-CN');
const decFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return numFmt.format(Math.round(n));
}

/**
 * 速率类数值（RPM / TPM 等"每分钟多少"）—— **绝不能四舍五入成 0**。
 *
 * 典型场景：今日已过 10.5 小时、62 次请求 → 0.098 RPM。
 * 此前走 `formatInt`（内部 Math.round），显示成 "0"，
 * 读者会以为"没有流量"，而事实上流量是有的、只是密度低于 1。
 *
 * 规则按有效数字而非固定小数位（与 Grafana / Prometheus 的读数习惯一致）：
 *   · < 1     → 两位小数（0.098 → "0.10"，0.5 → "0.50"）
 *   · < 100   → 一位小数（2.4 → "2.4"，99.95 → "100.0"）
 *   · >= 100  → 整数（1,234 → "1,234"，与 formatInt 一致）
 * 为什么分档：0.098 若固定一位小数会变成 0.1（丢一半信息），
 * 而 1234.0 带小数位是噪声。
 */
export function formatRate(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs < 1) return n.toFixed(2);
  if (abs < 100) return n.toFixed(1);
  return numFmt.format(Math.round(n));
}

/** 积分保留两位小数；无数据源时返回 '--'，绝不用 0 占位 */
export function formatCredits(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return decFmt.format(n);
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '--';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * 缓存命中率 → 百分比字符串（task#62）。
 *
 * ★ 与 `formatPercent` 的区别：**永远返回一个百分比，绝不返回「--」或「上游未提供」**。
 * 原因：采集字段是 `NOT NULL DEFAULT 0`，`0` 是**真值**（DeepSeek 系上游真实返回 0），
 * 不是「缺失」。把它渲染成「未提供」等于把「确实是 0%」谎报成「拿不到」。
 * 这是纯函数（无副作用），口径集中在这里，不散进组件 JSX。
 */
export function formatCacheHitRate(ratio: number, digits = 1): string {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return `${(r * 100).toFixed(digits)}%`;
}

/**
 * tokens 的紧凑显示，完整阶梯：K（千）/ M（百万）/ B（十亿）/ T（万亿）/ Q（千万亿）。
 * 用于横幅/指标卡这种「一眼看量级」的位置；需要精确值的地方仍用 `formatInt`。
 * [2026-10-12 用户要求] 补齐 B/T/Q —— 中转站聚合多客户端流量，单窗口 tokens
 * 已可见百万级；再往上只到 M 会在十亿级显示一长串裸数字。
 */
const TOKEN_UNITS: Array<{ limit: number; div: number; digits: number; suffix: string }> = [
  { limit: 1e15, div: 1e15, digits: 2, suffix: 'Q' }, // 千万亿（quadrillion）
  { limit: 1e12, div: 1e12, digits: 2, suffix: 'T' }, // 万亿（trillion）
  { limit: 1e9, div: 1e9, digits: 2, suffix: 'B' },   // 十亿（billion）
  { limit: 1e6, div: 1e6, digits: 2, suffix: 'M' },   // 百万（million）
  { limit: 1e3, div: 1e3, digits: 1, suffix: 'K' },   // 千（thousand）
];
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  const v = Math.round(n);
  const tier = TOKEN_UNITS.find((u) => Math.abs(v) >= u.limit);
  if (tier) return `${(v / tier.div).toFixed(tier.digits)}${tier.suffix}`;
  return String(v);
}

/** 毫秒 → 1.1s / 3.21s，超过 60s 走 m 分 s 秒 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * [v1.6.8] **输出速度**（tokens/秒）。
 *
 * 口径：`completion_tokens / 生成时长`，其中生成时长 = 总耗时 − 首字耗时
 * （扣掉首字等待，只算真正吐字的吞吐；与社区那种 t/s 显示同口径）。
 *
 * ⚠️ 上游**不给**生成时长（三家 usage 里都没有时长字段），所以这里全靠反代侧观测的
 * `ms` / `first_byte_ms` 推算 —— 这是**唯一**可行的口径。
 *
 * 取不到就返回 `null`（调用方显示 `--`），**不返回 0**：
 *   · 失败行：`first_byte_ms` 为 NULL、completion 为 0 —— 压根没有生成过程
 *   · 非流式 / 首字即全部内容：生成时长 ≤ 0，速度无意义
 *   · 未回报 completion tokens：分子不可知
 * 「未知」与「0 t/s」是两件事，混同会让人以为模型不吐字。
 */
export function outputSpeed(
  completionTokens: number | null | undefined,
  ms: number | null | undefined,
  firstByteMs: number | null | undefined,
): number | null {
  const ct = completionTokens ?? 0;
  if (ct <= 0) return null;
  if (ms === null || ms === undefined || ms <= 0) return null;
  /* 首字未知时退化为「按总耗时算」——至少给一个下界估计，但这是有损的（含首字等待）。 */
  const gen = firstByteMs === null || firstByteMs === undefined ? ms : ms - firstByteMs;
  if (gen <= 0) return null;
  return ct / (gen / 1000);
}

/** 速度值 → `199.1 t/s`；null → `--`。 */
export function formatSpeed(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || Number.isNaN(tps)) return '--';
  return `${tps.toFixed(1)} t/s`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 天前；未来时间 → 马上 / N 分钟后 / N 小时后 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '--';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '--';
  const diff = Date.now() - t;
  /* [2026-10-17 评审修] 未来时间此前一律返回「刚刚」—— AppShell 拼成
     「会话有效 · 刚刚到期」，每页侧栏一条永久性自相矛盾的话（对「数不说谎」
     是信任级缺陷）。未来时间改给「N 分钟/小时后」，在「…到期」的组合里才读得通。 */
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return '马上';
    if (ahead < 3_600_000) return `${Math.floor(ahead / 60_000)} 分钟后`;
    if (ahead < 86_400_000) return `${Math.floor(ahead / 3_600_000)} 小时后`;
    return `${Math.floor(ahead / 86_400_000)} 天后`;
  }
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

/** bucket "2026-10-03" → "10/03"；小时桶 "2026-10-03T14" → "10/03 14时"
 *  （小时不带刻度时，1h/24h 窗口的轴标签全是同一天，读不出时间）。 */
export function formatBucket(bucket: string): string {
  const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/);
  if (!m) return bucket.slice(5, 10);
  const day = `${Number(m[2])}/${Number(m[3])}`;
  return m[4] !== undefined ? `${day} ${Number(m[4])}时` : day;
}

export function formatScope(scope: KeyScope): string {
  switch (scope.type) {
    case 'all':
      return '全部模型';
    case 'family':
      return `仅 ${scope.value} 系`;
    case 'tag':
      return `仅 ${scope.value}`;
    case 'models':
      return `指定 ${scope.value.length} 个模型`;
    default:
      return '未知范围';
  }
}

export type Tone = 'live' | 'warn' | 'fatal' | 'muted';

/**
 * 「上游访问密钥失效」的失败标记 —— 与后端同源（`spec-v4-failure-logging.md` §3）。
 *
 * ⚠️ **不能用 `status === 401` 识别。** `status` 的语义是「客户端实际收到的码」，
 * 上游 401 按契约**映射成 502**；识别它只能靠 `note`（纯 HTTP 401 的 `upstream_code`
 * 为 null，也无法用业务码定位）。见 `_K` 注释与契约 §3 的 ⚠️ 注。
 */
export const NOTE_CREDENTIAL_INVALID = 'upstream_credential_invalid';

/** `note` 是逗号分隔的标记串 —— 用「完整标记」匹配，避免子串误伤（如 401 撞上 4011）。 */
export function hasNote(note: string, token: string = NOTE_CREDENTIAL_INVALID): boolean {
  return note.split(',').includes(token);
}

/** 状态码语义着色：上游访问密钥失效是唯一会让服务停摆的状态，给它最高权重。 */
export function statusTone(status: number, note = ''): Tone {
  if (hasNote(note) || status === 401) return 'fatal';
  if (status >= 400) return 'warn';
  return 'live';
}

/** note 单个 token → 可读文案的映射表（noteLabel / noteLabels 共用，改这里即可） */
const NOTE_MAP: Record<string, string> = {
  [NOTE_CREDENTIAL_INVALID]: '上游访问密钥失效',
  'upstream unreachable': '上游不可达',
  'upstream empty body': '上游返回空响应',
  'upstream_error': '上游错误',
  'bad request body': '请求体不合法',
  'model not permitted': '模型未授权',
  'model not found': '模型不存在',
  'concurrency limit': '本机并发上限',
  'rate limited': '命中上游限流',
  'rate_limited': '命中上游限流',
  'upstream timeout': '上游超时',
  model_not_available: '账号未开通此模型',
  invalid_max_tokens: 'max_tokens 不合法',
  /* [2026-10-12] 上游业务码 11115（`prompt is too long: N tokens > M maximum`）：
     上下文超限。它此前落到 `upstream_error`——不是没映射，是业务码在代理层被吞了
     （见 proxy.service.ts 的「上游失败体只准读一次」注）。补上映射后日志能直接读出
     「把历史/工具输出裁短就能过」这个客户端可自行纠正的方向。 */
  context_length_exceeded: '上下文超限',
  upstream_11101: '上游要求强制流式',
  /* [task#52] 原来写「上游要求首条 system」——那是**推断**且被证据否掉。
     [task#77] 曾归因 developer role；[2026-10-07] 根因定案（probe/05-11128-fix-plan.md）：
     上游对 system 正文做 ≥47 字符的长 n-gram 模板指纹匹配（Claude Code 血统的 git 环境
     模板行），命中即 400/11128；developer 是另一个独立触发点。key 保留（契约 token）。 */
  upstream_11128: '上游渠道校验拒绝（提示指纹）',
  retried: '已自动重试',
  'cache hit': '命中缓存',
  system_injected: '已补 system',
  /* [v1.6.27] 11128 渠道熔断快速失败：阵发期（上游全拒，降级重试也 11128）连续 3 次后
     开闸，后续请求**未打上游、未占并发槽、未计费**，毫秒级返回 502 + retry-after。
     与上面的 upstream_11128 分开 —— 那一行说明上游真的拒绝了，这一行说明我们主动不发；
     处置也不同（前者查提示指纹，后者只需等阵发过去）。 */
  breaker_open: '渠道熔断中（未发上游）',
  // [task#77] rewrite.ts 出站前把开发者角色 developer 规范化为 system（上游只拒精确小写 developer）。
  developer_role_normalized: '已规范 developer 角色',
  stream_options_stripped: '已移除 stream_options',
  // [2026-10-07] 命中 11128 时 proxy.service 以 neutral 档自动降级重试一次（L2 fail-open）。
  sysprompt_degraded_retry: '命中渠道校验，已降级重试',
  stream_aborted: '流式中断',
  // 与 stream_aborted 必须分开：stream_aborted = 上游流中断（去查上游）；
  // client_detached = 客户端在流式进行中主动断开/写失败（去查客户端/网络）。处置相反，不可混同。
  client_detached: '客户端已断开',
  /* [v1.6.28] 落库时发现密钥已在请求在途期间被删除：行保留（tokens / 积分 / 状态 / 耗时
     照常落库），key_id 降级为 NULL。client_id / key_hint 文本快照仍在，所以这条仍能
     看出是谁发的 —— 不改写成 unidentified，避免污染客户端排行。 */
  key_deleted_inflight: '密钥在途删除（归属已置空）',
  usage_missing: '上游未返回用量',
  'minimax tokens unavailable': 'MiniMax token 不可用',
  'token refresh failed': '上游 token 刷新失败',
  'missing credential': '缺少上游访问凭证',
  /* [v1.6.13] WorkBuddy 转发改走 OAuth 后的三种失败留痕。 */
  'wb oauth unavailable': 'WorkBuddy 授权服务不可用',
  'missing wb oauth credential': 'WorkBuddy 未导入授权',
  'wb token refresh failed': 'WorkBuddy 授权刷新失败',
  'qoder credential invalid': 'Qoder 凭证无效',
  /* [v1.7.0] 自定义提供商（OpenAI 兼容 + 静态 key）出站失败留痕。 */
  'missing custom api key': '自定义 API Key 未配置',
  // [历史·v0.5.8 起后端不再写入] 旧本地兜底公式的标记。保留映射只为**历史行仍可读**——
  // 公式已整段移除（上游未回报即 credits=null），新行不会再出现这两个 token。
  'multiplier-unknown': '倍率未知（历史：积分按中性估算）',
  cache_discounted: '缓存命中已按折扣计（历史）',
  // [2026-10-07] 上游 usage 回报了 credit 字段：本行积分 = 上游实扣原值（真实账单）。
  credits_from_upstream: '上游实扣积分',
  // [v0.5.8] 上游未回报该次费用（credits=null，未知）——本服务不估算，界面显示 —。
  credits_unknown: '上游未回报积分',
  // [2026-10-07] 一次性数据订正：2026-10-07 15:46 前的历史行按校准量纲重算过积分。
  credits_recalibrated: '历史积分已重算',
  // [2026-10-11] 一次性数据订正：该行积分原为旧兜底公式编造（上游从未回报），已作废为
  // NULL（未知）并留痕。触发实例：MiniMax 免费模型 2 条请求被记成 40.18 积分（100% 虚构）。
  estimate_voided: '历史估算已作废（上游未回报）',
};

/**
 * 日志行尾部标记的可读文案（note 是逗号分隔的标记串）。
 * [2026-10-07 A1] 只取**第一个**标记 —— 保留给空间极紧的单元格（概览最近流）。
 */
export function noteLabel(note: string): string {
  if (!note) return '-';
  const first = note.split(',')[0];
  return NOTE_MAP[first] ?? first;
}

/**
 * [2026-10-07 A1] note 的**全部**标记映射（表格/详情用）。
 * 修复：一行 `stream_options_stripped,template_rewritten_5,cache_discounted` 此前只显示
 * 「已移除 stream_options」，最有诊断价值的标记（降级重试/缓存折扣/历史重算）全被吞掉。
 * 未映射 token 原样返回（与 noteLabel 的兜底口径一致，动态族如 template_rewritten_5）。
 */
export function noteLabels(note: string): string[] {
  if (!note) return [];
  return note
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => NOTE_MAP[t] ?? t);
}

/** 上游失败（业务码 / 凭证失效）的处置提示（api-contract.md §2.1.5） */
export function upstreamHint(row: Pick<RequestLogRow, 'status' | 'upstreamCode' | 'note'>): string | null {
  if (row.upstreamCode === 11102) {
    return '11102：当前账号未开通该模型。该项已在模型表标为未验证，不会自动删除——订阅变动后可能再开。';
  }
  if (row.upstreamCode === 11128) {
    /* [2026-10-07] 逐字对齐后端 server/src/proxy/upstream-errors.ts 的 11128 message
       （根因定案：system 提示命中上游的第三方客户端模板指纹；developer role 是另一个
       独立触发点。两层防护：转发前模板行改写 + 命中后降级重试，均失败才走到这条）。 */
    return '11128：上游返回业务码 11128（上游原文「Illegal API invocation from an unapproved channel」）：本次请求的 system 提示命中了上游对第三方客户端模板的指纹校验。本服务已在转发前改写模板行，并在被拒时自动降级为中性提示重试一次，均未通过；请检查「客户端与密钥 → 提供商 → system 提示改写」是否被关闭，或把该请求的特征反馈给维护者。';
  }
  if (row.upstreamCode === 11101) {
    return '11101：上游拒绝了非流式请求。本服务已强制改写为流式，出现此码说明上游协议变更。';
  }
  if (row.upstreamCode === 11133) {
    return '11133：max_tokens 过小。已提升到下限后重试一次。';
  }
  if (hasNote(row.note)) {
    return '上游访问密钥失效是这套方案唯一会让服务停摆的状态：所有客户端共用同一把上游访问密钥，它一失效即整体不可用。去「客户端与密钥 → 提供商」的「修改」里换新。';
  }
  return null;
}
// @zbiti-ai:f:231:da08b735
