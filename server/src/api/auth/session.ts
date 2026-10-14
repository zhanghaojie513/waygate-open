/**
 * 控制台会话令牌（api-contract §1.4）。
 *
 * cookie 名 `relay_sid`，值形如 `<payload_b64url>.<hmac_b64url>`：
 *   - payload 是 **不加密、只签名** 的 JSON：`{"sub":"admin","iat","exp","jti"}`
 *     （不加密是有意的：里面没有任何秘密，只用来证明"这个 cookie 是我发的"）
 *   - hmac = base64url(HMAC_SHA256(RELAY_SECRET, payload_b64url))
 *     ⚠️ 签名覆盖的是 **base64url 之后的串**，不是原始 JSON ——
 *     否则 base64 的等价变体（补不补 '='）会绕过校验
 *   - 无服务端状态：登出只是删 cookie，服务端不需要作废列表
 *
 * 依赖 `RelayConfigService.secret`（同样是 key_hash 用的那把），
 * 因此同一个 data/relay.secret 文件丢失会同时让密钥与会话失效 —— 这是可接受的
 * 单点，因为两者本来就同属"本机这台服务的身份"。
 */

import { randomBytes } from 'node:crypto';
import { hmacBase64Url, safeEqual } from '../../common/crypto';

export const SESSION_COOKIE = 'relay_sid';
/** 12 小时（api-contract §1.4 的 Max-Age=43200）。 */
export const SESSION_TTL_SECONDS = 43200;

export interface SessionPayload {
  sub: 'admin';
  /** 签发时刻，epoch 秒 */
  iat: number;
  /** 过期时刻，epoch 秒 */
  exp: number;
  /** 随机 id，纯为将来可能的作废列表留位 */
  jti: string;
}

function sign(secret: string, payloadB64: string): string {
  return hmacBase64Url(secret, payloadB64);
}

/** 签发会话令牌，返回 cookie 值与过期时间。 */
export function issueSession(
  secret: string,
  now = Date.now(),
): { token: string; payload: SessionPayload; expiresAt: Date } {
  const iat = Math.floor(now / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    sub: 'admin',
    iat,
    exp,
    jti: randomJti(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${payloadB64}.${sign(secret, payloadB64)}`;
  return { token, payload, expiresAt: new Date(exp * 1000) };
}

export type SessionCheck =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'bad_subject' };

/**
 * 校验会话令牌。四步顺序固定，任一失败即拒。
 * 对外的失败原因**不区分**（前端一律跳登录），reason 只用于服务端日志。
 */
export function verifySession(
  secret: string,
  token: string | null | undefined,
  now = Date.now(),
): SessionCheck {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(secret, payloadB64);
  // 先验签再解析：不给"伪造 payload 触发 JSON 解析异常"的机会
  if (!safeEqual(providedSig, expectedSig)) return { ok: false, reason: 'bad_signature' };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (payload.sub !== 'admin') return { ok: false, reason: 'bad_subject' };
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

/** 构造 Set-Cookie。HttpOnly + Secure + SameSite=Strict + Path=/api（契约硬要求）。 */
export function buildSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/api',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

/** 登出：Max-Age=0 清掉，其余属性保持一致（否则部分浏览器不认）。 */
export function buildClearCookie(): string {
  return [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=0'].join(
    '; ',
  );
}

function randomJti(): string {
  return randomBytes(12).toString('base64url');
}
