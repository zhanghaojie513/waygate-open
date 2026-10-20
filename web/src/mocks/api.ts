/**
 * Mock 版 API（仅 npm run dev:mock 启用），签名与 services/api.ts 完全一致。
 * 数据来自 mocks/fixtures.ts：模型 17 项种子 + 1 项 upstream 演示项（`kimi-k3-1`，倍率未知）、
 * 客户端/密钥沿用原型、设置 7 组 23 项照抄契约。
 */

import type {
  AdminPasswordResetResult,
  AdminPasswordSetResult,
  CatalogData,
  CatalogRefreshResult,
  ClientKeyRow,
  ClientRow,
  CreatedKey,
  ProviderUsageRow,
  CreateKeyInput,
  CredentialTestResult,
  CredentialUpdateResult,
  DangerAction,
  DangerResult,
  LoginResult,
  ModelEnabledResult,
  OverviewData,
  ProviderItem,
  PutSettingsResult,
  RequestDetail,
  RequestLogRow,
  SessionState,
  SettingsData,
  SettingPatch,
  TimeWindow,
} from '../types/api';
import { ApiError } from '../services/http';
import { KEY_PREFIX, maskKeyPrefix } from '../lib/console';
import {
  CATALOG,
  REQUEST_TOTAL,
  makeProviderUsage,
  makeClients,
  makeKeys,
  makeOverview,
  makeRequestDetail,
  makeRequestPage,
  makeSettings,
} from './fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomKeyPlaintext(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${KEY_PREFIX}${hex}`;
}

let mockAuthed = false;
const keyStore: ClientKeyRow[] = makeKeys();
let settingsStore: SettingsData = makeSettings();

export const mockApi = {
  async session(): Promise<SessionState> {
    await sleep(120);
    return mockAuthed
      ? { authenticated: true, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() }
      : { authenticated: false, expiresAt: null };
  },

  async login(password: string): Promise<LoginResult> {
    await sleep(420);
    if (!password) throw new ApiError('请输入管理口令。', 40001, 400);
    if (password !== 'relay-dev') throw new ApiError('管理口令不正确。', 40101, 401);
    mockAuthed = true;
    return { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() };
  },

  async logout(): Promise<void> {
    await sleep(80);
    mockAuthed = false;
  },

  async overview(window: TimeWindow): Promise<OverviewData> {
    await sleep(200);
    /* [2026-10-09] 按窗口造数（此前忽略入参、恒回 30 天那份）——
       否则页面选择器写着「今日」而数字是 30 天的，自己跟自己打架。 */
    return makeOverview(window);
  },

  async clients(_window: TimeWindow): Promise<ClientRow[]> {
    await sleep(180);
    return makeClients();
  },

  /* [v0.6.0] 提供商维度用量（服务端 /api/clients 的 byProvider 同款）——
     dev:mock 下让提供商表三列有值，演示多生效归属。 */
  async clientsByProvider(): Promise<ProviderUsageRow[]> {
    await sleep(180);
    return makeProviderUsage();
  },

  async requests(params: {
    page: number;
    limit: number;
    status?: string;
    clientId?: string;
    model?: string;
    q?: string;
  }): Promise<{ items: RequestLogRow[]; total: number; page: number; limit: number; hasMore: boolean }> {
    await sleep(220);
    let rows = makeRequestPage(params.page, params.limit);
    if (params.status === 'success') rows = rows.filter((r) => r.status < 400);
    else if (params.status === 'error') rows = rows.filter((r) => r.status >= 400);
    // 3 位状态码：与后端 `requests.service.ts` 的 `/^\d{3}$/` 同语义。
    // 之前漏了这一支，导致 429 / 504 选项在 Mock 下**静默失效**（返回全部）—— 属真机才暴露的漂移。
    else if (params.status && /^\d{3}$/.test(params.status)) {
      rows = rows.filter((r) => r.status === Number(params.status));
    }
    // 过滤键是 **id**，不是显示名 —— 名字只是标签，改一次名就失配（AC-C06）。
    if (params.clientId) rows = rows.filter((r) => r.clientId === params.clientId);
    if (params.model) rows = rows.filter((r) => r.model === params.model);
    if (params.q) {
      const q = params.q.toLowerCase();
      rows = rows.filter(
        (r) => r.model.toLowerCase().includes(q) || r.client.toLowerCase().includes(q) || r.note.toLowerCase().includes(q),
      );
    }
    return { items: rows, total: REQUEST_TOTAL, page: params.page, limit: params.limit, hasMore: params.page * params.limit < REQUEST_TOTAL };
  },

  async requestDetail(id: number): Promise<RequestDetail> {
    await sleep(160);
    return makeRequestDetail(id);
  },

  async catalog(): Promise<CatalogData> {
    await sleep(150);
    return CATALOG;
  },

  /**
   * 拉取 + 逐项实测。
   *
   * Mock 里模拟真语义的两条：① 会花时间（实测很慢）② 未通过的**不删除**。
   * 返回值让调用方能走到「有失败项」的分支，避免那段文案等真机才被发现写错。
   */
  async refreshCatalog(): Promise<CatalogRefreshResult> {
    await sleep(900);
    const failed = CATALOG.models.filter((m) => !m.verified).map((m) => m.id);
    return {
      checked: CATALOG.models.length,
      ok: CATALOG.models.length - failed.length,
      failed,
      source: CATALOG.source,
      pulled: true,
      configPulled: true,
      multipliersUpdated: 2,
    };
  },

  /**
   * 试通一把尚未保存的上游访问密钥。四条可预期规则（TestOutcome 六支据此可验）：
   *   `nosub`→11102+HTTP400；`bad`→业务码null+HTTP401（上游**拒签**，语义别改）；
   *   `offline`→业务码与 httpStatus 都 null（真·网络失败，没拿到响应）；其余→ok+HTTP200。
   * 11102 必须可验：它是「key 有效但存不进去」那条路径的现实依据。
   */
  async testCredential(key: string): Promise<CredentialTestResult> {
    await sleep(700);
    const trimmed = (key ?? '').trim();
    if (!/^ck_[\x21-\x7e]{16,}$/.test(trimmed)) {
      throw new ApiError('上游访问密钥格式不正确：应以 ck_ 开头，后接至少 16 位可见字符（不能含空格或换行）', 40001, 400);
    }
    const model = CATALOG.models.find((m) => m.enabled)?.id ?? 'hunyuan-lite';
    if (trimmed.includes('nosub')) {
      return { ok: false, model, elapsedMs: 298, upstreamCode: 11102, httpStatus: 400, reason: '上游业务码 11102' };
    }
    if (trimmed.includes('offline')) {
      return { ok: false, model, elapsedMs: 15000, upstreamCode: null, httpStatus: null, reason: 'fetch failed' };
    }
    if (trimmed.includes('bad')) {
      return { ok: false, model, elapsedMs: 412, upstreamCode: null, httpStatus: 401, reason: 'HTTP 401' };
    }
    return { ok: true, model, elapsedMs: 386, upstreamCode: null, httpStatus: 200, reason: null };
  },

  /** 启用 / 停用模型。Mock 里真的改内存态，便于验证勾选交互。 */
  async setModelEnabled(id: string, enabled: boolean): Promise<ModelEnabledResult> {
    await sleep(220);
    const target = CATALOG.models.find((m) => m.id === id);
    if (!target) throw new ApiError(`模型目录里没有 ${id}`, 40401, 404);
    target.enabled = enabled;
    return { id, enabled };
  },

  async keys(): Promise<ClientKeyRow[]> {
    await sleep(160);
    return keyStore.map((k) => ({ ...k }));
  },

  async createKey(input: CreateKeyInput): Promise<CreatedKey> {
    await sleep(420);
    if (keyStore.some((k) => k.name === input.name)) {
      throw new ApiError('同名密钥已存在，换一个名字。', 40901, 409);
    }
    const plaintext = randomKeyPlaintext();
    /* [v0.4.20] clients 数组优先，回落旧的 client 单值；client 列 = 首项。 */
    const clients = input.clients ?? (input.client ? [input.client] : []);
    const row: ClientKeyRow = {
      id: `k_${Math.floor(Math.random() * 65535).toString(16).padStart(4, '0')}`,
      name: input.name,
      hint: maskKeyPrefix(plaintext),
      scope: input.scope,
      client: clients[0] ?? null,
      clients,
      /* [v0.4.35] 访问策略三项原样落 mock 行（不限 = 空/null）。 */
      ipWhitelist: input.ipWhitelist ?? [],
      maxIps: input.maxIps ?? null,
      tokenQuota: input.tokenQuota ?? null,
      usedIps: 0,
      usedTokens: 0,
      enabled: true,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      requests24h: 0,
    };
    keyStore.unshift(row);
    return {
      ...row,
      key: plaintext,
      warning: '关掉这页又没保存，只能删除重建。此明文不会再出现。',
    };
  },

  async patchKey(
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
    await sleep(240);
    const idx = keyStore.findIndex((k) => k.id === id);
    if (idx < 0) throw new ApiError('密钥不存在，可能已被删除。', 40401, 404);
    /* [v0.4.10] 与真实服务端同语义：改名要查重（允许改成自己原名）；
       `client` 走字段存在性判定 —— 传 null 是**解绑**，不能当成"没传"。 */
    if (patch.name !== undefined && keyStore.some((k) => k.id !== id && k.name === patch.name)) {
      throw new ApiError('已存在同名密钥，换一个名字。', 40901, 409);
    }
    const next = { ...keyStore[idx] };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    /* [v0.4.20] clients 优先；只传 client 时推导单元素数组。两者同步 client/clients。 */
    if (patch.clients !== undefined || 'client' in patch) {
      const clients = patch.clients ?? (patch.client ? [patch.client] : []);
      next.clients = clients;
      next.client = clients[0] ?? null;
    }
    /* [v0.4.35] 策略三件套：字段存在即覆写（与真实服务端的整组覆写语义一致）。 */
    if (patch.ipWhitelist !== undefined) next.ipWhitelist = patch.ipWhitelist;
    if (patch.maxIps !== undefined) next.maxIps = patch.maxIps;
    if (patch.tokenQuota !== undefined) next.tokenQuota = patch.tokenQuota;
    keyStore[idx] = next;
    return { ...next };
  },

  async deleteKey(id: string): Promise<{ deleted: number }> {
    await sleep(240);
    const idx = keyStore.findIndex((k) => k.id === id);
    if (idx < 0) throw new ApiError('密钥不存在，可能已被删除。', 40401, 404);
    keyStore.splice(idx, 1);
    return { deleted: 1 };
  },

  async settings(): Promise<SettingsData> {
    await sleep(180);
    /* 模块级单例 —— **不能**每次重建。重建会抹掉 putSettings / putCredential 的写入，
       于是「保存后掩码更新」在 Mock 下永不成立（凭据留存无法演示）。
       要复位请走 `danger('resetSettings')`（见下方，那里才显式 `makeSettings()`）。 */
    return settingsStore;
  },

  async putSettings(patches: SettingPatch[]): Promise<PutSettingsResult> {
    await sleep(420);
    let applied = 0;
    let requiresRestart = false;
    settingsStore.groups.forEach((g) =>
      g.items.forEach((item) => {
        const hit = patches.find((p) => p.key === item.key);
        if (!hit || item.readonly || item.type === 'action' || item.type === 'mapping') return;
        item.value = hit.value;
        applied += 1;
        if (item.requiresRestart) requiresRestart = true;
      }),
    );
    settingsStore = { ...settingsStore, version: settingsStore.version + 1 };
    return { requiresRestart, applied, version: settingsStore.version };
  },

  /**
   * 写入上游访问密钥（契约 §3.8.1）。
   *
   * Mock 也照搬了两条关键语义，避免「Mock 通过、真机打脸」：
   *   ① 格式校验与后端同一条正则（不合法抛 40001）
   *   ② 只回掩码，绝不回明文 —— 顺便让开发者在 Mock 下就习惯这个契约
   */
  async putCredential(key: string): Promise<CredentialUpdateResult> {
    await sleep(420);
    const trimmed = (key ?? '').trim();
    // 与 CredentialModal / 服务端**逐字一致**（改动必须三处同步）。
    // 曾因收窄字符集把真实密钥（含 `.`）挡在门外 —— 见 CredentialModal 的注释。
    if (!/^ck_[\x21-\x7e]{16,}$/.test(trimmed)) {
      throw new ApiError('上游访问密钥格式不正确：应以 ck_ 开头，后接至少 16 位可见字符（不能含空格或换行）', 40001, 400);
    }
    const masked = `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
    settingsStore.groups.forEach((g) =>
      g.items.forEach((item) => {
        if (item.key === 'credential.source') item.value = masked;
        if (item.key === 'credential.status') item.value = '有效';
      }),
    );
    return { source: masked, configured: true, persisted: true, path: '/var/lib/relay/upstream.key' };
  },

  /**
   * 重置管理口令（契约 §3.1.3）。
   *
   * Mock 也照搬三条真语义，避免「Mock 顺手、真机打脸」：
   *   ① **无请求体** —— 口令由"服务端"生成，Mock 里就是这段随机逻辑
   *   ② 字符集与后端 `generatePassword` 一致（去掉 0/O/1/l/I 等易混字符），
   *      这样前端在 Mock 下就能验证复制/展示对易混字符的处理
   *   ③ 只回明文一次，不缓存、不回显
   */
  async resetAdminPassword(): Promise<AdminPasswordResetResult> {
    await sleep(520);
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let password = '';
    for (let i = 0; i < 16; i += 1) {
      password += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return { password, persisted: true };
  },

  /**
   * 手动设定管理口令（契约 §3.1.4）。
   *
   * Mock 里照搬真语义，避免「Mock 顺手、真机打脸」：
   *   ① 校验规则与后端一致（≥8 字符、拒纯空白、≤128）；
   *   ② **不回显明文** —— 返回体里没有 password 字段；
   *   ③ 不做任何持久化（Mock 无状态），口令进内存即忘。
   *
   * ⛔ Mock 里也**不使用任何真实口令** —— 这里的参数就是用户演示用的字面量。
   */
  async setAdminPassword(password: string): Promise<AdminPasswordSetResult> {
    await sleep(420);
    const trimmed = password.trim();
    if (trimmed.length === 0) throw new ApiError('管理口令不能为空或纯空白。', 40001, 400);
    if (trimmed.length < 8) {
      throw new ApiError(`管理口令至少 8 个字符，当前 ${trimmed.length} 个。`, 40001, 400);
    }
    if (password.length > 128) {
      throw new ApiError(`管理口令最多 128 个字符，当前 ${password.length} 个。`, 40001, 400);
    }
    return { persisted: true };
  },

  async danger(action: DangerAction, confirm: string): Promise<DangerResult> {
    await sleep(480);
    if (confirm !== '确认') throw new ApiError('确认文字不匹配，未执行任何操作。', 40002, 400);
    if (action === 'clearLogs') return { affected: { logs: REQUEST_TOTAL } };
    if (action === 'resetKeys') return { affected: { keys: keyStore.length } };
    settingsStore = makeSettings();
    return { affected: {} };
  },

  /* ---------------- 提供商（2026-10-08） ---------------- */

  /**
   * Mock 的提供商存储：模块级单例（与 settingsStore 同一理由 ——
   * 重建会抹掉新增/激活的写入，交互就演示不下去了）。
   * 初始两个：默认（active，对应原「上游连接」）+ 一个自定义示例。
   */
  providers(): Promise<{ items: ProviderItem[] }> {
    return sleep(160).then(() => ({ items: providerStore }));
  },

  createProvider(input: { name: string; baseUrl: string; credential: string; protocol?: 'openai' | 'anthropic' | 'qoder'; activate?: boolean }): Promise<{ item: ProviderItem; activated: boolean }> {
    return sleep(320).then(() => {
      /* [v1.6.11] ck_ 退役：openai（WorkBuddy）不再接受手填密钥 —— 与真机同语义。 */
      if (input.protocol === 'openai' && input.credential) {
        throw new ApiError('WorkBuddy 已不再使用 ck_ 密钥 —— 请用「导入客户端」完成官方授权。', 40001, 400);
      }
      const item: ProviderItem = {
        id: `p_${Math.random().toString(16).slice(2, 10)}`,
        name: input.name,
        baseUrl: input.baseUrl,
        credentialMask: maskProviderKey(input.credential),
        /* [v1.6.11] 空凭证 = 待导入（anthropic / qoder 先建后导）—— 与真机同语义。 */
        configured: Boolean(input.credential),
        active: false,
        protocol: input.protocol ?? 'openai',
        credKind: input.protocol === 'anthropic' ? 'oauth_minimax' : 'static',
        modelCount: input.protocol === 'anthropic' ? 4 : input.protocol === 'qoder' ? 14 : 17,
        modelEnabled: input.protocol === 'anthropic' ? 4 : input.protocol === 'qoder' ? 14 : 17,
        signin: { checkedOn: null, streak: null, lastPoints: null },
        wbOAuth: { configured: false, uidMask: null, expiresAt: null }, wbCredits: null,
        qoderCredits: null,
        wbSignin: { checkedOn: null, streak: null, lastPoints: null },
        credits: null,
      };
      providerStore.push(item);
      if (input.activate) activateProviderInStore(item.id);
      return { item, activated: input.activate === true };
    });
  },

  patchProvider(id: string, input: { name?: string; baseUrl?: string; credential?: string }): Promise<ProviderItem> {
    return sleep(260).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      if (input.name !== undefined) t.name = input.name;
      if (input.baseUrl !== undefined) t.baseUrl = input.baseUrl;
      if (input.credential !== undefined) {
        t.credentialMask = maskProviderKey(input.credential);
        t.configured = Boolean(input.credential);
      }
      return { ...t };
    });
  },

  /**
   * [v1.6.11] 自动导入凭证的 Mock —— 演示「同机部署 → 真·一键」的成功路径。
   * 真机分离部署时服务端返回 unavailable 并给推送命令；要在 Mock 里看那条分支，
   * 把 outcome 改成 'unavailable' 即可。
   */
  providerImportLocal(id: string): Promise<{ ok: boolean; outcome: 'imported' | 'unavailable' | 'error'; message: string }> {
    return sleep(420).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      t.configured = true;
      t.credentialMask = t.protocol === 'qoder'
        ? '{"to••••pe"}'
        : maskProviderKey('mmort_imported0000000000');
      return {
        ok: true,
        outcome: 'imported' as const,
        message: `已从本机 ${t.protocol === 'qoder' ? 'Qoder' : 'MiniMax Code'} 客户端登录态导入凭证。`,
        detail: '令牌约 30 天过期，届时重新导入即可。',
      };
    });
  },

  /**
   * [v1.6.12] 设备授权导入的 Mock —— 演示「申请 → 跳授权页 → 轮询 → 成功」全流程。
   * 首次 poll 返回 pending（模拟用户还没点完），第二次 done —— 让前端轮询逻辑能被真实演练。
   */
  providerImportDeviceStart(id: string): Promise<{ ok: boolean; authUrl?: string; userCode?: string; hint?: string; expiresInSec?: number; message?: string }> {
    return sleep(320).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      deviceImportPolls.delete(id);
      const urls: Record<string, string> = {
        openai: 'https://copilot.tencent.com/login?platform=CLI&state=mock-state',
        anthropic: 'https://account.minimax.cn/oauth-authorize?user_code=MOCK-1234',
        qoder: 'https://qoder.cn/device/selectAccounts?challenge=mock&client_id=mock',
      };
      return {
        ok: true,
        authUrl: urls[t.protocol ?? 'openai'] ?? urls.openai,
        ...(t.protocol === 'openai' ? {} : { userCode: 'MOCK-1234' }),
        hint: `请在打开的页面用 ${t.name} 账号完成授权`,
        expiresInSec: 300,
      };
    });
  },

  providerImportDevicePoll(id: string): Promise<{ ok: boolean; status: 'pending' | 'done' | 'error'; summary?: string; message?: string }> {
    return sleep(300).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      const n = (deviceImportPolls.get(id) ?? 0) + 1;
      deviceImportPolls.set(id, n);
      /* 前两次 pending（模拟用户在浏览器里操作），第三次成功。 */
      if (n < 3) return { ok: true, status: 'pending' as const };
      t.configured = true;
      t.credentialMask = '••••（设备授权）';
      return { ok: true, status: 'done' as const, summary: 'mock-account' };
    });
  },

  providerImportDeviceCancel(id: string): Promise<{ ok: boolean }> {
    deviceImportPolls.delete(id);
    return sleep(80).then(() => ({ ok: true }));
  },

  /** 激活 = 恰一个 active；Mock 下顺带把目录切成"另一个提供商的清单"，
      演示"模型列表随选择重新获取"的语义（真机上服务端清空并重拉）。 */
  activateProvider(id: string): Promise<ProviderItem> {
    return sleep(420).then(() => {
      const item = activateProviderInStore(id);
      switchMockCatalog(item.id);
      return { ...item };
    });
  },

  /** [v1.6.8] 立即签到（Mock）：按协议给出与真实服务端同形状的结果 ——
      含 claimed/none/error 三种 outcome，用于演示顶栏 Toast 的三种话术。
      WorkBuddy 无 OAuth 时走「状态同步」分支（ok:true 但 outcome:none）。 */
  providerSigninNow(id: string): Promise<{ ok: boolean; outcome: string; points: number | null; streak: number | null; message: string }> {
    return sleep(700).then(() => {
      const p = providerStore.find((x) => x.id === id);
      if (!p) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      const today = new Date().toISOString().slice(0, 10);
      const already = p.signin.checkedOn === today;
      const points = p.protocol === 'anthropic' ? 200 : p.protocol === 'qoder' ? 100 : 100;
      if (!already) {
        p.signin = { checkedOn: today, streak: (p.signin.streak ?? 0) + 1, lastPoints: points };
      }
      return already
        ? { ok: true, outcome: 'none', points: p.signin.lastPoints, streak: p.signin.streak, message: '今天已经签过了。' }
        : { ok: true, outcome: 'claimed', points, streak: p.signin.streak, message: '签到成功。' };
    });
  },

  /** 试通一个提供商（Mock：自定义示例故意回 11102 —— 演示「key 好但没订阅该模型」分支）。
      credential 参数在 Mock 下不影响结论（真值判定在服务端）。 */
  testProvider(id: string, _credential?: string): Promise<CredentialTestResult> {
    return sleep(600).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      return { ok: true, model: 'hunyuan-lite', elapsedMs: 238, upstreamCode: null, httpStatus: 200, reason: null };
    });
  },

  deleteProvider(id: string): Promise<{ deleted: string }> {
    return sleep(300).then(() => {
      const t = providerStore.find((p) => p.id === id);
      if (!t) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
      if (t.active) throw new ApiError('不能删除当前生效的提供商 —— 先切换到另一个，再删除这个。', 40002, 400);
      if (providerStore.length <= 1) throw new ApiError('至少保留一个提供商。', 40002, 400);
      providerStore = providerStore.filter((p) => p.id !== id);
      return { deleted: id };
    });
  },
};

/* ---- 提供商 Mock 的内部实现 ---- */

function maskProviderKey(key: string): string {
  if (!key) return '未配置';
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function activateProviderInStore(id: string): ProviderItem {
  const target = providerStore.find((p) => p.id === id);
  if (!target) throw new ApiError(`提供商 ${id} 不存在`, 40401, 404);
  providerStore.forEach((p) => { p.active = p.id === id; });
  return target;
}

/**
 * 切换 Mock 目录：每个提供商一份**不同的**清单 —— 否则"模型列表随选择重新获取"
 * 在 Mock 下看不出任何变化（两份一样），那条交互就成了死演示。
 * 默认提供商沿用 CATALOG（17 项）；自定义示例给一份小的（4 项）。
 */
const MOCK_CATALOG_CUSTOM: CatalogData = {
  source: 'upstream',
  fetchedAt: new Date().toISOString(),
  upstreamReachable: true,
  models: [
    { id: 'gpt-5o', displayName: 'GPT-5o', provider: 'OpenAI 兼容示例', family: 'gpt', tag: null, multiplier: 1.25, source: 'upstream', verified: 1, enabled: true, lastVerifiedAt: null },
    { id: 'gpt-5o-mini', displayName: 'GPT-5o mini', provider: 'OpenAI 兼容示例', family: 'gpt', tag: null, multiplier: 0.3, source: 'upstream', verified: 1, enabled: true, lastVerifiedAt: null },
    { id: 'o4-reason', displayName: 'O4 Reason', provider: 'OpenAI 兼容示例', family: 'o4', tag: '订阅优先', multiplier: 2.1, source: 'upstream', verified: 1, enabled: true, lastVerifiedAt: null },
    { id: 'llama-4', displayName: 'Llama 4', provider: 'OpenAI 兼容示例', family: 'llama', tag: '限时免费', multiplier: 0, source: 'upstream', verified: 0, enabled: true, lastVerifiedAt: null },
  ],
};

function switchMockCatalog(providerId: string): void {
  const custom = providerStore.find((p) => p.id === providerId && p.id !== 'p_default00');
  CATALOG.models = custom ? [...MOCK_CATALOG_CUSTOM.models] : [...DEFAULT_CATALOG_MODELS.map((m) => ({ ...m }))];
  CATALOG.fetchedAt = new Date().toISOString();
}

/** [v1.6.12] 设备授权导入的轮询计数（providerId → 已轮询次数），演示 pending → done。 */
const deviceImportPolls = new Map<string, number>();

let providerStore: ProviderItem[] = [
  /* 与服务端种子同名（DEFAULT_PROVIDER_NAME = 'WorkBuddy'）—— 现库那条上游连接
     就是 WorkBuddy 的地址与密钥，名字说清楚比叫"默认"好。 */
  { id: 'p_default00', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', credentialMask: 'oauth(98b9303e…)', configured: true, active: true, protocol: 'openai', credKind: 'static', modelCount: 17, modelEnabled: 17, signin: { checkedOn: null, streak: null, lastPoints: null }, wbOAuth: { configured: true, uidMask: '98b9303e…', expiresAt: Date.now() + 20 * 86400_000 }, wbCredits: { remaining: 3741.03, granted: 7901, consumed: 4159.97, nextExpireAt: Date.now() + 26 * 86400_000, packages: [] }, qoderCredits: null, wbSignin: { checkedOn: new Date().toISOString().slice(0,10), streak: 10, lastPoints: 100 }, credits: null },
  /* [v0.5.13] MiniMax Code 提供商（anthropic 方言 + 真实积分账本）—— 数值取自
     生产实测（剩余 717.69 / 已用 82.31），演示「积分 ⓘ」tooltip 与签到状态。 */
  { id: 'p_qoder01', name: 'Qoder CN', baseUrl: 'https://gateway.qoder.com.cn', credentialMask: 'oauth(identity ••••c4)', configured: true, active: true, protocol: 'qoder', credKind: 'static', modelCount: 14, modelEnabled: 14, signin: { checkedOn: null, streak: null, lastPoints: null }, wbOAuth: { configured: false, uidMask: null, expiresAt: null }, wbCredits: null, qoderCredits: { available: true, granted: 500, remaining: 495, consumed: 5, nextExpireAt: null, lifetimeConsumed: 241.82, stale: false, fetchedAt: new Date(Date.now() - 30 * 60_000).toISOString(), message: '口径：资源包余额（495/500）；到期时刻上游不提供' }, wbSignin: { checkedOn: null, streak: null, lastPoints: null }, credits: null },
  { id: 'p_mmx002', name: 'MiniMax Code', baseUrl: 'https://mavis.minimax.io', credentialMask: 'oauth(refresh ••••9c)', configured: true, active: false, protocol: 'anthropic', credKind: 'oauth_minimax', modelCount: 4, modelEnabled: 4, signin: { checkedOn: new Date(Date.now() - 6 * 3600_000).toISOString(), streak: 12, lastPoints: 1200 }, wbOAuth: { configured: false, uidMask: null, expiresAt: null }, wbCredits: null, qoderCredits: null, wbSignin: { checkedOn: null, streak: null, lastPoints: null }, credits: { providerId: 'p_mmx002', providerName: 'MiniMax Code', available: true, granted: 800, remaining: 717.69, consumed: 82.31, nextExpireAt: new Date(Date.now() + 22 * 86_400_000).toISOString(), stale: false, fetchedAt: new Date(Date.now() - 40 * 60_000).toISOString(), message: '' } },
  /* [v1.6.32] 第二家 MiniMax（Code2）：与上一家**目录里有同名模型**（M3.1-Flash），
     复现生产实况 —— 用于验证请求日志「提供商」列读事实列、而不是按模型名反解。
     修复前这一家的流量会全被显示成上一家（用户实测报障）。 */
  { id: 'p_mm2c02', name: 'MiniMax Code2', baseUrl: 'https://agent.minimax.cn', credentialMask: 'oauth(refresh ••••2f)', configured: true, active: true, protocol: 'anthropic', credKind: 'oauth_minimax', modelCount: 4, modelEnabled: 4, signin: { checkedOn: null, streak: null, lastPoints: null }, wbOAuth: { configured: false, uidMask: null, expiresAt: null }, wbCredits: null, qoderCredits: null, wbSignin: { checkedOn: null, streak: null, lastPoints: null }, credits: null },
];

/** 默认目录的**深拷贝**留底 —— 切换提供商后要能切回来。 */
const DEFAULT_CATALOG_MODELS = CATALOG.models.map((m) => ({ ...m }));

/** 登录页提示用：Mock 模式下口令固定为 relay-dev */
export const MOCK_PASSWORD_HINT = 'relay-dev';
// @zbiti-ai:f:330:497ebd73
