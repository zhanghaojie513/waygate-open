/**
 * WorkBuddy OAuth 的**测试替身**（v1.6.11）。
 *
 * ## 为什么需要
 * v1.6.11 起 openai（WorkBuddy）转发凭证从 ck_ 改成 OAuth（`WbOauthService`）。
 * 一批既有 spec 按位置构造 `ProxyService`/`CatalogSyncService`，原本靠 `config.upstreamKey`
 * 提供凭证；改造后它们需要一个「已授权」的替身，否则一律走「未导入授权」的失败分支。
 *
 * ## 用法
 * ```ts
 * import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';
 * new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('token-xxx'));
 * ```
 * 默认 token 就是调用方原本塞在 `upstreamKey` 里的那把 —— 这样**既有断言
 * （"凭证到达上游"、"密钥不泄漏"）无需改写**，只有凭证来源变了。
 *
 * ⚠️ 替身只在测试里构造；生产路径永远用真的 `WbOauthService`（`@Optional` 注入）。
 */

import type { ProviderRow } from '../../store/repositories/providers.repo';
import type { WbOauthService, WbOauthCredential } from './wb-oauth.service';

/** 造一个「已授权」的 WbOauthService 替身：始终返回给定 token。 */
export function fakeWbOauth(token = 'oauth-token-test', uid = 'uid-test-0000'): WbOauthService {
  const snapshot: WbOauthCredential = {
    accessToken: token,
    refreshToken: 'refresh-test',
    uid,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  return {
    async accessToken(_provider: ProviderRow): Promise<string> {
      return token;
    },
    credentialSnapshot(_id: string): WbOauthCredential | null {
      return snapshot;
    },
    uidOf(_id: string): string {
      return uid;
    },
    configured(_id: string): boolean {
      return true;
    },
    statusOf(_id: string) {
      return { configured: true, uidMask: `${uid.slice(0, 8)}…`, expiresAt: snapshot.expiresAt ?? null };
    },
  } as unknown as WbOauthService;
}

/** 造一个「未授权」的替身：`accessToken` 抛错、`credentialSnapshot` 返回 null。 */
export function fakeWbOauthMissing(): WbOauthService {
  return {
    async accessToken(_provider: ProviderRow): Promise<string> {
      throw new Error('未导入 WorkBuddy OAuth 凭证');
    },
    credentialSnapshot(_id: string): WbOauthCredential | null {
      return null;
    },
    uidOf(): string {
      return '';
    },
    configured(): boolean {
      return false;
    },
    statusOf() {
      return { configured: false, uidMask: null, expiresAt: null };
    },
  } as unknown as WbOauthService;
}
