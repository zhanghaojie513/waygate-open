import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** base64url 编码（无填充字符，URL 与 cookie 安全）。 */
export function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

/** HMAC-SHA256(secret, data) 的 base64url 结果。用于 key_hash 与会话签名。 */
export function hmacBase64Url(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 长度不等时返回 false，相等时用 timingSafeEqual，不做短路。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
