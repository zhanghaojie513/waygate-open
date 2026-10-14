import type { RelayHttpError } from '../common/errors';
import { mapUpstreamBusinessCode, mapUpstreamHttpStatus, toRelayError } from './upstream-errors';
import { buildChatCompletionsUrl } from './upstream-url';

/**
 * 上游响应体（非 2xx）可能是两种形状：
 *   - 纯文本（部分路径）
 *   - JSON，含 5 位业务码
 * 必须两种都能解析，否则会把"参数问题"误判成"未知错误"。
 */
export interface UpstreamFailure {
  httpStatus: number;
  businessCode: number | null;
  rawBody: string;
  /**
   * 上游自己写的失败原因（`msg` / `error.message`），已折叠空白并截断到 200 字符。
   *
   * 为什么需要它：业务码不在已知集合时，`` 上游返回未知业务码 X `` 这种话对排障没有
   * 增量 —— 上游原文才是（实测 `11115` 的原文是 `prompt is too long: 1266460 tokens
   * > 1048576 maximum`，把「超了多少、上限多少」交代得一清二楚）。
   * ⛔ 只取**错误消息字段**，绝不回传整个 body —— 那可能夹带上游回显的请求正文。
   */
  businessMessage: string | null;
}

/** 上游错误消息字段的截断上限（防上游把整段正文塞进 message）。 */
const UPSTREAM_MESSAGE_MAX = 200;

/** 取上游的失败原因字段：`msg` -> `message` -> `error.message`。只认字符串，非字符串一律 null。 */
function extractBusinessMessage(parsed: Record<string, unknown>): string | null {
  const errorField = (parsed as { error?: unknown }).error;
  const nested = typeof errorField === 'object' && errorField !== null
    ? (errorField as { message?: unknown }).message
    : errorField;
  const candidates = [
    (parsed as { msg?: unknown }).msg,
    (parsed as { message?: unknown }).message,
    nested,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') {
      return c.replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_MESSAGE_MAX);
    }
  }
  return null;
}

export function parseUpstreamFailure(httpStatus: number, rawBody: string): UpstreamFailure {
  let businessCode: number | null = null;
  let businessMessage: string | null = null;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const candidates = [
      (parsed as { code?: unknown }).code,
      (parsed as { error?: { code?: unknown } }).error?.code,
      (parsed as { error?: { message?: unknown } }).error?.message,
    ];
    for (const c of candidates) {
      if (typeof c === 'number') {
        businessCode = c;
        break;
      }
      if (typeof c === 'string') {
        const m = /(11\d{3})/.exec(c);
        if (m) {
          businessCode = Number(m[1]);
          break;
        }
      }
    }
    businessMessage = extractBusinessMessage(parsed);
  } catch {
    // 纯文本 404 体（实测存在）：尝试从文本里抠 5 位业务码
    const m = /(11\d{3})/.exec(rawBody);
    if (m) businessCode = Number(m[1]);
  }
  return { httpStatus, businessCode, rawBody, businessMessage };
}

/**
 * 由基地址拼 chat/completions 端点。
 * 真正的实现收敛在 `upstream-url.ts`（task#37 起转发/探测/目录共用一处），
 * 这里保留函数名仅为兼容既有调用与单测。
 */
export function buildUpstreamUrl(baseUrl: string): string {
  return buildChatCompletionsUrl(baseUrl);
}

/** 把上游失败翻译成我们对外抛的 RelayHttpError（含 11102 标记模型的副作用信号）。 */
export function interpretUpstreamFailure(f: UpstreamFailure): RelayHttpError {
  if (f.businessCode !== null) {
    const mapped = mapUpstreamBusinessCode(f.businessCode);
    return toRelayError(mapped, f.businessCode, f.businessMessage);
  }
  return toRelayError(mapUpstreamHttpStatus(f.httpStatus), null, f.businessMessage);
}
