/**
 * 自定义提供商凭证（v1.7.0，protocol='custom'）。
 *
 * 存放：`<数据目录>/providers/<provider_id>.key` —— 与其它提供商**同一个凭证文件位**
 * （不发明第二套约定），内容是裸 API key 字符串（sk-… 等，形态随端点）。
 * 控制台「提供商管理 → 新增自定义 / 配置」写入。
 *
 * 静态 key 无生命周期：不刷新、不轮换（过期/换 key = 用户重新填一次）。
 * 读取走 common/file-cache 的 mtime 缓存 —— 与 openai/anthropic/qoder 同一条
 * 「热路径不做同步 IO」纪律。
 */

import { join } from 'node:path';
import { resolveDataDir } from '../../store/db';
import { readTextFileCached } from '../../common/file-cache';

export class CustomCredentialError extends Error {}

/** 读自定义提供商的 API key（trim 后非空保证；文件缺失/为空抛错，调用方转 502）。 */
export function readCustomApiKey(providerId: string): string {
  let raw: string;
  try {
    raw = readTextFileCached(join(resolveDataDir(), 'providers', `${providerId}.key`));
  } catch {
    throw new CustomCredentialError(
      `API Key 文件不存在：providers/${providerId}.key（到「提供商管理 → 配置」填写）`,
    );
  }
  const key = raw.trim();
  if (!key) {
    throw new CustomCredentialError(`API Key 为空：providers/${providerId}.key（到「提供商管理 → 配置」填写）`);
  }
  return key;
}
