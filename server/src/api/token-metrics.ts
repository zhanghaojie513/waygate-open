/**
 * 用量指标的口径计算（task#62）—— 纯函数，单独成文件以便单测。
 *
 * 放在后端而不是前端 JSX 里，理由是「可测」：本仓库前端**没有测试运行器**，
 * 而命中率这种「0 与「上游未提供」必须分清」的口径一旦散进组件就再也测不了。
 * 后端算好一个数字，前端只负责格式化。
 */

/**
 * 缓存命中率 = 缓存命中的 prompt tokens ÷ prompt tokens，取值 0..1。
 *
 * ## 口径（team-lead 明确要求）
 *
 * - **命中率为 0 就是 0，绝不说「上游未提供」。** 采集列是 `NOT NULL DEFAULT 0`，
 *   DeepSeek 系上游真实返回 `cached_tokens: 0` 时，命中率就是 0% —— 那是一个**真值**，
 *   不是「没有这个字段」。前端据此渲染 `0.0%`，不得回退到任何「未提供」文案。
 * - prompt 为 0（例如失败行、或上游没给 usage）：分母为 0，定义为 **0**（不是 NaN/1）。
 *   这类行的 tokens 本来就全是 0，命中率 0% 是自洽的。
 * - 防御性夹取到 [0, 1]：若上游给了 cached > prompt 的脏数据（不应发生），
 *   也不让命中率超过 100% 而让界面显得荒谬。
 *
 * @returns 0..1 的比例，四舍五入到 4 位小数（前端再格式化成百分比）。
 */
export function computeCacheHitRate(cachedTokens: number, promptTokens: number): number {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(promptTokens)) return 0;
  if (promptTokens <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, cachedTokens / promptTokens));
  return Math.round(ratio * 10000) / 10000;
}
