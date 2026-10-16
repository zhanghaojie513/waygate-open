/**
 * 控制台端点清单（design/api-contract.md §3 / openapi.yaml）。
 * 页面只调这一层，不直接 fetch —— 换后端地址、换 Mock 都只改这里。
 */

import type { ProviderSigninPanel,
  AdminPasswordResetResult,
  AdminPasswordSetResult,
  CatalogData,
  CatalogRefreshResult,
  ClientKeyRow,
  ClientRow,
  CreatedKey,
  CreateKeyInput,
  CredentialTestResult,
  CredentialUpdateResult,
  DangerAction,
  DangerResult,
  LoginResult,
  ModelEnabledResult,
  OverviewData,
  ProviderItem,
  GrowthRunResult,
  GrowthPanelResult,
  ProviderUsageRow,
  PutSettingsResult,
  RequestDetail,
  RequestLogRow,
  SessionState,
  SettingsData,
  SettingPatch,
  TimeWindow,
} from '../types/api';
import { MOCKS_ENABLED, apiRequest, apiRequestGuarded, buildQuery } from './http';
import { patchResourceCache } from '../hooks/useResource';
import { mockApi } from '../mocks/api';

export interface RequestQuery {
  page: number;
  limit: number;
  status?: string;
  /**
   * 客户端过滤键 —— **一定是 `clientId`，不是显示名**（`spec-v4-client-id.md` §5）。
   * 传名字的话，改一次名这个筛选就静默失配（AC-C06）。
   */
  clientId?: string;
  model?: string;
  q?: string;
  sort?: 'ts' | 'ms' | 'credits';
  order?: 'asc' | 'desc';
  /** 游标：上一页响应的 nextCursor。带上它时服务端按 (ts,id) 续接，忽略 OFFSET。 */
  cursor?: string;
}

export interface RequestPage {
  items: RequestLogRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** 下一页游标（仅按时间排序时有；mock 不提供 → 前端回落按页码取）。 */
  nextCursor?: string | null;
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export const api = {
  /** 首屏判断登录态。未登录返回 authenticated:false，不返回 401。 */
  session(): Promise<SessionState> {
    if (MOCKS_ENABLED) return mockApi.session();
    return apiRequest<SessionState>('/api/auth/session');
  },

  login(password: string): Promise<LoginResult> {
    if (MOCKS_ENABLED) return mockApi.login(password);
    return apiRequest<LoginResult>('/api/auth/login', jsonBody({ password }));
  },

  logout(): Promise<void> {
    if (MOCKS_ENABLED) return mockApi.logout();
    return apiRequest<void>('/api/auth/logout', { method: 'POST' });
  },

  overview(window: TimeWindow): Promise<OverviewData> {
    if (MOCKS_ENABLED) return mockApi.overview(window);
    return apiRequestGuarded<OverviewData>(`/api/overview${buildQuery({ window })}`);
  },

  clients(window: TimeWindow): Promise<{ items: ClientRow[]; byProvider: ProviderUsageRow[] }> {
    if (MOCKS_ENABLED) {
      return Promise.all([mockApi.clients(window), mockApi.clientsByProvider()]).then(([items, byProvider]) => ({ items, byProvider }));
    }
    return apiRequestGuarded<{ items: ClientRow[]; byProvider: ProviderUsageRow[] }>(`/api/clients${buildQuery({ window })}`);
  },

  requests(query: RequestQuery): Promise<RequestPage> {
    if (MOCKS_ENABLED) return mockApi.requests(query);
    return apiRequestGuarded<RequestPage>(`/api/requests${buildQuery({ ...query })}`);
  },

  requestDetail(id: number): Promise<RequestDetail> {
    if (MOCKS_ENABLED) return mockApi.requestDetail(id);
    return apiRequestGuarded<RequestDetail>(`/api/requests/${id}`);
  },

  keys(): Promise<ClientKeyRow[]> {
    if (MOCKS_ENABLED) return mockApi.keys();
    return apiRequestGuarded<{ items: ClientKeyRow[] }>('/api/keys').then((d) => d.items);
  },

  createKey(input: CreateKeyInput): Promise<CreatedKey> {
    if (MOCKS_ENABLED) return mockApi.createKey(input);
    return apiRequestGuarded<CreatedKey>('/api/keys', jsonBody(input));
  },

  /** [v0.4.20] `clients` 数组优先（多选 + 优先级）；`client` 保留兼容单值。
   *  [v0.4.35] 访问策略三字段可改：ipWhitelist / maxIps / tokenQuota（null/[] = 解除）。 */
  patchKey(
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      client?: string | null;
      clients?: string[];
      ipWhitelist?: string[];
      maxIps?: number | null;
      tokenQuota?: number | null;
    },
  ): Promise<ClientKeyRow> {
    if (MOCKS_ENABLED) return mockApi.patchKey(id, patch);
    return apiRequestGuarded<ClientKeyRow>(`/api/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deleteKey(id: string): Promise<{ deleted: number }> {
    if (MOCKS_ENABLED) return mockApi.deleteKey(id);
    return apiRequestGuarded<{ deleted: number }>(`/api/keys/${id}`, { method: 'DELETE' });
  },

  settings(): Promise<SettingsData> {
    if (MOCKS_ENABLED) return mockApi.settings();
    return apiRequestGuarded<SettingsData>('/api/settings');
  },

  putSettings(patches: SettingPatch[]): Promise<PutSettingsResult> {
    const send = (): Promise<PutSettingsResult> =>
      MOCKS_ENABLED
        ? mockApi.putSettings(patches)
        : apiRequestGuarded<PutSettingsResult>('/api/settings', {
            method: 'PUT',
            body: JSON.stringify({ settings: patches }),
          });
    return send().then((result) => {
      /* 写穿：成功即修正 'settings' 缓存（挂载渲染旧值的最后一类来源）。
         putSettings 的语义就是「这些键=这些值」，成功后缓存里同键必然过时；
         在这里做而不是各调用点做 —— 三个页面共用这一个咽喉点，一处写穿处处生效。 */
      patchResourceCache<SettingsData>('settings', (cached) => ({
        ...cached,
        version: result.version,
        groups: cached.groups.map((g) => ({
          ...g,
          items: g.items.map((it) => {
            const hit = patches.find((p) => p.key === it.key);
            return hit ? { ...it, value: hit.value } : it;
          }),
        })),
      }));
      return result;
    });
  },

  danger(action: DangerAction, confirm: string): Promise<DangerResult> {
    if (MOCKS_ENABLED) return mockApi.danger(action, confirm);
    return apiRequestGuarded<DangerResult>('/api/settings/danger', jsonBody({ action, confirm }));
  },

  /**
   * 写入上游访问密钥（api-contract §3.8.1）。
   *
   * 与 `putSettings` 分开是**契约要求**：`credential.source` 在 settings 里是
   * `readonly:true` 的只读展示项，服务端为它单开了这条只写端点，不走通用 PUT。
   */
  putCredential(key: string): Promise<CredentialUpdateResult> {
    if (MOCKS_ENABLED) return mockApi.putCredential(key);
    return apiRequestGuarded<CredentialUpdateResult>('/api/settings/credential', {
      method: 'PUT',
      body: JSON.stringify({ key }),
    });
  },

  /**
   * 重置管理口令（api-contract §3.1.3）。
   *
   * ## 三个刻意的设计约束
   *
   * ① **不接受请求体** —— 新口令由服务端随机生成。让用户自己填口令会让
   *    「弱口令」变成产品责任，而随机 16 字符（去掉易混字符）强得多。
   * ② **必须先登录** —— 端点挂在 `SessionGuard` 后面。否则任何人猜到端点
   *    就能改密，等于把管理员锁在门外。
   * ③ **走 `apiRequestGuarded`** —— 与其它控制台端点同一条通道，带 CSRF
   *    同源校验与会话失效兜底（401 自动跳登录页）。
   *
   * 返回的 `password` 明文只此一次，调用方用完即弃。
   */
  resetAdminPassword(): Promise<AdminPasswordResetResult> {
    if (MOCKS_ENABLED) return mockApi.resetAdminPassword();
    return apiRequestGuarded<AdminPasswordResetResult>('/api/auth/password/reset', {
      method: 'POST',
    });
  },

  /**
   * **手动设定**管理口令（api-contract §3.1.4）。
   *
   * 与 `resetAdminPassword` 的分工：
   *   - reset：服务端生成随机口令，**回显**一次明文；
   *   - 本条：用户自己输入并记忆，服务端**不回显** —— 他本就知道明文。
   *
   * 明文只经请求体单向传给服务端，**绝不写入 localStorage / URL / 任何持久化位置**。
   * 校验（≥8 字符）前端先做一遍，服务端还会再做一遍（前端校验只是体验，不是安全边界）。
   */
  setAdminPassword(password: string): Promise<AdminPasswordSetResult> {
    if (MOCKS_ENABLED) return mockApi.setAdminPassword(password);
    return apiRequestGuarded<AdminPasswordSetResult>('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });
  },

  /** [v0.5.4] provider 给定时只取该提供商自己的分区（各自维护清单的视图）。 */
  catalog(provider?: string): Promise<CatalogData> {
    if (MOCKS_ENABLED) return mockApi.catalog();
    return apiRequestGuarded<CatalogData>(`/api/models/catalog${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`);
  },

  /**
   * 向上游拉取模型清单并逐项实测。
   *
   * [注意] 这是**有代价**的动作：会真打上游、每个模型消耗 1 token，服务端还有
   * 60 秒冷却（同一分钟内只生效一次，重复调用回 429 并带 retryAfterSeconds）。
   * 所以界面上必须做成显式点击，且失败原因要原样透传给用户。
   */
  refreshCatalog(): Promise<CatalogRefreshResult> {
    if (MOCKS_ENABLED) return mockApi.refreshCatalog();
    return apiRequestGuarded<CatalogRefreshResult>('/api/models/catalog', { method: 'POST' });
  },

  /**
   * 用一把**尚未保存**的上游访问密钥试通上游。
   *
   * 存在的理由：`putCredential` 是只写端点，写进去就只剩掩码。用户填错后
   * 没有任何自查手段 —— 只能等真实请求失败。这条补上「先验后存」。
   */
  testCredential(key: string): Promise<CredentialTestResult> {
    if (MOCKS_ENABLED) return mockApi.testCredential(key);
    return apiRequestGuarded<CredentialTestResult>('/api/settings/credential/test', jsonBody({ key }));
  },

  /** 启用 / 停用目录里的一个模型。不删行，可随时切回。 */
  /** [v0.5.4] provider 给定时只改该提供商分区的启停。 */
  setModelEnabled(id: string, enabled: boolean, provider?: string): Promise<ModelEnabledResult> {
    if (MOCKS_ENABLED) return mockApi.setModelEnabled(id, enabled);
    return apiRequestGuarded<ModelEnabledResult>(
      `/api/models/catalog/${encodeURIComponent(id)}${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    );
  },

  /* ---------------- 提供商（2026-10-08，api-contract §3.12） ---------------- */

  /** [v0.5.6] 查签到面板。 */
  providerSignin(id: string): Promise<ProviderSigninPanel> {
    return apiRequestGuarded<ProviderSigninPanel>(`/api/providers/${encodeURIComponent(id)}/signin`);
  },

  /** [v0.5.6] 立即签到。 */
  /** [v1.4.0] 导入 WorkBuddy OAuth 凭证（领取域：签到代领/成长任务）。 */
  providerOauthImport(id: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/oauth-import`, { method: 'POST', body: JSON.stringify(payload) });
  },

  /**
   * [v1.6.5] 从**服务端所在机器**的客户端登录态自动导入 MiniMax / Qoder 凭证。
   * 同机部署 → 真·一键；分离部署 → `outcome: 'unavailable'`（前端降级给推送命令）。
   */
  providerImportLocal(id: string): Promise<{ ok: boolean; outcome: 'imported' | 'unavailable' | 'error'; message: string; detail?: string }> {
    if (MOCKS_ENABLED) return mockApi.providerImportLocal(id);
    /* 带空 JSON body：服务端 content-type 为 application/json 时 Fastify 要求 body 非空。 */
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/import-local`, {
      method: 'POST',
      body: '{}',
    });
  },

  /**
   * [v1.6.11] 设备授权导入 ①：申请授权，拿到浏览器要打开的地址。
   * 私有状态（device_code / PKCE verifier）留在服务端，这里只拿到 authUrl。
   */
  providerImportDeviceStart(id: string): Promise<{ ok: boolean; authUrl?: string; userCode?: string; hint?: string; expiresInSec?: number; message?: string }> {
    if (MOCKS_ENABLED) return mockApi.providerImportDeviceStart(id);
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/import-device/start`, {
      method: 'POST',
      body: '{}',
    });
  },

  /** [v1.6.11] 设备授权导入 ②：轮询取票（`status='pending'` 表示用户还没点完）。 */
  providerImportDevicePoll(id: string): Promise<{ ok: boolean; status: 'pending' | 'done' | 'error'; summary?: string; message?: string }> {
    if (MOCKS_ENABLED) return mockApi.providerImportDevicePoll(id);
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/import-device/poll`, {
      method: 'POST',
      body: '{}',
    });
  },

  /** [v1.6.11] 取消进行中的授权（关闭弹窗时调用，释放服务端会话）。 */
  providerImportDeviceCancel(id: string): Promise<{ ok: boolean }> {
    if (MOCKS_ENABLED) return mockApi.providerImportDeviceCancel(id);
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/import-device/cancel`, {
      method: 'POST',
      body: '{}',
    });
  },

  /** [v1.4.0] 手动跑一轮 WorkBuddy 领取（签到 + 任务 + 连登兑换；需已导入 OAuth）。 */
  providerGrowthRun(id: string): Promise<GrowthRunResult> {
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/growth/run`, { method: 'POST' });
  },

  /** [v1.4.4] WorkBuddy 任务面板（只读：完成态/进度/奖励）。 */
  providerGrowthPanel(id: string): Promise<GrowthPanelResult> {
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/growth`);
  },

  providerSigninNow(id: string): Promise<{ ok: boolean; outcome: string; points: number | null; streak: number | null; message: string }> {
    if (MOCKS_ENABLED) return mockApi.providerSigninNow(id);
    return apiRequestGuarded(`/api/providers/${encodeURIComponent(id)}/signin`, { method: 'POST' });
  },

  providers(): Promise<{ items: ProviderItem[] }> {
    if (MOCKS_ENABLED) return mockApi.providers();
    return apiRequestGuarded<{ items: ProviderItem[] }>('/api/providers');
  },

  createProvider(input: {
    name: string;
    baseUrl: string;
    credential: string;
    /** [v0.5.0] 上游方言；缺省 openai。 */
    protocol?: 'openai' | 'anthropic' | 'qoder';
    activate?: boolean;
  }): Promise<{ item: ProviderItem; activated: boolean }> {
    if (MOCKS_ENABLED) return mockApi.createProvider(input);
    return apiRequestGuarded<{ item: ProviderItem; activated: boolean }>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  patchProvider(
    id: string,
    input: { name?: string; baseUrl?: string; credential?: string },
  ): Promise<ProviderItem> {
    if (MOCKS_ENABLED) return mockApi.patchProvider(id, input);
    return apiRequestGuarded<ProviderItem>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  /**
   * 激活 = 把全局出站上游切到该提供商。
   * 服务端会**清空并重建**模型目录（旧清单对新上游是错的）——
   * 调用方在成功后应刷新目录。
   */
  /** [v0.5.1] 停用提供商（退出出站路由；最后一个生效的服务端会拒）。 */
  deactivateProvider(id: string): Promise<ProviderItem> {
    if (MOCKS_ENABLED) return mockApi.activateProvider(id);
    return apiRequestGuarded<ProviderItem>(`/api/providers/${encodeURIComponent(id)}/deactivate`, { method: 'PUT' });
  },

  activateProvider(id: string): Promise<ProviderItem> {
    if (MOCKS_ENABLED) return mockApi.activateProvider(id);
    return apiRequestGuarded<ProviderItem>(`/api/providers/${encodeURIComponent(id)}/activate`, {
      method: 'PUT',
    });
  },

  /**
   * 试通一个提供商（**不切换**就能测）—— 与 `testCredential` 的区别：
   * 那个打当前生效的上游，这个打指定提供商的地址。
   * 省略 `credential` 时用该提供商已保存的那把（「已存的还活着吗」）。
   */
  testProvider(id: string, credential?: string): Promise<CredentialTestResult> {
    if (MOCKS_ENABLED) return mockApi.testProvider(id, credential);
    return apiRequestGuarded<CredentialTestResult>(`/api/providers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(credential ? { credential } : {}),
    });
  },

  deleteProvider(id: string): Promise<{ deleted: string }> {
    if (MOCKS_ENABLED) return mockApi.deleteProvider(id);
    return apiRequestGuarded<{ deleted: string }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
// @zbiti-ai:f:227:9c20484c
