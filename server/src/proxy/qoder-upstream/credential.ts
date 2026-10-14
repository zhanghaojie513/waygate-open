/**
 * Qoder 提供商凭证（v0.6.0）。
 *
 * 存放：`<数据目录>/providers/<provider_id>.key` —— 与其它提供商**同一个凭证文件位**
 * （不发明第二套约定），内容是 JSON 字符串（token/refreshToken/uid/name/userType），
 * 控制台「提供商 → 填凭证」粘贴，或 `tools/qoder-import-credential.mjs` 从本机
 * Qoder 客户端登录态一键导入。
 *
 * 为什么不做自动刷新：刷新走网关 jobToken 的 needRefresh 路径会**轮换 refresh
 * token**，连带把用户桌面客户端里存的旧 drt- 顶掉（客户端被迫重新登录）。
 * 自用场景 dt- 有效期约 30 天 —— 过期后重新导入一次（一条命令）即可，代价远小于
 * 弄坏客户端登录态。
 *
 * 会话缓存：COSY 会话（cosyKey/info）与请求签名无关、按身份确定性构造，缓存到
 * 凭证文件 mtime 失效 —— 重新导入即换会话，无需重启。
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../store/db';
import { readTextFileCached } from '../../common/file-cache';
import { newCosySession, type CosySession, type QoderIdentity } from './cosy';

export class QoderCredentialError extends Error {}

interface CachedSession {
  mtimeMs: number;
  /** 已校验过形状的身份材料（与会话同生命周期，凭证文件变了一起失效） */
  identity: QoderIdentity;
  session: CosySession;
}

export class QoderCredentialStore {
  private readonly cache = new Map<string, CachedSession>();

  private credentialPath(providerId: string): string {
    return join(resolveDataDir(), 'providers', `${providerId}.key`);
  }

  /** 读身份材料并校验形状（缺字段 = 配置错误，明确报而不是半路炸）。 */
  load(providerId: string): QoderIdentity {
    let raw: string;
    try {
      // 按 mtime 缓存读：热路径不再每请求同步读文件（见 common/file-cache.ts）
      raw = readTextFileCached(this.credentialPath(providerId));
    } catch {
      throw new QoderCredentialError(
        `Qoder 凭证文件不存在或不可读：providers/${providerId}.key（控制台填凭证，或 tools/qoder-import-credential.mjs 导入）`,
      );
    }
    let parsed: Partial<QoderIdentity> & Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Partial<QoderIdentity>;
    } catch {
      throw new QoderCredentialError('Qoder 凭证不是合法 JSON（应为 {token,refreshToken,uid,name,userType}）');
    }
    for (const field of ['token', 'refreshToken', 'uid', 'name', 'userType'] as const) {
      if (typeof parsed[field] !== 'string' || !(parsed[field] as string).trim()) {
        throw new QoderCredentialError(`Qoder 凭证缺字段或非字符串：${field}`);
      }
    }
    return parsed as QoderIdentity;
  }

  /** COSY 会话（按凭证文件 mtime 缓存；重导入自动换新）。 */
  session(providerId: string): { identity: QoderIdentity; session: CosySession } {
    const path = this.credentialPath(providerId);
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      /* 文件不存在：交给 load() 抛出带指引的 QoderCredentialError */
    }
    // 性能：凭证未变时直接复用已校验的身份与会话，跳过读文件 + JSON 解析 + 字段校验
    const hit = this.cache.get(providerId);
    if (hit && mtimeMs !== null && hit.mtimeMs === mtimeMs) {
      return { identity: hit.identity, session: hit.session };
    }
    const identity = this.load(providerId);
    const fresh = statSync(path).mtimeMs; // load 已确保可读
    const session = newCosySession(identity);
    this.cache.set(providerId, { mtimeMs: fresh, identity, session });
    return { identity, session };
  }
}
