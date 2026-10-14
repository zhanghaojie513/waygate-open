/**
 * MiniMax OAuth 令牌服务（v0.5.0）：refresh token → access token 的按需刷新。
 *
 * 凭证布局（沿用 providers「表里不放秘密」的纪律）：
 *   · `<providersDir>/<id>.key`    refresh token（mmort_…，控制台录入，可能被轮换覆写）
 *   · `<providersDir>/<id>.access` access token（mmoat_…，本服务写入，0600）
 *   · providers.access_expires_at  过期时刻（epoch ms，非敏感，落表）
 *
 * 刷新端点与参数**逐字来自官方开源 CLI**（MiniMax-AI/minimax-code 的 oauth-core）：
 *   POST https://account.minimax.cn/oauth2/token  (form)
 *     grant_type=refresh_token & refresh_token=… & client_id=mcode-public
 *     & scope=agent.default & audience=agent-backend
 * 响应可能轮换 refresh_token（官方 parseTokenGrant 支持有/无两种形态）——轮换时
 * 覆写 .key 文件，避免旧 refresh token 失效后整个凭证报废。
 *
 * 并发语义：同一 provider 的刷新用 in-flight Promise 去重 —— 并发请求只触发一次
 * 刷新（access token 4h 有效，刷新窗口很宽，同时到期的 N 个请求只需一次往返）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFileCached } from '../../common/file-cache';
import { resolveDataDir } from '../../store/db';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { RelayHttpError } from '../../common/errors';

/** 提前刷新余量：过期前 120s 内的 token 视为不可用（时钟偏差 + 请求耗时）。 */
const REFRESH_MARGIN_MS = 120_000;
const MINIMAX_TOKEN_ENDPOINT = 'https://account.minimax.cn/oauth2/token';
const MINIMAX_OAUTH_FORM = {
  client_id: 'mcode-public',
  scope: 'agent.default',
  audience: 'agent-backend',
};

interface TokenGrant {
  access_token: string;
  refresh_token?: string;
  expires_at_ms?: number;
  expires_in?: number;
}

@Injectable()
export class MinimaxTokenService {
  private readonly logger = new Logger(MinimaxTokenService.name);
  private readonly providersDir = join(resolveDataDir(), 'providers');
  /** providerId → 进行中的刷新 Promise（并发去重）。 */
  private readonly inFlight = new Map<string, Promise<string>>();

  /* 显式 @Inject：esbuild/vitest 不产 design:paramtypes，类令牌注入必须写明（key.guard 的教训）。 */
  constructor(@Inject(ProvidersRepository) private readonly providers: ProvidersRepository) {}

  private keyPath(id: string): string {
    return join(this.providersDir, `${id}.key`);
  }
  private accessPath(id: string): string {
    return join(this.providersDir, `${id}.access`);
  }

  /**
   * 取可用 access token。未过期直接读文件；过期/缺失/临期则刷新。
   * 只对 cred_kind='oauth_minimax' 的提供商调用（协议层保证）。
   */
  async accessToken(provider: ProviderRow): Promise<string> {
    const cached = this.readCachedAccess(provider);
    if (cached !== null) return cached;
    const pending = this.inFlight.get(provider.id);
    if (pending) return pending;
    const job = this.refresh(provider).finally(() => this.inFlight.delete(provider.id));
    this.inFlight.set(provider.id, job);
    return job;
  }

  private readCachedAccess(provider: ProviderRow): string | null {
    const expiresAt = provider.access_expires_at ?? 0;
    if (Date.now() + REFRESH_MARGIN_MS >= expiresAt) return null;
    try {
      // 按 mtime 缓存：token 有效期内每个请求不再同步读 .access 文件；刷新覆写后 mtime 变化自动重读
      const token = readTextFileCached(this.accessPath(provider.id)).trim();
      return token.startsWith('mmoat_') ? token : null;
    } catch {
      return null;
    }
  }

  private async refresh(provider: ProviderRow): Promise<string> {
    const refreshToken = readFileSync(this.keyPath(provider.id), 'utf8').trim();
    if (!refreshToken.startsWith('mmort_')) {
      throw new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_credential_invalid',
        message: `提供商 ${provider.name} 的凭证不是有效的 MiniMax refresh token（应以 mmort_ 开头）。请在提供商设置里重新录入。`,
      });
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...MINIMAX_OAUTH_FORM,
    });
    let res: Response;
    try {
      res = await fetch(MINIMAX_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_unreachable',
        message: `刷新 MiniMax 令牌失败（account.minimax.cn 不可达）：${(err as Error).message}`,
      });
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_credential_invalid',
        message: `刷新 MiniMax 令牌被拒（HTTP ${res.status}）：${raw.slice(0, 200) || '无响应体'}。refresh token 可能已失效（在客户端重新登录后重新录入）。`,
      });
    }
    const grant = (await res.json().catch(() => null)) as TokenGrant | null;
    if (!grant || typeof grant.access_token !== 'string') {
      throw new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_credential_invalid',
        message: 'MiniMax 令牌刷新响应缺少 access_token。',
      });
    }

    /* 过期时刻：优先 expires_at_ms（epoch ms）；否则按 expires_in 秒推。都没有给个保守 1h。 */
    const expiresAt =
      typeof grant.expires_at_ms === 'number' && grant.expires_at_ms > Date.now()
        ? grant.expires_at_ms
        : typeof grant.expires_in === 'number' && grant.expires_in > 0
          ? Date.now() + (grant.expires_in > 100_000 ? grant.expires_in : grant.expires_in * 1000)
          : Date.now() + 3_600_000;

    this.writeAtomic(this.accessPath(provider.id), grant.access_token);
    /* 轮换：响应带了新 refresh token 就覆写 .key（旧的可能已作废）。 */
    if (typeof grant.refresh_token === 'string' && grant.refresh_token.startsWith('mmort_') && grant.refresh_token !== refreshToken) {
      this.writeAtomic(this.keyPath(provider.id), grant.refresh_token);
      this.logger.log(`提供商 ${provider.name} 的 MiniMax refresh token 已轮换并覆写`);
    }
    this.providers.setAccessExpiry(provider.id, expiresAt);
    this.logger.log(`MiniMax 令牌已刷新：provider=${provider.name} 过期于 ${new Date(expiresAt).toISOString()}`);
    return grant.access_token;
  }

  /** 与 providers.service 的凭证写法同款：tmp + 原子 rename，0600。 */
  private writeAtomic(path: string, content: string): void {
    mkdirSync(this.providersDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  /** 拿某个提供商的 refresh token 是否就位（控制台健康提示用）。 */
  hasRefreshToken(providerId: string): boolean {
    try {
      return readFileSync(this.keyPath(providerId), 'utf8').trim().startsWith('mmort_');
    } catch {
      return existsSync(this.keyPath(providerId)) === false ? false : false;
    }
  }

  /**
   * [v1.6.5] 作废已缓存的 access token —— **换 refresh token 后必须调用**。
   *
   * 为什么必须：`readCachedAccess` 先看 `providers.access_expires_at`，没过期就直接用
   * `.access` 文件里的旧令牌。若只换 `.key`（refresh token）而不动这两处，出站仍拿旧
   * access token —— 用户视角就是「改了凭证却没生效」。故换凭证时一并把过期时刻清零
   * 并删掉 `.access` 文件，强制下次用新 refresh token 换新。
   */
  invalidate(providerId: string): void {
    this.providers.setAccessExpiry(providerId, 0);
    try {
      unlinkSync(this.accessPath(providerId));
    } catch {
      /* 文件本就不存在：无需处理 */
    }
    this.logger.log(`已作废 ${providerId} 的缓存 access token（下次出站将用新 refresh token 换新）`);
  }
}
