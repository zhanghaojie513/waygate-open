/**
 * `GET /api/overview` 的聚合逻辑（api-contract §3.4）。
 *
 * ★ 本文件承载契约里最硬的一条约束：
 *   `byModel` 的 credits 之和 === `byClient` 的 credits 之和 === `metrics.creditsUsed`，
 *   三者**由同一次聚合产出并断言相等**，差值为 0 才返回，否则记 warn 并返回修正后的值。
 *
 * 为什么不能用 `aggregates` 表直接读：
 *   `requests.repo.ts` 只往 aggregates 写了 `(hour, model)`、`(hour, client)`、
 *   `(hour, status)`、`(hour, total)` 和 `(day, total)` —— **天桶没有 model/client 维度**。
 *   而 7d / 30d 窗口必须按天聚合。若 byModel 走聚合表、metrics 走 requests 表，
 *   两个数据源一定会因"最后一次写入不完整"或"清理任务删了 aggregates"而漂移，
 *   且漂移是静默的（前端只会看到两个加起来不对的数字）。
 *
 *   因此这里**统一以 `requests` 表为单一数据源**做一次查询，
 *   三个数字天然同源，不需要"修正"就能相等。
 *   （ADR-002 说 aggregates 是控制台读源，但那条**从未接线**：`AggregatesRepository.trend()`
 *     到今天仍无调用方，见该方法的注释与 schema.sql §2 的更正。aggregates 现在的实际职责是
 *     `verify-all.mjs` A11 一致性闸的对照物；数据量 < 10 万条时 requests 表分组聚合 < 10ms，
 *     优先保证口径正确。）
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../store/db';
import { createStmtCache } from '../store/cached-stmt';
import { fillEmptyBuckets, markPartialBuckets, round2, round2OrNull, share, toIso, type WindowSpec, windowRange } from './window';
import { resolveClientName } from './client-name';
import { computeCacheHitRate } from './token-metrics';
import { detectTool } from '../identify/ua-table';
import { QuotaSourceService } from '../proxy/quota/quota-source.service';
import { MinimaxCreditService, type CreditLedgerBlock } from '../proxy/anthropic-upstream/minimax-credit.service';
import { QoderActivityService } from '../proxy/qoder-upstream/qoder-activity.service';
import type { QuotaBlock } from '../proxy/quota/quota-block';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';

// `QuotaBlock` 类型现由 `proxy/quota/quota-block.ts` 提供（task#53：额度来源接入后，
// 「快照 → 响应块」的映射与类型都归到额度模块，本服务只消费）。这里再导出一次，保持既有引用路径不破。
export type { QuotaBlock };

/**
 * 渠道校验（11128）告警口径（方案 E，2026-10-07）：**固定最近 1 小时**、与概览窗口选择无关。
 * 背景：10/06 的 11128 故障持续 2 小时控制台零提示，排障耗掉一整晚——「无告警」是结构性缺陷。
 * 阈值 3 次：单次可能是指纹表漏网（已有降级重试兜底），连续出现才是需要人看的事件。
 */
export const CHANNEL_REJECT_WINDOW_MS = 60 * 60 * 1000;
export const CHANNEL_REJECT_ALERT_THRESHOLD = 3;

/** [v0.5.11] 趋势 tooltip 里每桶展示的模型条数（按 token 排序取前 N）。 */
export const TREND_TOP_MODELS = 5;

/** [v0.5.18] 客户端 tooltip 里展示的模型条数（按 token 排序取前 N，与趋势同款）。 */
export const CLIENT_MODEL_SLICE = 5;

/** 趋势桶内的按模型 token 切片（tooltip 用，见 build() 里的说明）。 */
export interface TrendModelSlice {
  model: string;
  tokens: number;
}

export interface OverviewPayload {
  window: string;
  generatedAt: string;
  /** 固定窗口（1h）的告警块，不随 window 参数变化。 */
  alerts: {
    /** 上游渠道校验（11128）拒绝次数与横幅阈值；count ≥ threshold 时前端概览页展示告警横幅。 */
    channelReject: { count: number; threshold: number };
    /** [2026-10-17] 上游访问密钥失效（note=upstream_credential_invalid）：停摆级，阈值 1。 */
    credentialInvalid: { count: number; threshold: number };
  };
  quota: QuotaBlock;
  /** [v0.5.7] 各提供商的**真实**积分账本（MiniMax 有；WorkBuddy 的上游未提供）。 */
  creditLedgers: CreditLedgerBlock[];
  metrics: {
    /** 本窗口请求总数（**含**模型解析前被本地拒绝的行 —— 被拒也是一次请求）。 */
    requests: number;
    /**
     * 本窗口 `errors` 条数（status >= 400，含本地 429 拒绝）。
     * `successRate = (requests - errors) / requests`。
     */
    errors: number;
    /**
     * [2026-10-18] 本窗口 `model = ''` 的行数 —— 模型解析前就被本地拒绝
     * （实测全是 429 并发闸）。它们计入 `requests`，但不进 `byModel` / `byClient` /
     * `byProvider` 摘要（空 model 不属于任何模型，也不该冒充「未归属」）。
     * 因此 `ΣbyModel.requests = metrics.requests - requestsWithoutModel` 是**预期**，
     * 不是 bug —— 前端要解释差值时用这个字段。
     */
    requestsWithoutModel: number;
    /**
     * 本窗口积分合计 = `SUM(requests.credits)` —— 只含**上游实扣**（`usage.credit`）。
     * 上游未回报的行（`credits IS NULL`）对合计贡献 0，其条数见 `creditsUnknownCount`。
     */
    creditsUsed: number;
    successRate: number;
    avgLatencyMs: number;
    /**
     * [v1.7.2] 首字节 P95（毫秒）。**只统计测到首字节的行**（`first_byte_ms IS NOT NULL`）；
     * 样本为 0 时为 `null`（未知），不是 0 —— 与积分那条口径同源。
     * 口径：从**鉴权完成**到首字节（含我方路由/凭证 + 上游排队），见 schema.sql。
     */
    firstByteP95: number | null;
    /**
     * [v1.7.2] 我方开销均值（毫秒）= mean(auth_ms + prep_ms)，只统计两段都测到的行。
     * `null` = 没有可用样本（迁移前的老行全无此数据），不是 0。
     * 这是回答「我们慢不慢」的直接指标 —— 与上游快慢无关。
     */
    selfMsAvg: number | null;
    /** [v1.7.2] 上游等待均值（`upstream_wait_ms`），只统计测到的行；`null` = 无样本。 */
    upstreamWaitMsAvg: number | null;
    activeClients: number;
    /** 本窗口输入（prompt）tokens 合计。 */
    promptTokens: number;
    /** 本窗口输出（completion）tokens 合计。 */
    completionTokens: number;
    /** 本窗口总 tokens 合计。 */
    totalTokens: number;
    /** 本窗口缓存命中的 prompt tokens 合计。 */
    cachedTokens: number;
    /**
     * 缓存命中率 = cachedTokens / promptTokens，取值 0..1（口径见 `token-metrics.ts`）。
     * **为 0 就是 0**（DeepSeek 系真实返回 0），前端不得回退到「上游未提供」文案。
     */
    cacheHitRate: number;
    /**
     * [v0.5.8] 本窗口内 `requests.credits IS NULL` 的行数 —— 即「上游没回报积分、
     * 本服务不估算」的请求条数。**必须与 `creditsUsed` 一起展示**，否则那个合计
     * 看起来像「全部消耗」，而它其实只是**已知部分**。
     */
    creditsUnknownCount: number;
  };
  trend: Array<{
    bucket: string;
    requests: number;
    credits: number;
    tokens: number;
    errors: number;
    models: TrendModelSlice[];
    /**
     * [v1.6.31] 本桶是否只覆盖窗口的**一部分**（首/末桶常态）。
     * 数字仍是真实的（只统计窗口内），但不足一整格 —— 前端 tooltip 据此注明，
     * 避免把「半小时的桶」读成「一整个小时」。
     */
    partial: boolean;
  }>;
  byModel: Array<{
    model: string;
    displayName: string | null;
    /**
     * 当前模型倍率；`null` = **倍率未知**（目录里没有该模型 / 上游 `/v3/config` 未覆盖）。
     * [v0.5.8] 它**只描述倍率本身**：积分不再依赖倍率（一律取上游实扣），故倍率未知
     * **不影响** `credits` 的可信度 —— `credits` 可不可信只看它是不是 `null`。
     */
    multiplier: number | null;
    /**
     * 模型的计价标签（限时免费 / 限时折扣 / 夜间折扣 / 订阅优先），`null` = 无标签。
     *
     * [2026-10-08] 这是**直接有金钱价值**的信息（"这个模型现在免费"），
     * 而 `model_catalog.tag` 一直在库里、也一直是 `/api/models` 的字段，
     * 只是用量页的「按模型消耗明细」没有渲染它。这里随同一次查询带出来。
     */
    tag: string | null;
    requests: number;
    /** [v0.5.2] 本窗口总 tokens（prompt+completion）—— 与积分并排回答"哪个模型在吃量"。 */
    tokens: number;
    /**
     * 本窗口积分（上游实扣）。
     *
     * [v0.6.4] **可空**：窗口内该模型**全部请求都未回报 credit** 时为 `null`
     * （MiniMax 系实测：usage 里没有 credit 字段，只扣账本）—— 前端渲染 `--`，
     * **不再**因 `COALESCE(...,0)` 而显示成「0 积分」（那会被读成免费，与事实相反）。
     * 有任一真实回报时 = SUM（NULL 行按 0 计，与 `metrics.creditsUsed` 同口径）。
     */
    credits: number | null;
    /** [v0.6.4] 窗口内该模型「上游未回报积分」的行数（配合 `credits === null` 说明原因）。 */
    creditsUnknownCount: number;
    /**
     * **Token 占比**（分母 = 本窗口 tokens 合计）。
     *
     * [v0.5.18 改口径] 原为积分占比。改的原因：用量页与概览页的模型/客户端表
     * **都按 tokens 排序**（v0.5.11 起 token 是该页主量纲），占比却按积分算 ——
     * 表格自上而下百分比不再单调、条形长度与排序顺序互相矛盾（用户实测报障）。
     * 现统一为 token 占比，与排序键、与条形长度同源。
     *
     * 由**服务端**算：api-contract §3.4 明令前端不得自行求和再相除
     * （各页各算一份会让同一组数字出现两个值）。
     */
    share: number;
  }>;
  /* [v0.5.2] byClient 加 tokens：客户端摘要与模型摘要同口径。
   * [v0.5.15] 归属口径改为「**哪个客户端服务的**」：按 模型id → 目录 provider 解析
   * （与请求日志「提供商」列同源，见 ModelsService.get() 的 provider 映射），
   * 模型不在任何生效目录里的行回落到密钥绑定名。
   * 此前按 `client_id`（= 密钥）归属：双绑定密钥（wb：WorkBuddy + MiniMax Code）的
   * **全部**流量都记在第一个绑定下 —— E2E 清理删掉 mini 密钥唯一的探测行后，
   * 摘要里 MiniMax Code 整条消失，暴露了这个口径错位。 */
  byClient: Array<{
    clientId: string;
    client: string;
    requests: number;
    tokens: number;
    /**
     * 本桶积分。**null = 该桶全部请求上游都未回报费用（未知）**，前端显示 `--`；
     * 只要有一条回报过就是已知部分之和（未知当 0）。与 `byModel` 同构（2026-10-18）。
     */
    credits: number | null;
    share: number;
    /**
     * [v0.5.18] 该客户端消耗的**模型切片**（按 tokens 降序取前 `CLIENT_MODEL_SLICE` 个）。
     * 供两页「按客户端」模块的悬停提示回答「这个客户端的量花在哪些模型上」。
     * 被截断时以 `modelCount` 如实标注，完整明细看「按模型消耗明细」表。
     */
    models: Array<{
      model: string;
      displayName: string | null;
      requests: number;
      tokens: number;
      /** 同上：null = 该模型在本桶内全部未回报。 */
      credits: number | null;
      /** 本桶内该模型未回报费用的请求条数（前端据此解释 `--`）。 */
      creditsUnknownCount: number;
    }>;
    /** 该客户端命中的**真实模型数**（可能 > models.length，见上）。 */
    modelCount: number;
  }>;
  /**
   * [v0.6.0] 按**目录归属的提供商**聚合用量 —— 提供商表那行的
   * 「请求次数 / 消耗积分 / 最后活跃」直接取这里（此前前端只能靠
   * 「只有一家启用时可归属」的保守推断，多生效下恒为 —）。
   *
   * 归因与请求日志「提供商」列、byClient 完全同源（模型 id → 生效目录的 provider）。
   * `providerId/provider` 为 `null` 的桶 = 窗口内有请求的模型不在任何生效目录里
   * （老日志/目录被删），前端显示「未归属」，**不冒充任何一家**。
   * 不变式：ΣbyProvider.credits（null 当 0）=== ΣbyClient.credits === metrics.creditsUsed。
   */
  byProvider: Array<{
    providerId: string | null;
    provider: string | null;
    requests: number;
    tokens: number;
    /** null = 该提供商名下全部请求都未回报费用（未知）→ 前端显示 `--`（与 byClient 同构）。 */
    credits: number | null;
    /** epoch ms；该提供商名下所有模型最近一次请求时刻。null = 无数据。 */
    lastSeenAt: number | null;
  }>;
  /**
   * [2026-10-08] 按「请求来自哪个工具」聚合（从 `requests.ua` 现解析，见 `identify/ua-table.ts`）。
   *
   * 与 `byClient` 是**两个不同的问题**：
   *   · `byClient` 回答「哪个客户端服务的」（模型→目录 provider，见上）
   *   · `byTool`   回答「哪个工具发的」（UA 判定）
   * 同一把密钥被多个工具共用时，两者才会分开 —— 那正是需要在界面上看见的情形。
   *
   * `tool` 为 `null` 的行是「UA 认不出来」（没采到 UA / UA 不在关键词表里），
   * 前端渲染成「未识别」，**不编造工具名**。
   */
  byTool: Array<{
    tool: string | null;
    requests: number;
    /** [v0.5.18] 本工具总 tokens —— 与 byModel/byClient 同口径（占比也据此算）。 */
    tokens: number;
    credits: number;
    /** **Token 占比**（与 byModel/byClient 同口径，见其说明）。 */
    share: number;
  }>;
  /**
   * [2026-10-08] **认不出来的 UA 原文**及其请求数（TOP 10），`byTool` 里 `tool: null` 那桶的证据。
   *
   * 为什么要单独给原文：`byTool` 把它压成了一个「未识别」总数，而**改进关键词表需要的
   * 恰恰是原文**（"到底是什么客户端"）。没有这一项，那桶就是一个死胡同：
   * 界面上只说"有 4 条认不出来"，用户无从判断该往表里加什么。
   *
   * 只取 TOP 10：自用场景下 UA 种类是个位数到几十种，而界面上是为了**决策**（加哪个关键词），
   * 前 10 个已覆盖绝大多数流量；全量交给 SQL 查询更合适。
   */
  unknownUas: Array<{ ua: string; requests: number }>;
  recent: Array<{
    id: number;
    ts: string;
    clientId: string;
    client: string;
    model: string;
    status: number;
    ms: number;
    /** [v0.5.8] `null` = 上游未回报该次费用（未知）。前端渲染 `--`，**不得**当成 0。 */
    credits: number | null;
    note: string;
  }>;
  provenance: { creditsUsed: string; quotaRemain: string; note: string };
}

interface TotalsRow {
  requests: number;
  errors: number;
  credits: number;
  /** [v0.5.8] `credits IS NULL` 的行数（上游未回报积分）。 */
  creditsUnknown: number;
  /** [2026-10-18] `model = ''` 的行数（模型解析前被本地拒绝，无模型归属）。 */
  requestsWithoutModel: number;
  avgMs: number;
  clients: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);
  /* 聚合查询语句按 SQL 文本缓存：概览是 4 个前端调用方共享的热路径，
     此前每次 build() 都内联 prepare —— 等于每个请求重付一遍语句编译。 */
  private readonly stmt: ReturnType<typeof createStmtCache>;

  constructor(
    /* db 只在构造时用来建语句缓存（属性形态已无读者）；注入仍走 DB_TOKEN。 */
    @Inject(DB_TOKEN) db: Db,
    private readonly quota: QuotaSourceService,
    /* [v0.5.7] 真实积分账本（MiniMax）。 */
    private readonly creditLedgers: MinimaxCreditService,
    /* [v0.5.15] byClient 按「模型→目录 provider」归属（全局 StoreModule 提供）。 */
    private readonly catalog: ModelCatalogRepository,
    private readonly providers: ProvidersRepository,
    /* [v1.6.0] Qoder 积分账本（v1.6.1 起余额口径）。@Optional 兼容既有 spec 直构。 */
    @Optional() private readonly qoderLedgers?: QoderActivityService,
  ) {
    this.stmt = createStmtCache(db);
  }

  build(spec: WindowSpec, now = Date.now()): OverviewPayload {
    const { from, to } = windowRange(spec, now);

    // ① 主聚合：**一次扫描**按 (client_id, model) 分组，总量 / byModel / byClient / byProvider /
    //    lastSeenAt 全部从这一份结果在 JS 里归并（此前是 4 条各扫一遍窗口的查询）。
    //    为什么可以合并：分组粒度 (client_id, model) 是这几个维度的公共细分 ——
    //    总量 = 全部组求和；byModel = 按 model 归并；byClient/byProvider 本就在 JS 里按此粒度归并。
    //    同源同扫描 → 「ΣbyModel === ΣbyClient === creditsUsed」由构造保证，不靠两次查询碰巧一致。
    //
    //    ★ 目录 / 密钥表在**聚合之后**才 JOIN（每组一行，而不是每条请求一行），更省也不会放大计数。
    //    ⚠️ 目录侧必须**先按 model id 去重**再 JOIN（v0.5.8 修的真实缺陷）：
    //      `model_catalog` 的主键是 `(provider_id, id)`（v0.5.1 起多提供商各存一份清单），
    //      同一个 model id 会同时出现在**多家 active 提供商**的清单里 —— 实测线上
    //      WorkBuddy 与 MiniMax Code 都收录了 `MiniMax-M3.1-Flash-Preview`。
    //      直接 JOIN 会**一组配出多行**，COUNT/SUM 成倍放大（线上占比 195% 的那次事故）。
    //      去重规则：同一 id 取 `provider_id` 最小的那条作代表 —— `requests` 表**不记录**
    //      服务方（无 provider_id 列），无法逐行归属，只能给一个**确定性**的代表值。
    //    ★ [v0.6.4] credits 保留 NULL 语义：`creditsRaw` 为 SUM（全 NULL 时为 NULL），
    //      配合 `knownCount` 区分「全部上游未回报」与「真的是 0」（见 byModel 映射处）。
    const groups = this.stmt(
        `WITH g AS (
           SELECT client_id, model, provider_id AS providerId,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
                  SUM(credits) AS creditsRaw,
                  SUM(CASE WHEN credits IS NOT NULL THEN 1 ELSE 0 END) AS knownCount,
                  SUM(ms) AS msSum,
                  SUM(prompt_tokens) AS promptTokens,
                  SUM(completion_tokens) AS completionTokens,
                  SUM(total_tokens) AS tokens,
                  SUM(cached_tokens) AS cachedTokens,
                  MAX(ts) AS lastTs,
                  MAX(key_hint) AS keyHint
             FROM requests WHERE ts >= ? AND ts < ?
               /* [2026-10-18 修正] 这里不再过滤 model <> ''。
                  此前过滤了，但注释写的是「metrics.requests 仍计入（被拒也是一次请求），
                  仅摘要剔除」—— 实现与注释相反（totals 就是从这份 groups 累加的），
                  于是 429 拒绝行既没进摘要、也没进计数：成功率虚高、
                  且与 trend/byTool（它们没有这个过滤）对不上。
                  现在统一：计数口径含全部行，摘要（byModel/byClient/byProvider）
                  在映射阶段剔除空 model，并把条数暴露为 requestsWithoutModel。 */
            GROUP BY client_id, model, provider_id
         )
         SELECT g.client_id AS clientId, g.model, g.providerId,
                g.requests, g.errors, g.creditsRaw, g.knownCount,
                g.msSum,
                g.promptTokens, g.completionTokens, g.tokens, g.cachedTokens, g.lastTs, g.keyHint,
                ck.client AS boundName, ck.name AS keyName, ck.id AS keyExistsId,
                mc.display_name AS displayName, mc.multiplier AS multiplier, mc.tag AS tag
           FROM g
           LEFT JOIN client_keys ck ON ck.id = g.client_id
           LEFT JOIN (
                  SELECT id, display_name, multiplier, tag,
                         ROW_NUMBER() OVER (PARTITION BY id ORDER BY provider_id) AS rn
                    FROM model_catalog
                   WHERE provider_id IN (SELECT id FROM providers WHERE active = 1)
                ) mc ON mc.id = g.model AND mc.rn = 1`,
      )
      .all(from, to) as Array<{
      clientId: string;
      model: string;
      /** [v1.6.30] 该组请求**实际路由到的**提供商 id；null = 老行（未记录）或本地拒绝。 */
      providerId: string | null;
      requests: number;
      errors: number;
      creditsRaw: number | null;
      knownCount: number;
      msSum: number;
      promptTokens: number;
      completionTokens: number;
      tokens: number;
      cachedTokens: number;
      lastTs: number;
      keyHint: string | null;
      boundName: string | null;
      keyName: string | null;
      keyExistsId: string | null;
      displayName: string | null;
      multiplier: number | null;
      tag: string | null;
    }>;

    // 总量：全部组求和（口径与原先的单条 SUM/AVG/COUNT DISTINCT 查询逐项等价）
    const totals: TotalsRow = {
      requests: 0,
      errors: 0,
      credits: 0,
      creditsUnknown: 0,
      requestsWithoutModel: 0,
      avgMs: 0,
      clients: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
    };
    let msSum = 0;
    const distinctClients = new Set<string>();
    for (const g of groups) {
      totals.requests += g.requests;
      totals.errors += g.errors;
      if (g.model === '') totals.requestsWithoutModel += g.requests;
      totals.credits += g.creditsRaw ?? 0;
      totals.creditsUnknown += g.requests - g.knownCount;
      totals.promptTokens += g.promptTokens;
      totals.completionTokens += g.completionTokens;
      totals.totalTokens += g.tokens;
      totals.cachedTokens += g.cachedTokens;
      msSum += g.msSum;
      distinctClients.add(g.clientId);
    }
    totals.avgMs = totals.requests ? msSum / totals.requests : 0;
    totals.clients = distinctClients.size;

    // byModel：按 model 归并。排序 = 原 SQL 的 `ORDER BY COALESCE(SUM(credits), -1) DESC LIMIT 20`
    // （全部未回报的模型排在 0 积分之后），并以 model id 作稳定的次序键。
    const modelAgg = new Map<
      string,
      {
        model: string;
        displayName: string | null;
        multiplier: number | null;
        tag: string | null;
        requests: number;
        tokens: number;
        creditsRaw: number | null;
        knownCount: number;
        /* [v1.6.8] 本模型总耗时（ms）。 */
        msSum: number;
      }
    >();
    for (const g of groups) {
      /* 空 model（模型解析前被本地拒绝，实测全是 429 并发闸）不属于任何模型：
         计数已在上面的 totals 里计过，这里只是不把它做成一行「未知模型」。 */
      if (g.model === '') continue;
      const m = modelAgg.get(g.model);
      if (!m) {
        modelAgg.set(g.model, {
          model: g.model,
          displayName: g.displayName,
          multiplier: g.multiplier,
          tag: g.tag,
          requests: g.requests,
          tokens: g.tokens,
          creditsRaw: g.creditsRaw,
          knownCount: g.knownCount,
          msSum: g.msSum,
        });
        continue;
      }
      m.requests += g.requests;
      m.tokens += g.tokens;
      m.msSum += g.msSum;
      // NULL 语义：两边都为 NULL 才保持 NULL，否则按「NULL 当 0」相加
      m.creditsRaw = m.creditsRaw === null && g.creditsRaw === null ? null : (m.creditsRaw ?? 0) + (g.creditsRaw ?? 0);
      m.knownCount += g.knownCount;
    }
    const modelSortKey = (m: { creditsRaw: number | null }): number => m.creditsRaw ?? -1;
    const modelRows = [...modelAgg.values()]
      .sort((a, b) => modelSortKey(b) - modelSortKey(a) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
      .slice(0, 20);

    // ★ 按 client_id（稳定标识）分组，不是 client（名字快照，会随改名失效）。
    //   显示名走回落链：绑定名 -> 密钥名 -> 已删除的密钥 · 掩码。
    //   `client_keys` 主键是 id，一组最多配一行，不存在模型那样的行放大。
    //   [v0.5.15] 归属改「模型→目录 provider」：在 JS 里用 providerByModel 归并成客户端桶；
    //   查不到 provider 的行回落密钥绑定名。
    const clientModelRows = groups
      .filter((g) => g.model !== '') // 摘要排除空 model（计数已在 totals 里）
      .map((g) => ({
      clientId: g.clientId,
      model: g.model,
      /* [v1.6.30] 真实路由结果。null = 迁移 018 之前的老行 —— 只有这些才回落到
         「模型 id → 目录 provider」反解（见 providerByModel 的用法）。 */
      providerId: g.providerId,
      requests: g.requests,
      tokens: g.tokens,
      /* [2026-10-18] 这里不能写 `g.creditsRaw ?? 0` —— 那会把「上游未回报」永久
         抹成 0，下游 byClient/byProvider 再也无法区分「未知」与「真的是 0」。
         保留 null，并带 knownCount 供桶级判断（与 byModel 同构）。 */
      credits: g.creditsRaw,
      knownCount: g.knownCount,
      boundName: g.boundName,
      keyName: g.keyName,
      keyHint: g.keyHint,
      keyExists: g.keyExistsId !== null ? 1 : 0,
    }));

    // 每个模型的最近请求时刻（byProvider.lastSeenAt 用）：组内 MAX(ts) 再按模型取最大。
    const lastSeenByModel = new Map<string, number>();
    for (const g of groups) {
      if (g.model === '') continue;
      const prev = lastSeenByModel.get(g.model);
      if (prev === undefined || g.lastTs > prev) lastSeenByModel.set(g.model, g.lastTs);
    }

    /* 模型id → 提供商显示名 —— **仅用于兜底**：迁移 018 之前落库的行没有
       `provider_id`，只能按目录反解。反解规则（生效分区遍历、同 id 先到先得 =
       创建序）与路由顺序**不一致**，所以它只能作为历史数据的降级手段，绝不该
       用于新行 —— 新行一律读 `requests.provider_id`（真实路由结果）。 */
    const providerName = new Map(this.providers.list().map((p) => [p.id, p.name]));
    const providerByModel = new Map<string, string>();
    for (const row of this.catalog.allAcross(this.providers.listActive().map((p) => p.id))) {
      if (!providerByModel.has(row.id)) providerByModel.set(row.id, providerName.get(row.provider_id) ?? row.provider_id);
    }
    /** 一组的归属提供商名：真实路由结果优先；老行才回落到目录反解。 */
    const resolveProviderName = (r: { providerId: string | null; model: string }): string | null => {
      if (r.providerId) return providerName.get(r.providerId) ?? r.providerId;
      return providerByModel.get(r.model) ?? null;
    };

    /* 桶内**按模型**再分一层：客户端摘要的悬停提示要回答「这个客户端的量花在哪些模型上」
       （v0.5.18 用户要求）。SQL 已是 (client_id, model) 粒度，这里只是把它们累加进桶，
       无需额外查询。同一个模型可能来自同一桶内的多把密钥 → 按模型 id 累加，不能覆盖。 */
    const clientBucket = new Map<
      string,
      {
        clientId: string;
        client: string;
        requests: number;
        tokens: number;
        /** null = 桶内**全部**请求都未回报（未知）；否则为已知部分之和。 */
        credits: number | null;
        /** 桶内回报过费用的请求条数（>0 才能判断 credits 不是 null）。 */
        knownCount: number;
        models: Map<string, { model: string; requests: number; tokens: number; credits: number | null; knownCount: number }>;
      }
    >();
    for (const row of clientModelRows) {
      const provider = resolveProviderName(row);
      // 桶键：provider 名（或回落的 client_id）。clientId 字段对前端只是 React key。
      const key = provider ?? row.clientId;
      let bucket = clientBucket.get(key);
      if (!bucket) {
        bucket = {
          clientId: key,
          client:
            provider ??
            resolveClientName({
              clientId: row.clientId,
              boundName: row.boundName,
              keyName: row.keyName,
              keyExists: row.keyExists > 0,
              keyHint: row.keyHint,
            }),
          requests: 0,
          tokens: 0,
          credits: null,
          knownCount: 0,
          models: new Map(),
        };
        clientBucket.set(key, bucket);
      }
      bucket.requests += row.requests;
      bucket.tokens += row.tokens;
      /* 未知口径：null 只表示「这一条没回报」，不参与求和；
         只要桶内出现过一条已知，credits 就是已知部分之和（未知当 0）。 */
      if (row.knownCount > 0) {
        bucket.credits = (bucket.credits ?? 0) + (row.credits ?? 0);
        bucket.knownCount += row.knownCount;
      }

      const m = bucket.models.get(row.model);
      if (m) {
        m.requests += row.requests;
        m.tokens += row.tokens;
        if (row.knownCount > 0) {
          m.credits = (m.credits ?? 0) + (row.credits ?? 0);
          m.knownCount += row.knownCount;
        }
      } else {
        bucket.models.set(row.model, {
          model: row.model,
          requests: row.requests,
          tokens: row.tokens,
          credits: row.knownCount > 0 ? row.credits ?? 0 : null,
          knownCount: row.knownCount,
        });
      }
    }
    const clientRows = [...clientBucket.values()]
      .sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0))
      .slice(0, 20);

    /* [v0.6.0] byProvider：按**目录归属的提供商**聚合用量 —— 提供商表那一行
       「请求次数 / 消耗积分 / 最后活跃」需要的是这个，而不是按客户端求和。
       与 byClient 同一个 (client_id, model) 粒度查询、同一套 providerByModel 归因：
       模型查不到 provider 的行归到 `null` 桶（前端显示为「未归属」），不冒充任何一家。
       [v1.10.2] 桶里同时收集 models 切片（byClient 同构）：概览提供商表悬停要显示
       该提供商的按模型消耗 —— 此前那版 tooltip 被删，根因就是 byProvider 没这个数据。 */
    const providerBucket = new Map<
      string | null,
      { providerId: string | null; provider: string | null; requests: number; tokens: number; credits: number | null; knownCount: number; lastSeenAt: number | null; models: Map<string, { model: string; requests: number; tokens: number; credits: number | null; knownCount: number }> }
    >();
    /* provider 显示名 → id 反查：**只给老行兜底**用（老行只有目录反解出的名字）。
       新行直接有 providerId，不需要这一趟往返。 */
    const idByName = new Map([...providerName.entries()].map(([id, name]) => [name, id]));
    for (const row of clientModelRows) {
      /* [v1.6.30] 优先真实路由结果；老行（无 provider_id）才按目录反解。 */
      const pName = resolveProviderName(row);
      const pId = row.providerId ?? (pName ? idByName.get(pName) ?? null : null);
      const key = pId;
      let bucket = providerBucket.get(key);
      if (!bucket) {
        bucket = { providerId: pId, provider: pName, requests: 0, tokens: 0, credits: null, knownCount: 0, lastSeenAt: null, models: new Map() };
        providerBucket.set(key, bucket);
      }
      bucket.requests += row.requests;
      bucket.tokens += row.tokens;
      /* 与 byClient 同构：null = 该桶全部未回报；否则为已知部分之和。 */
      if (row.knownCount > 0) {
        bucket.credits = (bucket.credits ?? 0) + (row.credits ?? 0);
        bucket.knownCount += row.knownCount;
      }
      /* [v1.10.2] models 切片（与 byClient 完全同构 —— 同一批行按 provider 键归并）。 */
      const pm = bucket.models.get(row.model);
      if (pm) {
        pm.requests += row.requests;
        pm.tokens += row.tokens;
        if (row.knownCount > 0) {
          pm.credits = (pm.credits ?? 0) + (row.credits ?? 0);
          pm.knownCount += row.knownCount;
        }
      } else {
        bucket.models.set(row.model, {
          model: row.model,
          requests: row.requests,
          tokens: row.tokens,
          credits: row.knownCount > 0 ? row.credits ?? 0 : null,
          knownCount: row.knownCount,
        });
      }
    }
    /* lastSeenAt：取「该提供商名下所有模型」的 MAX(ts)（lastSeenByModel 来自主聚合，无需再扫一遍）。 */
    for (const row of clientModelRows) {
      const pName = resolveProviderName(row);
      const pId = row.providerId ?? (pName ? idByName.get(pName) ?? null : null);
      const bucket = providerBucket.get(pId);
      if (!bucket) continue;
      const last = lastSeenByModel.get(row.model) ?? null;
      if (last !== null && (bucket.lastSeenAt === null || last > bucket.lastSeenAt)) bucket.lastSeenAt = last;
    }
    const providerRows = [...providerBucket.values()].map((b) => ({
      providerId: b.providerId,
      provider: b.provider,
      requests: b.requests,
      tokens: b.tokens,
      /* null = 该提供商名下全部请求都未回报（未知，前端显示 `--`）；
         与 byModel 的 `knownCount > 0 ? round2(...) : null` 同构。 */
      credits: b.credits === null ? null : round2(b.credits),
      /** epoch ms；该提供商名下所有模型最近一次请求时刻。null = 无数据。 */
      lastSeenAt: b.lastSeenAt,
      /* [v1.10.2] 按 tokens 前 5 的模型切片（悬停「按模型消耗」用；完整明细在模型摘要表）。
         displayName 在下方统一补（displayByModel 构造在此之后）。 */
      models: [...b.models.values()]
        .sort((x, y) => y.tokens - x.tokens)
        .slice(0, 5)
        .map((m) => ({
          model: m.model,
          displayName: null as string | null,
          requests: m.requests,
          tokens: m.tokens,
          credits: m.credits === null ? null : round2(m.credits),
        })),
    }));

    /* 模型 id → 显示名（与 byModel 同源：目录里的官方名，缺则回落 id）。
       悬停提示要显示的是**能认出来的模型名**，不是裸 id。 */
    const displayByModel = new Map(modelRows.map((m) => [m.model, m.displayName]));
    /* [v1.10.2] 补 byProvider.models 的 displayName（切片构造在 displayByModel 之前，这里回填）。 */
    for (const pr of providerRows) {
      for (const m of pr.models) m.displayName = displayByModel.get(m.model) ?? m.model;
    }

    const creditsUsed = round2(totals.credits);
    /* [v0.6.4] modelSum 保持「未知不计入」口径（NULL 当 0）—— 与 creditsUsed 同源，
       不变式 ΣbyModel(已知部分) === creditsUsed 继续成立；
       但**单行**的 credits 保留 null（前端 `--`），不被这股求和抹平。 */
    const modelSum = round2(modelRows.reduce((s, r) => s + (r.creditsRaw ?? 0), 0));
    /* 不变式对照：未知按 0 求和（`?? 0`），与 metrics.creditsUsed 同一口径。
       byClient 现在可能含 null 行（整桶未回报），求和时必须显式当 0 —— 否则
       `0 + null` 会变 NaN，断言就成了假红。 */
    const clientSum = round2(clientRows.reduce((s, r) => s + (r.credits ?? 0), 0));

    /* 「哪个工具发的」—— 按**原样 UA** 分组，再在 JS 里映射成工具名。
       为什么不在 SQL 里判：关键词表是**代码里的数据**（要能随时增补、要能被单测覆盖），
       塞进 SQL 的 CASE WHEN 就等于把表复制进字符串，两边一定会漂移。
       代价是把窗口内的 distinct UA 全捞回来 —— 自用场景下 UA 只有个位数到几十种，
       而按 UA 分组比按行分组小得多，可以接受。 */
    const uaRows = this.stmt(
        `SELECT COALESCE(ua, '') AS ua, COUNT(*) AS requests,
                COALESCE(SUM(credits), 0) AS credits,
                COALESCE(SUM(total_tokens), 0) AS tokens
           FROM requests WHERE ts >= ? AND ts < ?
          GROUP BY COALESCE(ua, '')`,
      )
      .all(from, to) as Array<{ ua: string; requests: number; credits: number; tokens: number }>;

    // 同一工具可能命中多个 UA（版本号不同），所以要按**工具名**再合一次。
    // key 用 `null` 之外的字符串；无法识别的另起一桶。
    const toolAgg = new Map<string | null, { requests: number; credits: number; tokens: number }>();
    for (const r of uaRows) {
      const tool = detectTool(r.ua)?.tool ?? null;
      const cur = toolAgg.get(tool) ?? { requests: 0, credits: 0, tokens: 0 };
      cur.requests += r.requests;
      cur.credits += r.credits;
      cur.tokens += r.tokens;
      toolAgg.set(tool, cur);
    }
    const byTool = [...toolAgg.entries()]
      .map(([tool, v]) => ({
        tool,
        requests: v.requests,
        tokens: v.tokens,
        credits: round2(v.credits),
        /* [v0.5.18] 与 byModel/byClient 同口径：占比按 tokens，排序也按 tokens。 */
        share: share(v.tokens, totals.totalTokens),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    /* 认不出来的 UA 原文（TOP 10）—— 给"该往关键词表里加什么"提供直接依据。
       空 UA 不列（它不是"某个未知工具"，而是"压根没采到"，
       列出来只会让人以为自己漏配了一个关键词）。 */
    const unknownUas = uaRows
      .filter((r) => r.ua.trim() !== '' && detectTool(r.ua) === null)
      .map((r) => ({ ua: r.ua, requests: r.requests }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);

    // ③ 一致性断言。三个数同源同区间，正常情况下恒等。
    //    不等只可能来自两类原因，**行数就能把两者分开**：
    //      · 分组数超过 TOP 20 被截断 → 恰好 20 行（LIMIT 命中）
    //      · 聚合被**重复计数**（JOIN 行放大、同键多行）→ 行数 < 20
    //    ⚠️ 此前这里只写「可能原因：分组数超过 TOP 20 被截断」—— 2026-10-11 的真因是
    //    目录 JOIN 行放大（多提供商同 id），运维照着那句提示查截断，**永远查不到**，
    //    于是告警在 24 小时里响了 27 次也没人认出问题。诊断文案必须指向真因。
    if (modelSum !== creditsUsed || clientSum !== creditsUsed) {
      this.logger.warn(
        `积分口径不一致：creditsUsed=${creditsUsed} ` +
          `byModel=${modelSum}（${modelRows.length} 行） byClient=${clientSum}（${clientRows.length} 行）` +
          `（窗口 ${spec.key}）。诊断：行数=20 才是 TOP 20 截断；行数<20 说明聚合被重复计数` +
          `（查 JOIN 是否行放大 / 分组键是否多行）。`,
      );
    }

    /* 趋势：**一次扫描**按 (桶, 模型) 分组 —— 柱的合计（请求/积分/tokens/错误）与 tooltip 的
       模型切片都从这份结果归并（此前是两条各扫一遍窗口的查询）。
       [v0.5.11] tooltip 每桶取 token 最多的前 TREND_TOP_MODELS 个模型（完整明细在「按模型消耗明细」表）。 */
    /* 趋势：**一次扫描**按 (桶, 模型, 提供商) 分组 —— 柱的合计（请求/积分/tokens/错误）、
       tooltip 的模型切片、[v8] 概览堆叠面积图的提供商切片，都从这份结果归并
       （此前是两条各扫一遍窗口的查询）。
       [v0.5.11] tooltip 每桶取 token 最多的前 TREND_TOP_MODELS 个模型（完整明细在「按模型消耗明细」表）。
       [v8] providers 切片：概览的 token 折线改按**提供商**堆叠（用户口径「按提供商维度来」）。
       分组键带上 provider_id（迁移 018 起有此列，真实路由结果），名字解析与
       byProvider 同源（providerName / providerByModel 兜底老行）；null = 目录外/未记录，
       与请求日志「提供商」列同口径显示「未归属」。 */
    const bucketExpr =
      spec.bucket === 'hour'
        ? `strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime')`
        : `strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime')`;
    const trendSlices = this.stmt(
        `SELECT ${bucketExpr} AS bucket, model, provider_id AS providerId,
                COUNT(*) AS requests,
                COALESCE(SUM(credits), 0) AS credits,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
           FROM requests WHERE ts >= ? AND ts < ?
          GROUP BY bucket, model, provider_id ORDER BY bucket`,
      )
      .all(from, to) as Array<{ bucket: string; model: string; providerId: string | null; requests: number; credits: number; tokens: number; errors: number }>;

    const bucketAgg = new Map<string, { bucket: string; requests: number; credits: number; tokens: number; errors: number; models: TrendModelSlice[]; providerTokens: Map<string, { name: string; tokens: number }> }>();
    for (const s of trendSlices) {
      let b = bucketAgg.get(s.bucket);
      if (!b) {
        b = { bucket: s.bucket, requests: 0, credits: 0, tokens: 0, errors: 0, models: [], providerTokens: new Map() };
        bucketAgg.set(s.bucket, b);
      }
      b.requests += s.requests;
      b.credits += s.credits;
      b.tokens += s.tokens;
      b.errors += s.errors;
      b.models.push({ model: s.model, tokens: s.tokens });
      const pName = s.providerId
        ? providerName.get(s.providerId) ?? s.providerId
        : providerByModel.get(s.model) ?? null;
      /* 键用 providerId（前端 providerColor 以 id 为键，与提供商表同色）；
         老行无 id 才退显示名。名字随值存，输出时不再反查。 */
      const pKey = s.providerId ?? (pName ? idByName.get(pName) ?? pName : '未归属');
      const prev = b.providerTokens.get(pKey);
      b.providerTokens.set(pKey, { name: pName ?? '未归属', tokens: (prev?.tokens ?? 0) + s.tokens });
    }
    const rawTrend = [...bucketAgg.values()].map((t) => ({
      ...t,
      credits: round2(t.credits),
      models: t.models.sort((a, b) => b.tokens - a.tokens).slice(0, TREND_TOP_MODELS),
      providers: [...t.providerTokens.entries()]
        .map(([pid, slice]) => ({ providerId: pid, provider: slice.name, tokens: slice.tokens }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, TREND_TOP_MODELS),
    }));

    /* [v0.6.6] **补满空桶**：SQL 的 `GROUP BY bucket` 只返回「有请求的桶」，
       于是 24h 窗口里没流量的那几小时直接缺柱 —— 用户看到的是「24 小时只有 17 根柱」，
       而且柱宽随数据量变化，同一个窗口两次刷新还可能不一样。
       图表语义要求**等距时间轴**（每根柱 = 一个固定时长），故按窗口算出**完整桶序列**、
       空桶补零，与 mock 的 `hourlyTrend(count, …)` 同口径。
       `today` 窗口同理：桶数 = 本地零点到当前小时（+1）。
       注意：只影响**图**；`metrics` / `byModel` 等仍由 SQL 聚合，不受此影响。 */
    /* [v1.6.31] 首/末桶常只覆盖窗口的一部分（窗口按 now 滚动，不对齐整点）——
       标出来，前端 tooltip 才不会把「半小时的桶」读成「一整个小时」。 */
    const trend = markPartialBuckets(
      fillEmptyBuckets(rawTrend, spec, from, to, (bucket) => ({
        bucket,
        requests: 0,
        credits: 0,
        tokens: 0,
        errors: 0,
        models: [] as TrendModelSlice[],
      })),
      spec,
      from,
      to,
    );

    // recent：同样是「凡展示名字处都走同一解析函数」—— 取 client_id + 当前名，不是快照。
    const recent = (
      this.stmt(
          `SELECT r.id, r.ts, r.client_id AS clientId, r.model, r.status, r.ms, r.credits, r.note,
                  ck.client AS boundName, ck.name AS keyName, r.key_hint AS keyHint, ck.id AS keyExistsId
             FROM requests r
             LEFT JOIN client_keys ck ON ck.id = r.client_id
            WHERE r.ts >= ? AND r.ts < ?
            ORDER BY r.ts DESC LIMIT 8`,
        )
        .all(from, to) as Array<{
        id: number;
        ts: number;
        clientId: string;
        model: string;
        status: number;
        ms: number;
        /** 可空：NULL = 上游未回报（未知），**不是 0**（v0.5.8）。 */
        credits: number | null;
        note: string;
        boundName: string | null;
        keyName: string | null;
        keyHint: string | null;
        keyExistsId: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      ts: toIso(r.ts),
      clientId: r.clientId,
      client: resolveClientName({
        clientId: r.clientId,
        boundName: r.boundName,
        keyName: r.keyName,
        keyExists: r.keyExistsId !== null,
        keyHint: r.keyHint,
      }),
      model: r.model,
      status: r.status,
      ms: r.ms,
      // ★ 用 round2OrNull：round2(null) 会算出 0，把「未知」变成「没花钱」。
      credits: round2OrNull(r.credits),
      note: r.note,
    }));

    const totalRequests = totals.requests ?? 0;
    const errors = totals.errors ?? 0;

    // 额度块来自 QuotaSourceService 的最近快照（task#53）。
    // 拿不到就是拿不到：块里 available=false + reason + message，**绝不估算**。
    const quotaBlock = this.quota.block(now);

    // 渠道校验（11128）告警计数：固定最近 1 小时（见常量注释），与 window 无关。
    // 按 upstream_code 而不是 note 计数：失败行的 note 是错误码（如 upstream_11128），
    // upstream_code 是结构化列，聚合更稳。
    /* [2026-10-17 评审裁决] 上游访问密钥失效告警：请求页脚注自己写着「这是唯一会让
       服务停摆的状态」，此前却只是筛选下拉里的一项 + 统计条一格当前页小数字。
       升格为概览横幅（与 11128 告警同机制）。按 note 计数（upstream_credential_invalid
       是 note 标记而非独立业务码列）；阈值 1 —— 单次即报，停摆级不等累积。
       窗口与 channelReject 一致：固定最近 1 小时，与 window 参数无关。 */
    const credentialInvalidCount = (
      this.stmt(
          `SELECT COUNT(*) AS n FROM requests
            WHERE ts >= ? AND ts < ? AND note LIKE '%' || ? || '%' AND status >= 400`,
        )
        .get(now - CHANNEL_REJECT_WINDOW_MS, now, 'upstream_credential_invalid') as { n: number }
    ).n;

    const channelRejectCount = (
      this.stmt(
          `SELECT COUNT(*) AS n FROM requests
            WHERE ts >= ? AND ts < ? AND upstream_code = ? AND status >= 400`,
        )
        .get(now - CHANNEL_REJECT_WINDOW_MS, now, 11128) as { n: number }
    ).n;

    /* [v1.7.2] 延迟分段（我方开销 / 上游等待 / 首字节 P95）。
       为什么单独查 requests 而不是用 aggregates：聚合表只有 `total_ms` 累计值，
       分位数无法从累计量还原。窗口内行数在自用工具量级（数千到数万），裸扫可接受；
       索引 idx_requests_ts 已经把范围收窄到窗口。 */
    const latency = this.latencyStats(from, now);

    return {
      window: spec.key,
      generatedAt: toIso(now),
      alerts: {
        channelReject: { count: channelRejectCount, threshold: CHANNEL_REJECT_ALERT_THRESHOLD },
        credentialInvalid: { count: credentialInvalidCount, threshold: 1 },
      },
      quota: quotaBlock,
      /* [v1.4.1] 积分账本 = MiniMax credit/details + WorkBuddy 资源包聚合（quota 快照的 ledger 行，
         与 MiniMax 块同形状并列展示；WorkBuddy 的 fetchedAt 用额度快照的成功时刻）。 */
      creditLedgers: [
        ...this.creditLedgers.allBlocks(),
        /* [v1.6.1] Qoder CN 账本（口径：余额取 v2/me/usage 套餐内+资源包；到期时刻上游不提供）。 */
        ...(this.qoderLedgers?.allBlocks() ?? []),
        ...this.quota.snapshot().ledger.map((r) => ({
          providerId: r.providerId,
          providerName: r.providerName,
          available: true,
          granted: r.granted,
          remaining: r.remaining,
          consumed: r.consumed,
          nextExpireAt: r.nextExpireAt !== null ? new Date(r.nextExpireAt).toISOString() : null,
          stale: false,
          fetchedAt: this.quota.snapshot().fetchedAt ? new Date(this.quota.snapshot().fetchedAt!).toISOString() : null,
          message: '',
        })),
      ],
      metrics: {
        requests: totalRequests,
        errors,
        requestsWithoutModel: totals.requestsWithoutModel ?? 0,
        creditsUsed,
        successRate: totalRequests ? Math.round(((totalRequests - errors) / totalRequests) * 1000) / 1000 : 0,
        avgLatencyMs: Math.round(totals.avgMs ?? 0),
        /* [v1.7.2] 延迟分段。P95 与均值都**只统计测到的行**；无样本 → null（不是 0）。
           现算一次（走 requests 表的裸查询，量级是窗口内的行数）—— 聚合表存的是累计
           总和与条数，分位数无法从累计量还原。 */
        firstByteP95: latency.firstByteP95,
        selfMsAvg: latency.selfMsAvg,
        upstreamWaitMsAvg: latency.upstreamWaitMsAvg,
        activeClients: totals.clients ?? 0,
        promptTokens: totals.promptTokens ?? 0,
        completionTokens: totals.completionTokens ?? 0,
        totalTokens: totals.totalTokens ?? 0,
        cachedTokens: totals.cachedTokens ?? 0,
        cacheHitRate: computeCacheHitRate(totals.cachedTokens ?? 0, totals.promptTokens ?? 0),
        creditsUnknownCount: totals.creditsUnknown ?? 0,
      },
      trend,
      byModel: modelRows.map((m) => ({
        model: m.model,
        displayName: m.displayName,
        multiplier: m.multiplier,
        tag: m.tag,
        requests: m.requests,
        tokens: m.tokens,
        /* [v0.6.4] 全部行都未回报积分 → null（前端 `--`，并在提供商卡片指引到账本）。
           有任一真实回报 → SUM（NULL 行按 0 计，与 metrics.creditsUsed 同口径）。 */
        credits: m.knownCount > 0 ? round2(m.creditsRaw ?? 0) : null,
        /* [v0.6.4] 该模型窗口内「上游未回报积分」的行数 —— 前端据此显示
           「N 条未回报」而不是让 null 看起来像 0。 */
        creditsUnknownCount: m.requests - m.knownCount,
        /* [v0.5.18] Token 占比：与「按 Token 排序」同源（见 payload 类型上的说明）。 */
        share: share(m.tokens, totals.totalTokens),
      })),
      byClient: clientRows.map((c) => {
        /* 悬停提示要「这个客户端的量花在哪些模型上」：按 tokens 降序取前 5
           （与趋势桶的模型切片同款做法）。`modelCount` 是**真实模型数**，
           供前端在截断时如实写「还有 N 个」—— 不截断却不说，等于让人以为这就是全部。 */
        const all = [...c.models.values()].sort((a, b) => b.tokens - a.tokens);
        return {
          clientId: c.clientId,
          /* [v0.5.15] 桶名已在归并时算好（provider 或密钥绑定回落），这里直接用。 */
          client: c.client,
          requests: c.requests,
          tokens: c.tokens,
          credits: c.credits === null ? null : round2(c.credits),
          share: share(c.tokens, totals.totalTokens),
          models: all.slice(0, CLIENT_MODEL_SLICE).map((m) => ({
            model: m.model,
            displayName: displayByModel.get(m.model) ?? null,
            requests: m.requests,
            tokens: m.tokens,
            credits: m.credits === null ? null : round2(m.credits),
            creditsUnknownCount: m.requests - m.knownCount,
          })),
          modelCount: all.length,
        };
      }),
      /* [v0.6.0] 提供商维度聚合（提供商表那行直接用；归因同 byClient）。 */
      byProvider: providerRows,
      recent,
      byTool,
      unknownUas,
      provenance: {
        creditsUsed: 'local',
        // 额度来源随实际状态标注：能取到就是 upstream，取不到如实写 none（不假装）。
        quotaRemain: quotaBlock.available ? 'upstream' : 'none',
        note: quotaBlock.available
          ? '已消耗积分仅统计经本服务转发的请求，取上游实扣 usage.credit；上游未回报的行积分未知，不计入合计（条数见 creditsUnknownCount）。官方客户端直连不计入。剩余积分来自上游额度接口（按 quota.pollSeconds 轮询，见 quota 块）。'
          : '已消耗积分仅统计经本服务转发的请求，取上游实扣 usage.credit；上游未回报的行积分未知，不计入合计（条数见 creditsUnknownCount）。官方客户端直连不计入，账户总消耗以官方客户端为准。剩余积分当前不可用（原因见 quota 块），不做估算。',
      },
    };
  }

  /**
   * [v1.7.2] 延迟分段统计（我方开销 / 上游等待 / 首字节 P95）。
   *
   * ## 为什么不用 aggregates 表
   * 聚合表只存 `total_ms` 的**累计和**与条数 —— 分位数无法从累计量还原。P95 必须
   * 看到分布，所以直接扫窗口内的 `requests` 行（`idx_requests_ts` 已把范围收窄）。
   *
   * ## 口径（与积分那条「未知 ≠ 0」同源）
   * - 各段**只统计有三段数据的行**：`auth_ms`/`prep_ms` 缺一就不计入我方开销
   *   （把缺失那半当 0 会系统性低估）；
   * - 样本为 0 → 返回 `null`（未知），**不是 0**；
   * - P95 用 `OFFSET floor(n*0.95)` 取秩 —— 数据量级（自用工具）下与插值法差异可忽略，
   *   而不插值的好处是**返回的一定是真实测量值**（不会算出 213.7ms 这种表里不存在的数）。
   */
  private latencyStats(from: number, to: number): {
    firstByteP95: number | null;
    selfMsAvg: number | null;
    upstreamWaitMsAvg: number | null;
  } {
    const agg = this.stmt(
      `SELECT
         COUNT(*) FILTER (WHERE first_byte_ms IS NOT NULL)                     AS fbN,
         COUNT(*) FILTER (WHERE auth_ms IS NOT NULL AND prep_ms IS NOT NULL)   AS selfN,
         AVG(CASE WHEN auth_ms IS NOT NULL AND prep_ms IS NOT NULL
                  THEN auth_ms + prep_ms END)                                 AS selfAvg,
         COUNT(*) FILTER (WHERE upstream_wait_ms IS NOT NULL)                  AS waitN,
         AVG(upstream_wait_ms)                                                 AS waitAvg
       FROM requests WHERE ts >= ? AND ts < ?`,
    ).get(from, to) as {
      fbN: number; selfN: number; selfAvg: number | null; waitN: number; waitAvg: number | null;
    };

    let firstByteP95: number | null = null;
    if (agg.fbN > 0) {
      /* 秩 = floor(n × 0.95)，夹在 [0, n-1]（n=1 时取第 0 个）。 */
      const offset = Math.min(agg.fbN - 1, Math.max(0, Math.floor(agg.fbN * 0.95)));
      const row = this.stmt(
        `SELECT first_byte_ms AS v FROM requests
          WHERE ts >= ? AND ts < ? AND first_byte_ms IS NOT NULL
          ORDER BY first_byte_ms ASC LIMIT 1 OFFSET ?`,
      ).get(from, to, offset) as { v: number } | undefined;
      firstByteP95 = row ? row.v : null;
    }

    return {
      firstByteP95,
      selfMsAvg: agg.selfN > 0 && agg.selfAvg !== null ? Math.round(agg.selfAvg) : null,
      upstreamWaitMsAvg: agg.waitN > 0 && agg.waitAvg !== null ? Math.round(agg.waitAvg) : null,
    };
  }
}
