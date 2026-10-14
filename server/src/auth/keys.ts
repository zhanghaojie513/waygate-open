import { hmacBase64Url, randomHex, safeEqual } from '../common/crypto';
import { buildKeyHint } from '../common/mask';
import type { ClientKeyRow, KeyScope } from '../store/repositories/client-keys.repo';
import { parseScope } from '../store/repositories/client-keys.repo';

/**
 * 本机入站密钥（`sk-waygate-`）的纯函数层。
 *
 * 安全铁律（api-contract §1.1 / §1.2）：
 *   1. 库里只存 hash（`key_hash`），明文只在创建时返回一次，绝不落盘。
 *   2. hash = base64url(HMAC_SHA256(RELAY_SECRET, 完整明文密钥))。
 *      用 HMAC 而非裸 SHA256：库文件泄漏时，没有 RELAY_SECRET 也做不了离线撞库。
 *   3. 对外错误一律笼统：不区分「密钥不存在 / 已停用 / 已过期」，
 *      否则等于告诉攻击者「这个密钥是存在的」，把爆破从随机猜测变成定向确认。
 *      三者只写进服务端日志。
 *
 * 前缀更名（2026-10-11，产品由 relay-station 更名 Waygate）：`sk-relay-` → `sk-waygate-`。
 *
 * ⚠️ **更名期已结束**（2026-10-11 晚）：存量密钥全部重签完毕、库里已无 `sk-relay-` 行，
 * 故旧前缀**不再被接受** —— `KEY_PATTERN` 只认新前缀。
 *
 * 为什么必须走"重签"而不是"改前缀"：前缀参与哈希（`hashKey` 的入参是**完整明文**），
 * 库里只有 hash、明文只在客户端手里 —— 服务端无法把一把旧前缀密钥改名后仍然可用。
 * 因此更名期的做法曾是「新旧前缀都收」给用户留出逐个替换客户端的窗口；
 * 窗口关闭后收窄到只认新前缀，旧前缀请求在形态检查阶段即被拒（不查库）。
 * 若将来还要更名，按同样两步走：先并存接受、待全部重签后再收窄。
 */

export const KEY_PREFIX = 'sk-waygate-';

/** 前缀位数会变（9 → 11），故不可再写死总长；随机段固定 24 位十六进制。 */
const KEY_HEX_BYTES = 12;

/** 24 位小写十六进制随机段的正则（不含前缀）。 */
export const KEY_BODY_PATTERN = /^[0-9a-f]{24}$/;
/** 完整密钥形态：`sk-waygate-` + 24 位小写十六进制（总长 35）。 */
export const KEY_PATTERN = new RegExp(`^${KEY_PREFIX}[0-9a-f]{24}$`);

/** 命中的前缀（掩码等需保留原前缀的场合用）；不匹配则 null。 */
export function keyPrefixOf(value: string): string | null {
  return value.startsWith(KEY_PREFIX) ? KEY_PREFIX : null;
}

/** 有 Key 形态但无有效前缀/长度时快速拒绝，不查库（api-contract §1.2 第 2 步）。 */
export function looksLikeRelayKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** key_hash = base64url(HMAC-SHA256(secret, 明文密钥))。 */
export function hashKey(secret: string, plain: string): string {
  return hmacBase64Url(secret, plain);
}

export interface GeneratedKey {
  /** 完整明文，只在创建响应里回显一次。 */
  plain: string;
  /** `sk-waygate-4f9c…7a2e` —— 可供日志/列表渲染的遮蔽形态。 */
  hint: string;
  /** 由调用方用其持有的 secret 计算 hash，避免本函数依赖 secret。 */
  hashFactory: (secret: string) => string;
}

/** 生成新密钥：`sk-waygate-` + `randomHex(12)`（24 位小写十六进制）。 */
export function generateKey(): GeneratedKey {
  const plain = `${KEY_PREFIX}${randomHex(KEY_HEX_BYTES)}`;
  return {
    plain,
    hint: buildKeyHint(plain),
    hashFactory: (secret: string) => hashKey(secret, plain),
  };
}

export type KeyFailureReason = 'unknown' | 'disabled' | 'expired';

export type KeyValidation = { ok: true; scope: KeyScope } | { ok: false; reason: KeyFailureReason };

/**
 * 校验一个明文密钥是否可用。
 *
 * 顺序固定：先比 hash（timing-safe），再判 enabled，最后判 expires_at。
 * `row` 由调用方按 hash 从库里查出；为 null 视为 unknown。
 *
 * ⚠️ 返回的 `reason` 仅供服务端日志，**禁止**回给客户端（见文件头第 3 条）。
 */
export function validateKey(
  secret: string,
  plain: string,
  row: ClientKeyRow | null | undefined,
): KeyValidation {
  if (!row) return { ok: false, reason: 'unknown' };
  // 双保险：即便调用方查错了行，hash 不一致也一律按 unknown 处理，不泄漏行是否存在
  if (!safeEqual(row.key_hash, hashKey(secret, plain))) {
    return { ok: false, reason: 'unknown' };
  }
  if (row.enabled !== 1) return { ok: false, reason: 'disabled' };
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, scope: parseScope(row.scope) };
}

/**
 * 对外统一文案（api-contract §1.2 的失败响应形状）。
 * disabled / expired / unknown 三种原因返回同一句话，不给出区分线索。
 */
export const KEY_REJECT_MESSAGE =
  'Invalid API key provided. 请检查密钥是否有效、是否被停用或已过期。';
