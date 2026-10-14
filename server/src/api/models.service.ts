/**
 * `GET/POST /api/models/catalog`、`PATCH /api/models/catalog/:id`、`POST /api/settings/credential/test`
 * 的 API 层服务（api-contract §3.11）。
 *
 * 本类只做「目录视图 + 试通凭证 + 启用开关 + 返回形状」；
 * 真正的拉取/合并/实测编排在 `catalog/catalog-sync.ts`，探针在 `catalog/probe.ts`
 * —— 拆分是为了守住「单文件 ≤ 300 行」门禁，并把可变状态（冷却/进行中）收敛到同步服务。
 *
 * ⚠️ 实测校验会真的打上游请求、真的消耗积分（每个模型 1 token）。故不做任何自动重试。
 */

import { Injectable, Logger } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { RelayHttpError, ApiCode } from '../common/errors';
import { ModelProbeService } from '../catalog/probe';
import { CatalogSyncService } from '../catalog/catalog-sync';
import { UPSTREAM_KEY_PATTERN, UPSTREAM_KEY_HINT } from './credential.service';
import { toIso } from './window';

export interface CatalogModelItem {
  id: string;
  /**
   * [v0.5.13] 该模型归属的**提供商显示名**。
   *
   * 请求日志的「提供商」列按**模型 id → 目录**解析（requests 表没有 provider_id，
   * 无法逐行记录真实服务方）；密钥的绑定名只是路由偏好，不能冒充提供商 ——
   * 绑定 WorkBuddy 的密钥请求 MiniMax 模型时实际走 MiniMax Code，旧显示把人引去查错家。
   */
  provider: string;
  displayName: string;
  family: string;
  tag: string | null;
  /** null = 倍率未知（/v3/config 与本地快照都没有该模型）。 */
  multiplier: number | null;
  /** 'upstream' | 'seed' | 'manual'（v1.5.0 起 observed 已废除）。 */
  source: string;
  verified: number;
  enabled: boolean;
  lastVerifiedAt: string | null;
}

export interface CatalogPayload {
  source: string;
  fetchedAt: string;
  upstreamReachable: boolean;
  models: CatalogModelItem[];
}

/** 「试通凭证」的结论。不含任何凭证片段。 */
export interface CredentialTestResult {
  ok: boolean;
  model: string;
  elapsedMs: number;
  /**
   * 上游业务码（如 11102）。仅在「拿到了响应但无可提取业务码」时为 null。
   * ⚠️ 不能用它判断连通性 —— 网络失败时它同样是 null，那是 `httpStatus` 的职责。
   */
  upstreamCode: number | null;
  /**
   * 上游返回的 HTTP 状态码。
   *   - `null` ⇔ **根本没拿到 HTTP 响应**（网络失败 / 超时 / 中断）——只有这一种情况为 null
   *   - 数字 ⇔ 上游确实回了响应（2xx 时也填，通常 200；否则为 401/500…）
   *
   * 前端据此区分「上游拒签了这把 key」（有响应，如 401）与「连不上上游」（null），
   * 否则会把密钥被拒误诊成网络问题（task#30）。
   */
  httpStatus: number | null;
  reason: string | null;
}

/**
 * 目录为空时的探测目标。试通凭证只需「上游认不认这把 key」这一个结论，
 * 用哪个模型不影响它；选一个小而稳的模型名，避免因探测目标本身贵而消耗积分。
 */
const FALLBACK_PROBE_MODEL = 'hunyuan-lite';

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly config: RelayConfigService,
    private readonly catalog: ModelCatalogRepository,
    private readonly probe: ModelProbeService,
    private readonly sync: CatalogSyncService,
    /* [v0.5.1] 多生效：目录按提供商分区，视图层需要知道启用户集合。 */
    private readonly providers: ProvidersRepository,
  ) {}

  /** [v0.5.1] 生效提供商 id 列表（目录合并视图的范围）。 */
  private activeIds(): string[] {
    return this.providers.listActive().map((p) => p.id);
  }

  /** [v0.5.4] providerId 给定时只返回该提供商自己的分区（提供商各自维护清单的视图）。 */
  get(providerId?: string): CatalogPayload {
    const rows = providerId ? this.catalog.all(providerId) : this.catalog.allAcross(this.activeIds());
    /* [v0.5.13] 行带 provider 名：请求日志的「提供商」按模型解析（见 CatalogModelItem.provider 注释）。 */
    const providerName = new Map(this.providers.list().map((p) => [p.id, p.name]));
    return {
      source: this.dominantSource(rows.map((r) => r.source)),
      fetchedAt: toIso(this.sync.lastFetchedAt ?? Date.now()),
      upstreamReachable: this.config.upstreamConfigured(),
      models: rows.map((r) => ({
        id: r.id,
        provider: providerName.get(r.provider_id) ?? r.provider_id,
        displayName: r.display_name,
        family: r.family,
        tag: r.tag,
        multiplier: r.multiplier,
        source: r.source,
        verified: r.verified,
        enabled: r.enabled === 1,
        lastVerifiedAt: r.last_verified_at === null ? null : toIso(r.last_verified_at),
      })),
    };
  }

  /**
   * 同步刷新（拉上游清单 + /v3/config 真实倍率 → 替换式落库 + 逐项实测）。
   * 冷却中 / 进行中 → 429；未配置凭证 → 400。详见 CatalogSyncService.refresh。
   */
  async refresh(): Promise<{
    checked: number;
    ok: number;
    failed: string[];
    source: string;
    pulled: boolean;
    configPulled: boolean;
    multipliersUpdated: number;
    added: number;
  }> {
    return this.sync.refresh();
  }

  /**
   * 用一把**尚未保存**的凭证去试通上游。
   *
   * `PUT /api/settings/credential` 是「只写」端点（读不回来），用户填错 key 后无法自查；
   * 本方法补上这个缺口：先在本地验，确认能用再保存。只发一次最小请求（见 probe.ts）。
   *
   * @param rawKey 待测凭证明文。只在本方法栈内存在，不落盘、不进日志。
   */
  async testCredential(rawKey: unknown): Promise<CredentialTestResult> {
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: '上游访问密钥不能为空',
      });
    }
    const key = rawKey.trim();
    if (!UPSTREAM_KEY_PATTERN.test(key)) {
      // 不回显用户输入的任何片段，避免把「接近正确的密钥」写进响应/日志
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: `上游访问密钥格式不正确：${UPSTREAM_KEY_HINT}`,
      });
    }

    // 选一个探测目标：优先 enabled 的，其次表里第一个
    const rows = this.catalog.allAcross(this.activeIds());
    const target = rows.find((r) => r.enabled === 1) ?? rows[0];
    const modelId = target?.id ?? FALLBACK_PROBE_MODEL;

    const startedAt = Date.now();
    const outcome = await this.probe.probe(modelId, key);
    const elapsedMs = Date.now() - startedAt;

    // ★ 不记录 key 本身，只记录"某次试通的结果"
    this.logger.log(
      `上游访问密钥试通：model=${modelId} ok=${outcome.ok} elapsed=${elapsedMs}ms` +
        (outcome.upstreamCode === null ? '' : ` upstreamCode=${outcome.upstreamCode}`),
    );

    return {
      ok: outcome.ok,
      model: modelId,
      elapsedMs,
      upstreamCode: outcome.upstreamCode,
      httpStatus: outcome.httpStatus,
      reason: outcome.reason,
    };
  }

  /**
   * 启用 / 停用目录里的一个模型。
   * 「停用」只影响本服务是否把它算作可用，**不删行**（订阅以后可能又开）。
   */
  setEnabled(id: string, enabled: unknown, providerId?: string): { id: string; enabled: boolean } {
    if (typeof enabled !== 'boolean') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'enabled 必须是布尔值',
      });
    }
    /* [v0.5.1] 同 id 可能存在于多家分区：全部同步切换（界面开关是模型级，不分子提供商）。 */
    const hits = (providerId ? this.catalog.all(providerId) : this.catalog.allAcross(this.activeIds())).filter((r) => r.id === id);
    if (hits.length === 0) {
      throw new RelayHttpError({
        httpStatus: 404,
        code: 'not_found',
        apiCode: ApiCode.NOT_FOUND,
        message: `模型目录里没有 ${id}`,
      });
    }
    for (const hit of hits) this.catalog.setEnabled(hit.provider_id, id, enabled);
    return { id, enabled };
  }

  /** 表里最多来源的那个（契约的 `source` 是单值）。 */
  private dominantSource(sources: string[]): string {
    if (sources.length === 0) return 'seed';
    const counts = new Map<string, number>();
    for (const s of sources) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best = sources[0]!;
    let bestCount = 0;
    for (const [src, n] of counts) {
      if (n > bestCount) {
        best = src;
        bestCount = n;
      }
    }
    return best;
  }
}
