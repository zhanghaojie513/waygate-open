/**
 * WorkBuddy OAuth 凭证生命周期（v1.4.0）。
 *
 * ## 双凭证架构
 * WorkBuddy 提供商有两把凭证，互不干扰：
 *   · `providers/<id>.key`（ck_）—— 转发/额度/签到状态查询（v1.2.5 起就有）；
 *   · `providers/<id>.oauth`（本服务管理，v1.4.0）—— 桌面端 OAuth，用于**领取域**
 *     （daily-checkin / growth 任务），那些端点对 ck_ 恒 403（上游原话
 *     "API key not allowed for this path or method"）。
 *
 * ## 凭证来源与导入
 * 从用户桌面端 auth 文件解密导出（tools/wb-oauth-export.mjs，借 workbuddy.exe 的
 * native binding 解 AES-GCM 信封），经 `POST /api/providers/:id/oauth-import` 落盘。
 * 文件形态：`{accessToken, refreshToken, uid, uin, domain, expiresAt}`（600 权限）。
 *
 * ## 会话语义（2026-10-13 生产实验实证）
 *   · refresh：`POST /v2/plugin/auth/token/refresh`，头 `X-Refresh-Token` +
 *     `X-Auth-Refresh-Source: plugin` + Common 头族（含按 uid 稳定派生的
 *     X-Machine-ID / X-Session-ID）；响应 `{data:{accessToken, refreshToken, expiresIn}}`，
 *     两 token 一起轮换（expiresIn 实测 2419200 = 28 天）。
 *   · **多会话共存，不互踢**：refresh 后旧 access 复打仍 200——用户桌面端与
 *     relay 的链可并存（与 MiniMax 的单会话模型根本不同）。写回本文件即可，无需通知桌面端。
 *
 * ## 与 MinimaxTokenService 的差异
 *   · 过期前刷新阈值：这里 **2 天**（access 28 天寿命，桌面端文件里的旧链也在滚动，
 *     多留余量；MiniMax 是 2 分钟因 access 只有 1 小时）。
 *   · 无互踢 ⇒ 失败可直接重试，无凭证竞争风险。
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { resolveDataDir } from '../../store/db';
import { stripTrailingSlash } from '../upstream-url';

/** OAuth 文件磁盘形态（导入时落盘；此后由本服务滚动维护）。 */
export interface WbOauthCredential {
  accessToken: string;
  refreshToken: string;
  uid: string;
  uin?: string;
  domain?: string;
  /** access 过期时刻（epoch ms）。 */
  expiresAt?: number;
  /** [v1.4.0] 设备风控 Token（X-Device-Token，可选保险丝）。实验实证三件套已通（2026-10-13
   * 全端点 200）；上游将来收紧 Turing Shield 指纹时，从桌面端取 token 写进导入 JSON 即生效。 */
  deviceToken?: string;
}

/** 过期前 2 天即刷新（access 寿命 28 天）。 */
export const WB_REFRESH_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const UA = 'WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1';
const ORIGIN = 'https://www.codebuddy.cn';

/** 按 uid 稳定派生的账号级设备头（HanawaBanana 实证形态：sha256("wb2a:purpose:uid") 前 36 hex）。 */
function deriveStableId(uid: string, purpose: 'machine' | 'session'): string {
  return createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36);
}

/** 出站 OAuth 请求头族（refresh 用 Common 形态；领取域调用方自行叠加 x-user-id 等）。 */
export function wbOauthHeaders(cred: WbOauthCredential, token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    'user-agent': UA,
    'x-codebuddy-request': '1',
    'accept-language': 'zh-CN',
    'x-machine-id': deriveStableId(cred.uid, 'machine'),
    'x-session-id': deriveStableId(cred.uid, 'session'),
    /* X-Device-Token 可选（保险丝，见 WbOauthCredential.deviceToken 注释）。 */
    ...(cred.deviceToken ? { 'x-device-token': cred.deviceToken } : {}),
    authorization: `Bearer ${token ?? cred.accessToken}`,
  };
}

@Injectable()
export class WbOauthService {
  private readonly logger = new Logger(WbOauthService.name);
  /** in-flight 去重：同 provider 并发取 token 只发一次刷新。 */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    /* autoStart 占位：与姊妹服务构造器形态对齐（本服务无定时器，刷新按需触发）。 */
    @Optional() _autoStart?: boolean,
  ) {}

  /** OAuth 槽文件路径。 */
  private file(id: string): string {
    return join(resolveDataDir(), 'providers', `${id}.oauth`);
  }

  /** 是否已导入 OAuth 凭证。 */
  configured(id: string): boolean {
    try {
      const c = JSON.parse(readFileSync(this.file(id), 'utf8')) as WbOauthCredential;
      return Boolean(c.accessToken && c.refreshToken && c.uid);
    } catch {
      return false;
    }
  }

  /** 面板状态（ProviderItem.wbOAuth；uid 打码展示）。 */
  statusOf(id: string): { configured: boolean; uidMask: string | null; expiresAt: number | null } {
    const c = this.read(id);
    if (!c) return { configured: false, uidMask: null, expiresAt: null };
    return { configured: true, uidMask: c.uid ? c.uid.slice(0, 8) + '…' : null, expiresAt: c.expiresAt ?? null };
  }

  /** 读 uid（领取域 X-User-Id 用；无凭证返回空串）。 */
  uidOf(id: string): string {
    return this.read(id)?.uid ?? '';
  }

  /** 凭证快照（只读不刷新；领取域出站头要用 uid/deviceToken 等完整字段）。 */
  credentialSnapshot(id: string): WbOauthCredential | null {
    return this.read(id);
  }

  /** 导入（覆盖式落盘，600 权限；入库过期时刻便于面板展示）。 */
  importCredential(provider: ProviderRow, payload: WbOauthCredential): void {
    if (!payload.accessToken || !payload.refreshToken || !payload.uid) {
      throw new Error('OAuth 导入需要 accessToken / refreshToken / uid 三个字段（用 tools/wb-oauth-export.mjs 导出）。');
    }
    const path = this.file(provider.id);
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...payload, expiresAt: payload.expiresAt ?? null }, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    if (payload.expiresAt) this.providers.setWbOAuthExpiry(provider.id, payload.expiresAt);
    this.logger.log(`已导入 WorkBuddy OAuth 凭证：${provider.name}（uid=${payload.uid.slice(0, 8)}…）`);
  }

  /** 删除 OAuth 槽（回到纯 ck_ 状态同步模式）。 */
  removeCredential(id: string): void {
    if (existsSync(this.file(id))) unlinkSync(this.file(id));
  }

  /**
   * 取可用 access token；临近过期（2 天内）先刷新。
   * 无凭证抛错（调用方回落 ck_ 路径）。
   */
  async accessToken(provider: ProviderRow): Promise<string> {
    const cred = this.read(provider.id);
    if (!cred) throw new Error('未导入 WorkBuddy OAuth 凭证');
    if (!cred.expiresAt || cred.expiresAt - WB_REFRESH_AHEAD_MS > Date.now()) {
      return cred.accessToken;
    }
    const existing = this.inFlight.get(provider.id);
    if (existing) return existing;
    const task = (async () => {
      const fresh = await this.refresh(provider, cred);
      return fresh.accessToken;
    })().finally(() => this.inFlight.delete(provider.id));
    this.inFlight.set(provider.id, task);
    return task;
  }

  /** 刷新一次并把新链原子写回（多会话共存：只写自己的槽，不影响桌面端）。 */
  private async refresh(provider: ProviderRow, cred: WbOauthCredential): Promise<WbOauthCredential> {
    const base = stripTrailingSlash(provider.base_url);
    const headers = wbOauthHeaders(cred);
    delete (headers as Record<string, string>).authorization;
    headers['x-refresh-token'] = cred.refreshToken;
    headers['x-auth-refresh-source'] = 'plugin';
    const res = await fetch(`${base}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OAuth 刷新 HTTP ${res.status}`);
    const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string } };
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(String(body.msg ?? `OAuth 刷新业务码 ${body.code}`));
    }
    const d = body.data ?? {};
    if (!d.accessToken || !d.refreshToken) throw new Error('OAuth 刷新响应缺 token（需重新导入）');
    const next: WbOauthCredential = {
      ...cred,
      accessToken: d.accessToken,
      refreshToken: d.refreshToken,
      domain: d.domain ?? cred.domain,
      expiresAt: d.expiresIn && d.expiresIn > 0 ? Date.now() + d.expiresIn * 1000 : undefined,
    };
    const path = this.file(provider.id);
    writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    if (next.expiresAt) this.providers.setWbOAuthExpiry(provider.id, next.expiresAt);
    this.logger.log(`WorkBuddy OAuth 已刷新：${provider.name}（下次到期 ${next.expiresAt ? new Date(next.expiresAt).toISOString().slice(0, 10) : '未知'}）`);
    return next;
  }

  private read(id: string): WbOauthCredential | null {
    try {
      const c = JSON.parse(readFileSync(this.file(id), 'utf8')) as WbOauthCredential;
      return c.accessToken && c.refreshToken && c.uid ? c : null;
    } catch {
      return null;
    }
  }
}
