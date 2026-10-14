/**
 * 目录同步编排（task#18；task 倍率接口化并入 /v3/config）：
 *   [v1.5.0] 纯接口口径（用户拍板）：目录 = 上游清单接口本轮返回的列表，**替换式**落库
 *   （replaceSync，manual 行保留）；拉取失败保留旧目录（不倒退）。observed 机制与
 *   Qoder 内置种子回落已废除 ——「客户端没给就是没有」。唯一例外：MiniMax（anthropic）
 *   上游无清单端点（实测 /models 恒 503），静态种子是它的唯一目录来源。
 *   倍率仍以 /v3/config 接口为权威（随清单一起合成）。逐项实测仅手动刷新。
 *
 * 从 models.service 抽出，原因：models.service 已越过 300 行门禁，
 * 且「拉取 + 合并 + 落库 + 探测」是独立于「目录视图」的一条职责链。
 *
 * 失败语义：拉取失败保留旧目录并如实汇报（pullOk=false）；只有「未配置凭证」
 * 与「冷却中」才对调用方可见（分别是 400 / 429）。
 *
 * 每日静默同步：官方促销/调价会让快照倍率过期（实测 space-bunny 0.03→0.08），
 * 故除手动刷新外，每 24h 自动做一次「拉取+合并+落库」（**不**逐项实测 ——
 * 实测真打上游、真消耗积分，只留给用户显式触发）。
 */

import {
  Inject,
  Injectable,
  Optional,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { ModelCatalogRepository, type ModelCatalogRow, type CatalogUpsert } from '../store/repositories/model-catalog.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ProvidersRepository, type ProviderRow } from '../store/repositories/providers.repo';
import { RelayHttpError, ApiCode } from '../common/errors';
import { ModelProbeService, PROBE_INTERVAL_MS } from './probe';
import { pullUpstreamModels, type CatalogEntry } from './pull';
import { fetchV3ConfigModels } from './v3-config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../store/db';
import { stripTrailingSlash } from '../proxy/upstream-url';
import { pullQoderModels } from './qoder-models';
import { QoderCredentialStore } from '../proxy/qoder-upstream/credential';

/**
 * [v0.5.0] MiniMax（anthropic 协议）的静态模型种子。
 *
 * 为什么静态而不是拉取：mavis 网关没有公开的模型清单端点（清单内置于客户端目录），
 * 且逐项实测走的是 openai 方言（对 anthropic 上游必然失败）。这 4 个模型
 * 来自官方开源 CLI 的 minimax-model-catalog.ts。上游上新时更新这份清单。
 */
const MINIMAX_SEED_MODELS = [
  { id: 'MiniMax-M3', displayName: 'MiniMax-M3', tag: null as string | null, multiplier: NaN },
  { id: 'MiniMax-M3.1-Flash-Preview', displayName: 'M3.1-Flash-Preview', tag: null as string | null, multiplier: NaN },
  { id: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7', tag: null as string | null, multiplier: NaN },
  { id: 'MiniMax-M2.7-highspeed', displayName: 'M2.7-highspeed', tag: null as string | null, multiplier: NaN },
];

/** 同一分钟内只生效一次的窗口。 */
const REFRESH_COOLDOWN_MS = 60_000;
/** 拉取目录的超时。 */
const PULL_TIMEOUT_MS = 15_000;
/** 倍率静默同步周期：官方促销/调价按天轮换，一天刷一次足够。 */
const DAILY_SYNC_MS = 24 * 60 * 60 * 1000;

export interface RefreshResult {
  checked: number;
  ok: number;
  failed: string[];
  source: string;
  /** 上游模型清单是否拉到（false = 保留旧目录未替换）。 */
  pulled: boolean;
  /** /v3/config 真实倍率表是否拉到（false = 倍率沿用本地快照）。 */
  configPulled: boolean;
  /** 本次同步倍率有变化的模型数（接口值覆盖了过期快照，或补上了未知项）。 */
  multipliersUpdated: number;
  /** 本次同步新增的模型数（含上游新模型与首次观测到的模型）。 */
  added: number;
  /** [v1.5.3] 按家明细 —— 单家抽屉里显示全库合计（52）会让用户以为数字对不上。 */
  perProvider: Array<{ id: string; name: string; checked: number; ok: number; failed: string[] }>;
}

/** 一次「拉取 + 合并 + 落库」的内部结果（手动刷新与每日静默同步共用）。 */
interface SyncOutcome {
  pullOk: boolean;
  configOk: boolean;
  added: number;
  multipliersUpdated: number;
}

function rowsToEntries(rows: ModelCatalogRow[]): CatalogEntry[] {
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    family: r.family,
    tag: r.tag,
    multiplier: r.multiplier,
    source: r.source,
    verified: r.verified === 1,
    enabled: r.enabled === 1,
  }));
}

function entriesToUpserts(entries: CatalogEntry[]): CatalogUpsert[] {
  return entries.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    source: e.source,
    multiplier: e.multiplier,
    tag: e.tag,
  }));
}

/**
 * 串行实测间隔的注入令牌。
 *
 * 为什么需要它：`probeIntervalMs` 是原始类型 `number`，而 Nest 的类型反射
 * 无法解析原始类型 —— 若只在构造参数上写 `: number`，容器会去 IoC 里找一个
 * 名为 `Number` 的 provider，找不到就抛 `UnknownDependenciesException`，
 * **整个应用启动失败**。这类装配缺陷单测抓不到（直接 `new` 绕过容器），
 * 只有真启动能暴露，故必须用显式 `@Inject(token)` + 模块里的值 provider。
 *
 * 语义上它是**契约常量**（实测节流 200ms，见 probe.ts 的 PROBE_INTERVAL_MS），
 * 不是可部署配置项，因此不进 settings.json，保持「代码常量 + 令牌注入」。
 */
export const CATALOG_PROBE_INTERVAL_MS = 'CATALOG_PROBE_INTERVAL_MS';

@Injectable()
export class CatalogSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncService.name);
  /** 上次**成功**刷新时刻；null = 从未刷新。 */
  private lastRefreshAt: number | null = null;
  /** 正在刷新中：并发调用直接 429；每日静默同步遇它则让路跳过。 */
  private refreshing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: RelayConfigService,
    private readonly catalog: ModelCatalogRepository,
    private readonly probe: ModelProbeService,
    /** 按提供商记住启停偏好（2026-10-09）—— 切换提供商机用。 */
    private readonly prefs: ProviderModelPrefsRepository,
    /** 串行实测间隔；默认按契约 200ms，测试可传 0 加速。 */
    @Inject(CATALOG_PROBE_INTERVAL_MS) private readonly probeIntervalMs: number = PROBE_INTERVAL_MS,
    /* [v0.5.0] 活提供商协议（anthropic 时目录走静态种子，不拉不测）。
       @Optional：既有 spec 按位置构造，末位新增不破坏它们。 */
    @Optional() private readonly providers?: ProvidersRepository,
  ) {}

  /** 活提供商集合（[v0.5.1] 多生效：列表而非单行）。未装配 providers 时返回空。 */
  private activeProviders(): ProviderRow[] {
    return this.providers?.listActive() ?? [];
  }

  /** openai 提供商的出站凭证（读该提供商凭证文件，回落全局位 —— 与 proxy 同规则）。 */
  private openAiCredential(provider: ProviderRow): string {
    try {
      const key = readFileSync(join(resolveDataDir(), 'providers', `${provider.id}.key`), 'utf8').trim();
      if (key) return key;
    } catch {
      /* 回落全局位 */
    }
    return this.config.upstreamKey;
  }

  /** [v0.5.1] anthropic 提供商的目录：静态种子（无上游清单端点、不做方言实测）。 */
  private seedMinimaxCatalog(providerId: string): SyncOutcome {
    const { inserted } = this.catalog.mergeSync(providerId, MINIMAX_SEED_MODELS.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      source: 'seed' as const,
      multiplier: null,
      tag: m.tag,
    })));
    return { pullOk: false, configOk: false, added: inserted, multipliersUpdated: 0 };
  }

  /**
   * [v0.6.0] Qoder 目录：真拉取（/model/list）+ 种子回落。
   * 目录 id = 网关内部 key（qfmodel…）—— 见 catalog/qoder-models.ts 的设计说明。
   * 拉取失败不覆盖已有目录（保留上次成功结果，与 openai 路线同纪律）。
   */
  private async pullQoderCatalog(provider: ProviderRow): Promise<SyncOutcome> {
    try {
      const store = new QoderCredentialStore();
      const { identity, session } = store.session(provider.id);
      const entries = await pullQoderModels({
        baseUrl: stripTrailingSlash(provider.base_url),
        identity,
        session,
        timeoutMs: PULL_TIMEOUT_MS,
      });
      /* [v1.5.0] 替换式（纯接口口径）：网关 /model/list 返回什么就是什么；
         内置种子回落已废除（"客户端没给就是没有"）。 */
      this.catalog.replaceSync(provider.id, entries);
      return { pullOk: true, configOk: false, added: entries.length, multipliersUpdated: 0 };
    } catch (err) {
      /* 拉取失败：保留旧目录（不倒退，也不回落种子）。 */
      this.logger.warn(`Qoder 目录拉取失败（保留旧目录）：${(err as Error).message}`);
      return { pullOk: false, configOk: false, added: 0, multipliersUpdated: 0 };
    }
  }

  /**
   * 启动即静默同步一次倍率（补上停机期间的官方调价），随后每 24h 一次。
   * [v0.5.1] 对**每个**生效提供商各同步各的（目录按提供商分区）。
   * 只拉取+合并，不实测（实测消耗积分，仅手动触发）。失败只记 debug，不影响启动。
   */
  onApplicationBootstrap(): void {
    /* [v1.5.0] observed 机制已废除（纯接口口径）：启动幂等清掉历史 observed 行。 */
    const purged = this.catalog.purgeObserved();
    if (purged > 0) {
      this.logger.log(`模型目录：清理 ${purged} 个历史 observed 行（机制已废除，目录以接口清单为准）`);
    }
    this.safeDailySync();
    this.timer = setInterval(() => this.safeDailySync(), DAILY_SYNC_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 上次成功刷新时刻（epoch 毫秒），供目录视图展示 `fetchedAt`。null = 从未刷新。 */
  get lastFetchedAt(): number | null {
    return this.lastRefreshAt;
  }

  /**
   * [v0.5.1] 提供商**启用**后的目录同步：拉取/种子合并进它自己的分区，
   * **不动别家**（多生效的核心约束 —— 旧版「清空重建」属于单活切换语义，已废弃）。
   * 启停偏好天然保留（不清空就没丢），这里只做新行的偏好恢复（历史快照）。
   */
  async syncProviderOnEnable(providerId: string): Promise<void> {
    const provider = this.providers?.findById(providerId);
    if (!provider) return;
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.pullAndMergeFor(provider);
      const saved = this.prefs.load(providerId);
      if (saved.length > 0) {
        for (const p of saved) this.catalog.setEnabled(providerId, p.modelId, p.enabled);
      }
      this.lastRefreshAt = Date.now();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 同步刷新：拉上游 + 拉倍率 → **替换式**落库（v1.5.0 纯接口口径）→ 逐项实测。
   * 冷却中 / 进行中 → 429；未配置凭证 → 400。
   */
  async refresh(): Promise<RefreshResult> {    const now = Date.now();
    if (this.refreshing) {
      throw this.tooSoon('已有一次刷新正在进行中', REFRESH_COOLDOWN_MS / 1000);
    }
    if (this.lastRefreshAt !== null && now - this.lastRefreshAt < REFRESH_COOLDOWN_MS) {
      const wait = Math.ceil((REFRESH_COOLDOWN_MS - (now - this.lastRefreshAt)) / 1000);
      throw this.tooSoon('刷新过于频繁（同一分钟内只生效一次）', wait);
    }
    /* [v0.5.1] 多生效：对每个生效提供商各拉各测；凭证按提供商（文件 → 全局回落）。
       anthropic 提供商不做凭证检查与 openai 方言实测（种子即权威）。
       [v0.6.0] qoder 用自家凭证（身份 JSON 文件），也不进 openai 方言实测。
       凭证前置检查只在**全是 openai** 时生效（早期的"无 key 拉不到东西"友好报错）——
       混有 anthropic/qoder 时不能整体拦下：那会把能同步的家一起挡在门外
       （E2E 实测踩过：qoder 单独可用，却因 openai 默认行无凭证而整轮 400）。 */
    const actives = this.activeProviders();
    const openAiActives = actives.filter((p) => p.protocol === 'openai');
    if (
      openAiActives.length > 0 &&
      openAiActives.length === actives.length &&
      openAiActives.every((p) => !this.openAiCredential(p))
    ) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'upstream_credential_missing',
        apiCode: ApiCode.BAD_PARAM,
        message: '未配置上游访问密钥（RELAY_UPSTREAM_KEY），无法实测模型。请先配置后重启服务。',
      });
    }

    this.refreshing = true;
    try {
      let totalAdded = 0;
      let totalMultUpdated = 0;
      let anyPullOk = false;
      let anyConfigOk = false;
      const failed: string[] = [];
      let okCount = 0;
      let checked = 0;
      const perProvider: Array<{ id: string; name: string; checked: number; ok: number; failed: string[] }> = [];

      for (const provider of actives) {
        // ①+② 拉清单 + 拉倍率 → 合并三路并落库（只增不减，倍率接口权威）
        const outcome = await this.pullAndMergeFor(provider);
        totalAdded += outcome.added;
        totalMultUpdated += outcome.multipliersUpdated;
        anyPullOk = anyPullOk || outcome.pullOk;
        anyConfigOk = anyConfigOk || outcome.configOk;

        // ③ 逐项实测（严格串行 + 固定间隔）—— anthropic / qoder 跳过（方言不符，清单即权威）
        const rows = this.catalog.all(provider.id);
        if (provider.protocol === 'anthropic' || provider.protocol === 'qoder') {
          checked += rows.length;
          okCount += rows.length;
          perProvider.push({ id: provider.id, name: provider.name, checked: rows.length, ok: rows.length, failed: [] });
          continue;
        }
        const key = this.openAiCredential(provider);
        const outcomes = await this.probe.probeAll(
          rows.map((r) => r.id),
          this.probeIntervalMs,
          key,
          stripTrailingSlash(provider.base_url),
        );
        const pFailed: string[] = [];
        let pOk = 0;
        for (const o of outcomes) {
          checked += 1;
          if (o.ok) {
            okCount += 1;
            pOk += 1;
            this.catalog.setVerified(provider.id, o.id, true);
          } else {
            failed.push(o.id);
            pFailed.push(o.id);
            // ★ 标 0，**不删除**：订阅以后可能又开
            this.catalog.setVerified(provider.id, o.id, false);
          }
        }
        perProvider.push({ id: provider.id, name: provider.name, checked: outcomes.length, ok: pOk, failed: pFailed });
      }

      this.lastRefreshAt = Date.now();
      this.logger.log(
        `模型目录同步（${actives.length} 家生效）：pull=${anyPullOk ? 'upstream' : 'fallback'} ` +
          `config=${anyConfigOk ? 'v3' : 'snapshot'} multUpdated=${totalMultUpdated} ` +
          `added=${totalAdded} checked=${checked} ok=${okCount} failed=${failed.length}`,
      );

      return {
        checked,
        ok: okCount,
        failed,
        source: anyPullOk ? 'upstream' : this.dominantSource(this.catalog.allAcross(actives.map((p) => p.id)).map((r) => r.source)),
        pulled: anyPullOk,
        configPulled: anyConfigOk,
        multipliersUpdated: totalMultUpdated,
        added: totalAdded,
        perProvider,
      };
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 拉取 + 落库（按提供商；手动刷新、每日静默同步、启用同步共用；不含实测）。
   * [v1.5.0] 纯接口口径（用户拍板）：目录 = 上游清单接口本轮返回的列表（**替换式**，
   * replaceSync）；拉取失败 → 保留旧目录不动（网络失败 ≠ 上游没有，不倒退也不清空）。
   * observed/种子合并全部废除；MiniMax 例外（上游无清单端点，种子是唯一来源）。
   */
  private async pullAndMergeFor(provider: ProviderRow): Promise<SyncOutcome> {
    /* anthropic 协议：不拉上游（无清单端点）—— 静态种子（唯一例外，见方法注释）。 */
    if (provider.protocol === 'anthropic') return this.seedMinimaxCatalog(provider.id);
    /* qoder 协议：网关有 /model/list —— 真拉取，替换式。 */
    if (provider.protocol === 'qoder') return await this.pullQoderCatalog(provider);
    const base = stripTrailingSlash(provider.base_url);
    const key = this.openAiCredential(provider);
    const [pull, config] = await Promise.all([
      pullUpstreamModels({ baseUrl: base, upstreamKey: key, timeoutMs: PULL_TIMEOUT_MS }),
      fetchV3ConfigModels({ baseUrl: base, upstreamKey: key, timeoutMs: PULL_TIMEOUT_MS }),
    ]);

    /* 拉取失败：保留旧目录（不倒退）。config（倍率）单独失败不拦替换 —— 倍率沿清单
       自带的 null/旧值，倍率接口下次成功再刷新。 */
    if (!pull.ok) {
      return { pullOk: false, configOk: config.ok, added: 0, multipliersUpdated: 0 };
    }

    /* [v0.4.16] 两路上游先**合成一路** —— 同 id 时 tag 取模型清单（badge 只在清单返回）、
       倍率取 /v3/config（接口倍率权威）、displayName 取模型清单（订阅侧权威）。 */
    const upstream = this.combineUpstream(pull.models, config.models);

    const before = new Map(rowsToEntries(this.catalog.all(provider.id)).map((e) => [e.id, e.multiplier]));
    this.catalog.replaceSync(provider.id, entriesToUpserts(upstream));

    let multipliersUpdated = 0;
    for (const e of upstream) {
      if (e.multiplier !== null && e.multiplier !== before.get(e.id)) multipliersUpdated += 1;
    }

    return { pullOk: true, configOk: config.ok, added: upstream.length, multipliersUpdated };
  }

  /** 两路上游合成：同 id 时 tag 取模型清单、倍率取 /v3/config（理由见 pullAndMerge 注释）。 */
  private combineUpstream(pullModels: CatalogEntry[], configModels: CatalogEntry[]): CatalogEntry[] {
    const byId = new Map<string, CatalogEntry>();
    for (const p of pullModels) byId.set(p.id, p);
    for (const c of configModels) {
      const prev = byId.get(c.id);
      byId.set(c.id, prev ? { ...prev, multiplier: c.multiplier ?? prev.multiplier } : c);
    }
    return [...byId.values()];
  }

  /** 每日静默同步的安全壳：并发让路、异常只记不抛。 */
  private safeDailySync(): void {
    if (this.refreshing) return; // 手动刷新在做同样的事（且更多），让路
    const actives = this.activeProviders();
    if (actives.length === 0) return;
    if (actives.every((p) => p.protocol !== 'anthropic' && !this.openAiCredential(p) && !this.config.upstreamConfigured())) return;
    /* [v0.5.1] 多生效：逐家同步，汇总一页日志。 */
    void (async () => {
      const results = await Promise.allSettled(actives.map((p) => this.pullAndMergeFor(p)));
      let pullOk = false, configOk = false, added = 0, mult = 0;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        pullOk = pullOk || r.value.pullOk;
        configOk = configOk || r.value.configOk;
        added += r.value.added;
        mult += r.value.multipliersUpdated;
      }
      const o = { pullOk, configOk, added, multipliersUpdated: mult };
      this.lastRefreshAt = Date.now();
      if (o.configOk || o.pullOk || o.multipliersUpdated > 0 || o.added > 0) {
        this.logger.log(
          `模型目录静默同步（${actives.length} 家生效）：pull=${o.pullOk ? 'upstream' : 'fallback'} ` +
            `config=${o.configOk ? 'v3' : 'snapshot'} multUpdated=${o.multipliersUpdated} added=${o.added}`,
        );
      } else {
        this.logger.debug(`模型目录静默同步全部回落：${new Date().toISOString()}`);
      }
    })().catch((err: unknown) => {
      this.logger.warn(`模型目录静默同步失败（不影响服务）：${(err as Error).message}`);
    });
  }

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

  private tooSoon(prefix: string, retryAfterSeconds: number): RelayHttpError {
    return new RelayHttpError({
      httpStatus: 429,
      code: 'refresh_rate_limited',
      apiCode: ApiCode.RATE_LIMITED,
      message: `${prefix}。请 ${retryAfterSeconds} 秒后再试。`,
      data: { retryAfterSeconds },
    });
  }
}
