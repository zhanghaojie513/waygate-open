/**
 * 设备授权导入（v1.6.12）—— 控制台「导入」按钮的服务端。
 *
 * ## 解决什么
 * 三种客户端（WorkBuddy / MiniMax Code / Qoder CN）的凭证都不在用户手上，
 * 必须走各自的**官方授权**取得。此前控制台只能提示用户去终端跑 `wb login` /
 * `mmcode login` / `qoc login`；本服务把这件事搬进控制台：**选客户端 → 跳授权页 →
 * 回来即已导入**。
 *
 * ## 三家的授权机制各不相同（照抄必错，此处逐家实现）
 * | | 申请授权 | 轮询取票 | "未授权"信号 |
 * |---|---|---|---|
 * | WorkBuddy | `POST /v2/plugin/auth/state?platform=CLI` | `GET /v2/plugin/auth/token?state=` | **业务码非 0**（实测 11217 "login ing"） |
 * | MiniMax Code | `POST /oauth2/device/code`（**PKCE S256 强制**） | `POST /oauth2/token`（device_code grant） | **HTTP 400 + `authorization_pending`** |
 * | Qoder CN | `GET {base}/device/selectAccounts?challenge=&…`（PKCE S256） | `GET {openapi}/api/v1/deviceToken/poll` | **HTTP 404** |
 *
 * 参数与各自的官方 CLI 一致，因此拿到的令牌与转发链路天然兼容。
 *
 * ## 安全边界
 *   · `state`（device_code / code_verifier / state）只存服务端内存与 0600 文件，
 *     **绝不回传浏览器**（浏览器只需要 authUrl）。
 *   · 令牌落 `<数据目录>/providers/<id>.key`（0600），接口只回**摘要**（账号前缀）。
 *   · 授权会话有 TTL（各家不同），过期即清；不会无限挂着。
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../store/db';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { WbOauthService } from '../proxy/openai-upstream/wb-oauth.service';

/** 可导入的客户端种类（= 三种协议）。 */
export type ImportKind = 'openai' | 'anthropic' | 'qoder';

export interface ImportStartResult {
  ok: boolean;
  /** 浏览器要打开的授权页；用户确认后由前端 `window.open`。 */
  authUrl?: string;
  /** 展示给用户的短码（MiniMax/Qoder 有，WorkBuddy 无）。 */
  userCode?: string;
  /** 授权页给人的一句话（前端确认弹窗用）。 */
  hint?: string;
  /** 授权会话有效期（秒）—— 前端可据此显示倒计时/超时提示。 */
  expiresInSec?: number;
  message?: string;
}

export interface ImportPollResult {
  ok: boolean;
  /** pending = 尚未完成授权（前端继续轮询）；done = 已导入；error = 终止性失败。 */
  status: 'pending' | 'done' | 'error';
  /** 导入成功后的脱敏摘要（账号前缀）。 */
  summary?: string;
  message?: string;
}

/** 默认参数（与各家官方 CLI 对齐，见文件头表格）。 */
const WB_BASE = 'https://copilot.tencent.com';
const WB_ORIGIN = 'https://www.codebuddy.cn';
const WB_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const MM_ACCOUNT = 'https://account.minimax.cn';
const MM_CLIENT_ID = 'mcode-public';
const MM_SCOPE = 'agent.default';
const MM_AUDIENCE = 'agent-backend';
const QODER_BASE = 'https://qoder.cn';
const QODER_OPENAPI = 'https://openapi.qoder.com.cn';
const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

const REQUEST_TIMEOUT_MS = 20_000;
/** 授权会话 TTL（各家设备码有效期都在 5 分钟左右，统一取 5 分钟）。 */
const SESSION_TTL_MS = 5 * 60 * 1000;

interface PendingSession {
  kind: ImportKind;
  /** 服务端私有状态：device_code / code_verifier / state / machine_id —— **不回传浏览器**。 */
  deviceCode?: string;
  codeVerifier?: string;
  nonce?: string;
  state?: string;
  machineId?: string;
  expiresAt: number;
}

@Injectable()
export class DeviceImportService {
  private readonly logger = new Logger(DeviceImportService.name);
  /** 待完成的授权会话（providerId → 私有状态）。进程内存即可：授权本就是短时交互。 */
  private readonly pending = new Map<string, PendingSession>();

  constructor(
    private readonly providers: ProvidersRepository,
    private readonly wbOauth: WbOauthService,
  ) {}

  private providersDir(): string {
    return join(resolveDataDir(), 'providers');
  }

  private writeCredential(providerId: string, content: string): void {
    const dir = this.providersDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${providerId}.key`);
    /* 临时文件 + rename 原子替换（与 providers.service 同一纪律）。 */
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* Windows 语义有限 */
    }
    renameSync(tmp, path);
  }

  /** 清理过期会话（每次调用顺带做，避免无限增长）。 */
  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.pending) {
      if (s.expiresAt <= now) this.pending.delete(id);
    }
  }

  /**
   * 第 ① 步：申请授权，返回浏览器要打开的地址。
   * 私有状态（device_code 等）存服务端，**不返回给浏览器**。
   */
  async start(providerId: string, kind: ImportKind): Promise<ImportStartResult> {
    this.sweep();
    try {
      if (kind === 'openai') return await this.startWorkBuddy(providerId);
      if (kind === 'anthropic') return await this.startMiniMax(providerId);
      if (kind === 'qoder') return await this.startQoder(providerId);
      return { ok: false, message: `不支持的客户端类型：${kind}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * 第 ② 步：轮询取票。`pending` 表示用户还没完成授权（前端继续轮询）。
   * 成功后**立刻落盘凭证**并把会话清掉。
   */
  async poll(providerId: string, kind: ImportKind): Promise<ImportPollResult> {
    this.sweep();
    const session = this.pending.get(providerId);
    if (!session) {
      return { ok: false, status: 'error', message: '没有进行中的授权（可能已超时）—— 请重新发起导入。' };
    }
    try {
      if (kind === 'openai') return await this.pollWorkBuddy(providerId, session);
      if (kind === 'anthropic') return await this.pollMiniMax(providerId, session);
      if (kind === 'qoder') return await this.pollQoder(providerId, session);
      return { ok: false, status: 'error', message: `不支持的客户端类型：${kind}` };
    } catch (err) {
      this.pending.delete(providerId);
      return { ok: false, status: 'error', message: (err as Error).message };
    }
  }

  /* ───────────────────────── WorkBuddy ───────────────────────── */

  /** 服务端私有：WB 无需 PKCE，服务端签发 `state` 后凭它取票。 */
  private async startWorkBuddy(providerId: string): Promise<ImportStartResult> {
    const res = await fetch(`${WB_BASE}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: this.wbHeaders(),
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { state?: string; authUrl?: string } };
    const state = body.data?.state;
    const authUrl = body.data?.authUrl;
    if (!res.ok || !state || !authUrl) {
      return { ok: false, message: `WorkBuddy 授权申请失败（HTTP ${res.status}）：未见 state/authUrl` };
    }
    this.pending.set(providerId, { kind: 'openai', state, expiresAt: Date.now() + SESSION_TTL_MS });
    return {
      ok: true,
      authUrl,
      hint: '请在打开的页面用 WorkBuddy 账号登录',
      expiresInSec: SESSION_TTL_MS / 1000,
    };
  }

  private async pollWorkBuddy(providerId: string, s: PendingSession): Promise<ImportPollResult> {
    const res = await fetch(`${WB_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(s.state!)}`, {
      headers: this.wbHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      data?: { accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string };
    };
    /* ★ 未完成授权时上游返回**业务码非 0**（实测 11217 "login ing"）—— 不是 HTTP 错误。 */
    if (!res.ok) return { ok: false, status: 'error', message: `取票失败（HTTP ${res.status}）：${body.msg ?? ''}` };
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: true, status: 'pending', message: body.msg };
    }
    const tok = body.data ?? {};
    if (!tok.accessToken) return { ok: false, status: 'error', message: '取票响应缺少 accessToken' };

    /* 账号信息是锦上添花（拿不到不阻断）。 */
    let uid = '';
    let nickname: string | undefined;
    try {
      const acctRes = await fetch(`${WB_BASE}/v2/plugin/login/account?state=${encodeURIComponent(s.state!)}`, {
        headers: this.wbHeaders(tok.accessToken),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const acct = (await acctRes.json().catch(() => ({}))) as { data?: { uid?: string; nickname?: string } };
      uid = acct.data?.uid ?? '';
      nickname = acct.data?.nickname;
    } catch {
      /* ignore */
    }
    if (!uid) return { ok: false, status: 'error', message: '未能取到账号 uid —— 请重试导入' };

    const credential = {
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken ?? '',
      uid,
      ...(nickname ? { nickname } : {}),
      ...(tok.domain ? { domain: tok.domain } : {}),
      expiresAt: typeof tok.expiresIn === 'number' && tok.expiresIn > 0 ? Date.now() + tok.expiresIn * 1000 : undefined,
    };
    /* [v1.6.11] WorkBuddy 落 **.oauth 槽**（不是 .key）—— ck_ 已退役，
       转发与领取域统一走 OAuth（WbOauthService 维护刷新）。 */
    const row = this.providers.findById(providerId);
    if (!row) return { ok: false, status: 'error', message: '提供商不存在（可能已被删除）。' };
    this.wbOauth.importCredential(row, credential);
    this.pending.delete(providerId);
    this.logger.log(`WorkBuddy 授权已导入：${providerId}（uid=${uid.slice(0, 8)}…）`);
    return { ok: true, status: 'done', summary: nickname ? `${nickname}` : `uid ${uid.slice(0, 8)}…` };
  }

  /** WB 出站头（allowlist 思路：只带官方客户端必带的几个）。 */
  private wbHeaders(token?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      origin: WB_ORIGIN,
      referer: `${WB_ORIGIN}/`,
      'user-agent': WB_UA,
      'accept-language': 'zh-CN',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /* ──────────────────────── MiniMax Code ──────────────────────── */

  /**
   * MiniMax：标准 RFC 8628 设备授权 + **PKCE S256（强制）**。
   * 实测缺 `code_challenge` 直接 400「valid S256 PKCE is required」。
   */
  private async startMiniMax(providerId: string): Promise<ImportStartResult> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const form = new URLSearchParams({
      client_id: MM_CLIENT_ID,
      scope: MM_SCOPE,
      audience: MM_AUDIENCE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${MM_ACCOUNT}/oauth2/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, message: `MiniMax 设备码申请失败（HTTP ${res.status}）：${String(body.error_description ?? body.error ?? '')}` };
    }
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    const userCode = typeof body.user_code === 'string' ? body.user_code : '';
    const uri = typeof body.verification_uri_complete === 'string' && body.verification_uri_complete
      ? body.verification_uri_complete
      : typeof body.verification_uri === 'string' ? body.verification_uri : '';
    if (!deviceCode || !uri) return { ok: false, message: 'MiniMax 设备码响应缺少 device_code / verification_uri' };

    this.pending.set(providerId, {
      kind: 'anthropic',
      deviceCode,
      codeVerifier,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return {
      ok: true,
      authUrl: uri,
      ...(userCode ? { userCode } : {}),
      hint: '请在打开的页面用 MiniMax 账号完成授权',
      expiresInSec: SESSION_TTL_MS / 1000,
    };
  }

  private async pollMiniMax(providerId: string, s: PendingSession): Promise<ImportPollResult> {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: s.deviceCode!,
      client_id: MM_CLIENT_ID,
      code_verifier: s.codeVerifier!,
    });
    const res = await fetch(`${MM_ACCOUNT}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await res.text().catch(() => '');
    const body = (JSON.parse(raw || '{}') as Record<string, unknown>);
    /* ★ 未授权时是 **HTTP 400 + error=authorization_pending**（实测）—— 不是失败。 */
    const signal = String(body.error ?? body.status ?? '').toLowerCase();
    if (signal === 'authorization_pending' || signal === 'pending') return { ok: true, status: 'pending' };
    if (signal === 'slow_down') return { ok: true, status: 'pending', message: '上游要求放慢轮询' };
    if (signal === 'access_denied' || signal === 'denied') {
      this.pending.delete(providerId);
      return { ok: false, status: 'error', message: '你在授权页拒绝了本次授权' };
    }
    if (signal === 'expired_token') {
      this.pending.delete(providerId);
      return { ok: false, status: 'error', message: '设备码已过期 —— 请重新发起导入' };
    }
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    if (!accessToken) {
      return { ok: false, status: 'error', message: `取票失败（HTTP ${res.status}）：${String(body.error_description ?? body.error ?? '').slice(0, 160)}` };
    }
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) {
      return { ok: false, status: 'error', message: '取票成功但未返回 refresh_token —— 无法长期续期，请重试' };
    }
    /* MiniMax 存的是 **refresh token**（服务端自己换 access，见 minimax-token.service）。 */
    this.writeCredential(providerId, refreshToken.trim());
    this.pending.delete(providerId);
    this.logger.log(`MiniMax 凭证已导入：${providerId}`);
    return { ok: true, status: 'done', summary: 'refresh token 已落盘（服务端自动续期）' };
  }

  /* ───────────────────────── Qoder CN ───────────────────────── */

  /** Qoder：官方 CLI 的浏览器设备授权（PKCE S256 + machine_id）。 */
  private async startQoder(providerId: string): Promise<ImportStartResult> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const nonce = randomUUID();
    /* machine_id 用 providerId 派生 —— 稳定（随机会被上游当异常设备）。 */
    const machineId = `waygate-${createHash('sha256').update(providerId).digest('hex').slice(0, 32)}`;

    const qs = new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      nonce,
      machine_id: machineId,
      client_id: QODER_CLIENT_ID,
    });
    const authUrl = `${QODER_BASE}/device/selectAccounts?${qs.toString()}`;
    this.pending.set(providerId, {
      kind: 'qoder',
      codeVerifier,
      nonce,
      machineId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return {
      ok: true,
      authUrl,
      hint: '请在打开的页面选择你的 Qoder 账号完成授权',
      expiresInSec: SESSION_TTL_MS / 1000,
    };
  }

  private async pollQoder(providerId: string, s: PendingSession): Promise<ImportPollResult> {
    const qs = new URLSearchParams({
      nonce: s.nonce!,
      verifier: s.codeVerifier!,
      challenge_method: 'S256',
    });
    const res = await fetch(`${QODER_OPENAPI}/api/v1/deviceToken/poll?${qs.toString()}`, {
      headers: { accept: 'application/json', 'user-agent': 'qoder/waygate' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    /* ★ 未授权时是 **HTTP 404**（实测；官方 CLI 亦以 404 判"继续等"）—— 不是失败。 */
    if (res.status === 404) return { ok: true, status: 'pending' };

    const raw = await res.text().catch(() => '');
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, status: 'error', message: `轮询失败（HTTP ${res.status}）：${String(body.errorMessage ?? '').slice(0, 160)}` };
    }
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) return { ok: true, status: 'pending' };
    const uid = typeof body.user_id === 'string' ? body.user_id : '';
    if (!uid) return { ok: false, status: 'error', message: '取票成功但缺 user_id —— 无法组装 COSY 身份' };

    /* Qoder 存的是身份 JSON（COSY 身份块要 token/refreshToken/uid/name/userType）。 */
    const identity = {
      token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
      uid,
      name: typeof body.user_name === 'string' && body.user_name ? body.user_name : 'qoder-user',
      userType: 'personal_standard',
    };
    this.writeCredential(providerId, JSON.stringify(identity, null, 2) + '\n');
    this.pending.delete(providerId);
    this.logger.log(`Qoder 凭证已导入：${providerId}（uid=${uid.slice(0, 8)}…）`);
    return { ok: true, status: 'done', summary: `uid ${uid.slice(0, 8)}…` };
  }

  /** 供 doctor / 前端展示：当前是否有进行中的授权。 */
  hasPending(providerId: string): boolean {
    this.sweep();
    return this.pending.has(providerId);
  }

  /** 取消授权（前端关闭弹窗时调用，释放内存）。 */
  cancel(providerId: string): void {
    this.pending.delete(providerId);
  }

  /** 只在测试/诊断用：凭证文件是否存在。 */
  credentialExists(providerId: string): boolean {
    return existsSync(join(this.providersDir(), `${providerId}.key`));
  }

  /** 读回落盘的凭证（仅内部诊断用；绝不经 API 回传浏览器）。 */
  readCredentialRaw(providerId: string): string | null {
    try {
      return readFileSync(join(this.providersDir(), `${providerId}.key`), 'utf8');
    } catch {
      return null;
    }
  }
}
