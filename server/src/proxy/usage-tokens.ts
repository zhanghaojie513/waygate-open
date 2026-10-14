/**
 * 从上游 `usage` 里取出**缓存命中的 prompt token 数**（task#62）。
 *
 * ## 为什么单独成一个纯函数
 *
 * 这段逻辑有一个**会静默算错**的陷阱，必须只写一份、且被单测钉死 ——
 * 散在 `proxy-log.ts` 里改一次错一次。它是本任务「防陷阱回归测试」的被测对象。
 *
 * ## 陷阱：顶层 `usage.cached_tokens` 是**假的**
 *
 * 上游（OpenAI 兼容的腾讯系）在 `usage` 顶层**也会**带一个 `cached_tokens` 字段，
 * 但它**恒为 0**，与真实命中量无关 —— 实测：同一次调用里
 * `usage.cached_tokens: 0` 而 `usage.prompt_tokens_details.cached_tokens: 7`。
 * 谁要是图省事读顶层那个，命中率就永远是 0，**而且不报错、不难看**，
 * 正是最危险的那类「沉默逻辑错误」。所以本函数**刻意不读顶层 `cached_tokens`**。
 *
 * ## 取值优先级
 *
 *   ① `usage.prompt_tokens_details.cached_tokens`  —— 真·权威字段（OpenAI 兼容标准）
 *   ② `usage.prompt_cache_hit_tokens`              —— DeepSeek 系的等价字段（回落）
 *   ③ 都没有                                        —— 0（不估算、不编造）
 *
 * 三档都只接受**有限、非负**的数字；字符串 / null / NaN / 负数一律视为「无此数据」
 * 并按下一档处理（而不是 `Number(...)` 强行转换 —— 那会把 `"7"` 之外的东西悄悄变 NaN）。
 */

/** 取不到时的返回值：0（**不是** null —— 采集列是 NOT NULL，且「没有缓存命中」本来就是 0）。 */
export const NO_CACHED_TOKENS = 0;

/** 该 `unknown` 是否是「可用作 token 数」的有限非负整数。 */
function asTokenCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/** 安全地把 unknown 当对象取属性（null / 非对象返回 undefined）。 */
function prop(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * 提取缓存命中的 prompt token 数。见文件头注释的取值优先级与陷阱说明。
 *
 * @param usage 上游返回的 `usage` 对象（`unknown` —— 来自 JSON.parse，不能假定形状）。
 */
export function extractCachedTokens(usage: unknown): number {
  // ① 权威字段：usage.prompt_tokens_details.cached_tokens
  const details = prop(usage, 'prompt_tokens_details');
  const fromDetails = asTokenCount(prop(details, 'cached_tokens'));
  if (fromDetails !== null) return fromDetails;

  // ② 回落：DeepSeek 系 usage.prompt_cache_hit_tokens
  const fromHit = asTokenCount(prop(usage, 'prompt_cache_hit_tokens'));
  if (fromHit !== null) return fromHit;

  // ③ 都拿不到 —— 0，不估算。
  //    ⚠️ 绝不 fallback 到 usage.cached_tokens（顶层那个恒 0 的假字段）。
  return NO_CACHED_TOKENS;
}

/**
 * ★ 提取上游**直接回报的真实扣费** `usage.credit`（2026-10-07 校准实验发现）。
 *
 * 上游在 usage 里带 `credit` 字段 —— 就是本次请求实际扣的订阅积分（已含模型倍率与
 * 缓存折扣）。实测锚点（deepseek-v4.1-flash，×0.11）：2,604 tokens 无缓存 → 0.08；
 * 同一提示重发（94% 缓存命中）→ 0.01。反推量纲 ≈ (miss + cached×k + output) ×
 * 0.28 × 倍率 / 1000 —— 即**官方按每 1K tokens 计价**，本地旧公式 `(pt+ct)×倍率`
 * 差了整整 1000 倍。
 *
 * 因此积分的**唯一权威来源就是这个字段**：拿到即用（`credits_from_upstream` 留痕）；
 * 拿不到就是**未知**（`credits = NULL` + `credits_unknown`）—— v0.5.8 起**不再有任何
 * 本地兜底公式**（本项目是反代，自标定会让面板失去可信度）。
 * 取值规则与 cached_tokens 同款纪律：只认**有限非负数字**，其余视为「无此数据」。
 */
export function extractUpstreamCredit(usage: unknown): number | null {
  const v = prop(usage, 'credit');
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100) / 100;
}

/**
 * 提取输出里的**思考（reasoning）tokens**（2026-10-07 v0.2.0）。
 *
 * 上游计费口径：`completion_tokens` **包含** reasoning。ZCode 长会话一条回复
 * 「输出 130」里 98 是思考 —— 不拆开，「这条为什么这么贵/这么慢」不可解释。
 * 校准探针实测（probe-calibrate.mjs）两个真值位置：
 *   ① `usage.completion_tokens_details.reasoning_tokens`（标准位）
 *   ② 顶层 `usage.completion_thinking_tokens`（该网关的等价字段，回落）
 * 取不到 = 0（不估算）；钳制不越过 completion_tokens（防御）。
 */
export function extractReasoningTokens(usage: unknown, completion: number): number {
  const details = prop(usage, 'completion_tokens_details');
  const fromDetails = asTokenCount(prop(details, 'reasoning_tokens'));
  if (fromDetails !== null) return Math.min(fromDetails, Math.max(completion, 0));
  const fromTop = asTokenCount(prop(usage, 'completion_thinking_tokens'));
  if (fromTop !== null) return Math.min(fromTop, Math.max(completion, 0));
  return 0;
}
