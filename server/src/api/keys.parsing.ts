/**
 * `KeysService` 的**输入解析**（从 `keys.service.ts` 抽出，task#37 收尾）。
 *
 * 抽出的理由不是"文件太长"本身，而是这三条：
 *   1. 这两个函数是**纯函数**（输入 → 输出或抛 400），不碰任何依赖、不碰数据库，
 *      放在服务文件里会让人误以为它们需要 `this`；
 *   2. 它们是**校验边界**（`scope` / `expiresAt` 的形状与取值范围），
 *      单独成文件后可以独立单测，不必构造整个 `KeysService`；
 *   3. `keys.service.ts` 曾越过 300 行门禁（306），而门禁是**全仓约定**，
 *      留着唯一的例外等于把约定作废。
 *
 * 行为与抽出前**逐字一致**：错误码、错误文案、抛错时机都没有改动。
 */

import { RelayHttpError, ApiCode } from '../common/errors';
import { normalizeIpEntry } from '../common/ip-policy';
import type { KeyScope } from '../store/repositories/client-keys.repo';

/** 解析 `scope`：四态 `all / family / tag / models`，非法值一律 400。 */
export function normalizeScope(raw: unknown): KeyScope {
  if (!raw || typeof raw !== 'object') return { type: 'all' };
  const obj = raw as Record<string, unknown>;
  switch (obj.type) {
    case 'all':
      return { type: 'all' };
    case 'family':
    case 'tag': {
      const value = typeof obj.value === 'string' ? obj.value.trim() : '';
      if (!value) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: `scope.type=${obj.type} 时必须提供非空的 scope.value。`,
        });
      }
      return { type: obj.type, value };
    }
    case 'models': {
      const value = Array.isArray(obj.value)
        ? obj.value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        : [];
      if (value.length === 0) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: 'scope.type=models 时必须提供非空的 scope.value 字符串数组。',
        });
      }
      return { type: 'models', value };
    }
    default:
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'scope.type 只能是 all / family / tag / models 之一。',
      });
  }
}

/** `expiresAt` 接受 ISO 字符串或 null；过去的时间直接拒（建了就等于已过期）。 */
export function parseExpiresAt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: 'expiresAt 必须是 ISO 8601 字符串或 null。',
    });
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: `expiresAt 不是合法时间：${raw}`,
    });
  }
  if (ms <= Date.now()) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: 'expiresAt 必须是将来时间（过去时间等于建了一个立即失效的密钥）。',
    });
  }
  return ms;
}

/**
 * [v0.4.35] 解析 IP 白名单：字符串数组（逐条校验 IPv4/IPv6/CIDR，归一化后去重）。
 * 空数组 / null / undefined = 不限。非法条目 400 并点名 —— 白名单写错一个字
 * 就是「该放的没放进」，静默吞掉比报错危险。
 */
export function normalizeIpWhitelist(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: 'ipWhitelist 必须是字符串数组（IPv4/IPv6 地址或 IPv4 CIDR 网段）。',
    });
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'ipWhitelist 的每一项必须是字符串。',
      });
    }
    const norm = normalizeIpEntry(item);
    if (norm === null) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: `ipWhitelist 里有无法识别的条目：「${item}」。支持 IPv4（203.0.113.7）、IPv4 CIDR（203.0.113.0/24）、IPv6 精确（2001:db8::1）。`,
      });
    }
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * [v0.4.35] 解析正整数限额（maxIps / tokenQuota 共用）。
 * null / undefined / '' = 不限；必须是不超过 2^53 的正整数（token 配额可能很大）。
 */
export function parsePositiveLimit(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: `${field} 必须是正整数（留空 = 不限制）。`,
    });
  }
  return n;
}
