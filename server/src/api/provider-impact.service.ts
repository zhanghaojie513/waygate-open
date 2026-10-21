/**
 * 提供商**影响面**（v1.7.1）——「动这家会碰到谁」。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────
 * 停用 / 删除提供商是个**孤立按钮**：用户点下去之前看不到依赖链。实际数据都在库里，
 * 只是没人联查：
 *
 *   providers ──┬─→ model_catalog（分区：这家提供哪些模型）
 *               ├─→ client_keys.clients（绑定优先级，存的是 provider **id**）
 *               ├─→ client_keys.scope（模型范围可能点名了这家的模型）
 *               └─→ requests.provider_id（过去一段时间实际走了这家多少流量）
 *
 * 联查之后，「停用」这个动作就有了依据：**3 个密钥绑定它、其中 2 个把它的模型列进范围、
 * 过去 24 小时 412 条请求** —— 停掉会发生什么，一眼可见。
 *
 * ── 口径纪律 ────────────────────────────────────────────────────────────
 * · 绑定按 **id 精确匹配**（v0.4.20 起 `clients` 存 id）**加上名字兜底**（更早的数据存名）。
 *   两条都算 —— 与路由层 `resolveBinding` 的双匹配同源，不能在这里单算 id 而漏掉历史绑定。
 * · scope 的影响是**可能**而非确定：`models` 点名了这家的模型 id 就算，哪怕另一个分区
 *   也有同名模型（那正是需要人看一眼的情况，不该被过滤掉）。
 * · 请求量走 `provider_id` **事实列**；迁移前的行（NULL）不计入 —— 猜出来的量不能当证据。
 * · 一切只读。
 */

import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../store/db';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ClientKeysRepository, parseClients } from '../store/repositories/client-keys.repo';

export interface ProviderImpact {
  providerId: string;
  providerName: string;
  active: boolean;
  /** 这家提供的模型数 / 其中启用数。 */
  modelCount: number;
  modelEnabled: number;
  /** 绑定链：几个密钥绑它（含名字兜底的历史绑定）。 */
  boundKeys: Array<{
    id: string;
    name: string;
    keyHint: string;
    /** 在这把密钥的绑定序里排第几（0 = 首选）。 */
    rank: number;
    /** 绑定存的是名字（旧数据）而非 id —— 界面要能说明「这条是历史绑定」。 */
    legacyByName: boolean;
  }>;
  /** 模型范围点名了这家的模型（可能受影响，不一定是独家）。 */
  scopedKeys: Array<{ id: string; name: string; modelIds: string[] }>;
  /** 过去 24h 经这家转发的请求数与 token 数（provider_id 事实列）。 */
  recent: { requests: number; tokens: number };
  /** 删除后会失去什么（供删除弹窗直接引用）。 */
  irreversible: string[];
}

@Injectable()
export class ProviderImpactService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersRepository,
    private readonly catalog: ModelCatalogRepository,
    private readonly keys: ClientKeysRepository,
  ) {}

  /**
   * 取一家的影响面。提供商不存在 → 调用方 404（本方法假定 id 已校验）。
   * @param windowHours 统计窗口，默认 24。
   */
  impact(providerId: string, windowHours = 24): ProviderImpact {
    const row = this.providers.findById(providerId);
    if (!row) throw new Error(`提供商 ${providerId} 不存在`);

    const models = this.catalog.all(providerId);
    const modelIds = new Set(models.map((m) => m.id));

    const boundKeys: ProviderImpact['boundKeys'] = [];
    const scopedKeys: ProviderImpact['scopedKeys'] = [];

    for (const key of this.keys.list()) {
      /* clients 是 JSON 数组（v0.4.20 起存提供商 id；更早存名字）。 */
      const clients = parseClients(key.clients);
      let rank = -1;
      let legacyByName = false;
      for (let i = 0; i < clients.length; i++) {
        const v = clients[i];
        if (v === providerId) {
          rank = i;
          legacyByName = false;
          break;
        }
        /* 名字兜底：只在还没命中 id 时记（id 命中优先，与路由层一致）。 */
        if (v === row.name && rank < 0) {
          rank = i;
          legacyByName = true;
        }
      }
      if (rank >= 0) {
        boundKeys.push({ id: key.id, name: key.name, keyHint: key.key_hint, rank, legacyByName });
      }

      /* 模型范围点名这家的模型 —— 解析 scope JSON（形状见 model-scope.ts 头注）。 */
      const hits = scopeModelIds(key.scope).filter((id) => modelIds.has(id));
      if (hits.length > 0) {
        scopedKeys.push({ id: key.id, name: key.name, modelIds: hits });
      }
    }
    boundKeys.sort((a, b) => a.rank - b.rank);

    const since = Date.now() - windowHours * 3600_000;
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS tokens
           FROM requests WHERE provider_id = ? AND ts >= ?`,
      )
      .get(providerId, since) as { n: number; tokens: number };

    return {
      providerId,
      providerName: row.name,
      active: row.active === 1,
      modelCount: models.length,
      modelEnabled: models.filter((m) => m.enabled === 1).length,
      boundKeys,
      scopedKeys,
      recent: { requests: agg.n, tokens: agg.tokens },
      irreversible: this.irreversibleFor(row.protocol, models.length),
    };
  }

  /** 删除会失去什么 —— 分协议如实列出（别对 custom 说"OAuth 授权会丢"，它没有 OAuth）。 */
  private irreversibleFor(protocol: string, modelCount: number): string[] {
    const out: string[] = [];
    switch (protocol) {
      case 'openai':
        out.push('WorkBuddy 的 OAuth 授权（providers/<id>.oauth）—— 无法从本机重建，删后需重新走一遍官方授权');
        break;
      case 'anthropic':
        out.push('MiniMax 的 refresh token（providers/<id>.key）—— 一次性轮换，删后需重新登录');
        out.push('缓存的 access token（providers/<id>.access）');
        break;
      case 'qoder':
        out.push('Qoder 的身份 JSON（providers/<id>.key）—— 需重新导入客户端登录态');
        break;
      case 'custom':
        out.push('自定义端点的 API Key（providers/<id>.key）—— 需重新填写');
        break;
      default:
        out.push('该提供商的凭证文件');
    }
    if (modelCount > 0) out.push(`该家登记的 ${modelCount} 个模型（含启停偏好）`);
    out.push('过去经该家转发的请求量会失去归属（历史行保留，provider_id 指向已删的 id）');
    return out;
  }
}

/**
 * 从 scope JSON 里取出**点名的模型 id**（只有 `type: 'models'` 有）。
 * 脏数据一律当空 —— 影响面统计不能因为一行烂 JSON 整个失败。
 */
export function scopeModelIds(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const scope = parsed as { type?: unknown; value?: unknown };
  if (scope.type !== 'models') return [];
  const value = scope.value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}
