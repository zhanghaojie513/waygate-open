/**
 * 管理口令的**校验策略**（api-contract §3.1.4）。
 *
 * 单独成文件的原因：校验规则（长度上下限、纯空白拒绝、错误措辞）是
 * 「用户自定义口令」这一条路径的**独立关注点**，与「哈希怎么存、落库优先级」
 * 无关。抽出来让 `admin-credential.service.ts` 专注于装载/轮换，
 * 也让这条策略能被单独阅读与修改而不牵动哈希逻辑。
 */

import { RelayHttpError, ApiCode } from '../../common/errors';

/**
 * 自定义口令的长度边界。
 *
 * 下限 8：这是控制台的**唯一**入口凭据，不设下限等于允许空口令 ——
 * 一旦为空，`isConfigured()` 仍为 true（哈希非空），却能被空串登录通过。
 *
 * 上限 128：scrypt 是 CPU 密集的，且 `hashPassword`/`verifyPassword` 把整个
 * 口令读进内存 —— 超长输入（比如 1MB 字符串）会被同步 scrypt 放大成一次
 * 可观的 CPU 占用，成为一条廉价的 DoS 面。128 对「方便记忆的口令」绰绰有余。
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 8;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

/** 构造一个 400/40001 的「参数不合格」错误（message 指明具体问题）。 */
export function badAdminPassword(message: string): RelayHttpError {
  return new RelayHttpError({
    httpStatus: 400,
    code: 'invalid_request_body',
    apiCode: ApiCode.BAD_PARAM,
    message,
  });
}

/**
 * 校验用户输入的口令，返回**用于哈希的原串**（不 trim —— 用户可能刻意带空格）。
 *
 * 不合格时抛 `RelayHttpError`（400/40001），message 用中文说明**具体哪里不对**：
 *   - 非字符串 → 提示提供字符串
 *   - 纯空白   → 拒绝（否则等于允许一个「看不见的」空口令）
 *   - 短于下限 → 带上当前长度（如「至少 8 个字符，当前 7 个」）
 *   - 长于上限 → 带上当前长度
 *
 * 为什么用 trim 后的长度做判断、却存原串：全是空格/制表/换行的输入 = 空口令，
 * 必须拒；但一旦通过校验，存的就是用户原样输入（避免「我设了带空格的密码
 * 但登录时被吃掉」这种意外）。
 */
export function validateAdminPassword(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw badAdminPassword('请提供一个字符串形式的管理口令。');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw badAdminPassword('管理口令不能为空或纯空白。');
  }
  if (trimmed.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw badAdminPassword(
      `管理口令至少 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符，当前 ${trimmed.length} 个。`,
    );
  }
  if (raw.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw badAdminPassword(
      `管理口令最多 ${ADMIN_PASSWORD_MAX_LENGTH} 个字符，当前 ${raw.length} 个。`,
    );
  }
  return raw;
}
