/**
 * 请求 / 响应体的**有界截断**（task#37，A3）。
 *
 * 为什么需要它：`logs.recordRequestBody` / `recordResponseBody` 打开后会把对话内容
 * 写进本地 SQLite。若不设上限，一条超长上下文（可达数百 KB）既撑大库，也让详情页
 * 难以渲染。这里给出**唯一**的截断口径，落库侧（ProxyLogger）统一调用。
 *
 * 纪律：
 *   - 默认关闭（设置项默认 false）；本文件只在开关打开时才被调用到。
 *   - 截断**只加尾部标记**，不改中间内容。被截断的 JSON 无法解析 → 详情页的
 *     `messages` / `assistantPreview` 会退化为空（`request-body.ts` 已优雅处理），
 *     这是可接受的降级：宁可少一段，也不写半截被误读。
 *   - 本模块**不接触**任何密钥：Authorization 只在请求头，从不进 body。
 */

/**
 * 单条 body 的存库上限（按字符计，约 128 KiB）。
 * 超过即截断并追加 `TRUNCATION_MARK`，避免长上下文把 `requests` 表撑爆。
 */
export const BODY_CAP_CHARS = 128 * 1024;

export const TRUNCATION_MARK = '…[truncated]';

/** 超过上限则截断并加标记；`null`/`undefined` 原样返回 `null`。 */
export function capBody(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  if (body.length <= BODY_CAP_CHARS) return body;
  return body.slice(0, BODY_CAP_CHARS) + TRUNCATION_MARK;
}
