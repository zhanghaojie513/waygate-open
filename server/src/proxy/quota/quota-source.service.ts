/**
 * 额度来源服务（task#53）：按设置轮询上游额度端点，维护一份**最近成功值**快照。
 *
 * 设计要点（逐条对应任务口径）：
 *   - **逐请求实时读设置**：端点由 `upstream.baseUrl` 现读现拼；轮询间隔 / 退避上限 /
 *     失败策略都在每次调度时从 `config.get()` 现读 → 控制台一改**下个周期即生效**（不用重启）。
 *   - **只在成功时更新值**：失败只记错误与连续失败次数，**不清空**旧值（`keep_and_mark`）；
 *     除非 `quota.onFailure === 'clear'` 才按需清空。绝不把上次成功的数字抹成 null。
 *   - **区分两类失败**（task#57）：
 *       · **上游未提供**（该端点 404 / 路由不存在）→ **退避到每天一次**，状态标 `upstream_not_provided`，
 *         不按 `pollSeconds` 高频白打一个必然 404 的路径。
 *       · **网络 / 临时失败**（超时、5xx、连不上）→ 按 `backoffMaxSeconds` 指数退避，**值得重试**。
 *   - **失败可观测**：保留 `fetchedAt`（最近成功）与 `lastError/lastErrorAt`（最近错误），
 *     由 `buildQuotaBlock` 转成用户能读的 message。
 *   - **不编造**：解析只认真实出现的字段（见 `quota-parse.ts`），取不到即 null。
 *
 * 并发安全：单飞（`inFlight`）——同一时刻只允许一个拉取在途，避免慢上游叠加。
 */

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RelayConfigService } from '../../config/config.service';
import { buildQuotaUrl, stripTrailingSlash } from '../upstream-url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../store/db';
import { Optional } from '@nestjs/common';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import { hasAmount, parseQuotaPayload } from './quota-parse';
import { buildQuotaBlock, emptySnapshot, type QuotaBlock, type QuotaSnapshot, type WbLedgerRow } from './quota-block';

/** 单次额度请求超时（只读、轻量）。 */
export const QUOTA_TIMEOUT_MS = 10_000;

/**
 * 上游**未提供**该额度接口时的重试间隔（task#57）。
 *
 * [v1.3.0 更新] 该端点对真 key 的 **GET** 返回 404（旧结论「上游不供货」的根源），但
 * **POST + 分页 body 返回 200**（2026-10-13 生产探针实测，tools/probe-wb-activities.mjs）。
 * 已改为 POST。此常量保留：万一上游将来真下线该路由（POST 也 404），仍退避到每天一次，
 * 不按 `pollSeconds` 高频白打一个必然 404 的路径。
 */
export const NOT_PROVIDED_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * 额度请求的 User-Agent（[v1.3.0] 对齐官方桌面端三段式，探针实测该形状返回 200）。
 */
const QUOTA_UA = 'WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1';

/**
 * [v1.3.0] 构造 get-user-resource 的分页请求体（探针实测必需；GET 会 404）。
 * 时间窗 = 当下 → +365 天（上游按 PackageEndTime 过滤，窗口要覆盖未到期包）。
 */
export function buildQuotaRequestBody(nowMs: number = Date.now()): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  return JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(nowMs),
    PackageEndTimeRangeEnd: fmt(nowMs + 365 * 24 * 60 * 60 * 1000),
  });
}

/**
 * 计算下次拉取的延迟（ms）。
 *
 * 成功（failures=0）→ `pollSeconds`；失败 → 指数退避 `pollSeconds * 2^failures`，
 * 以 `backoffMaxSeconds` 为上限。纯函数，便于单测（不依赖计时器）。
 */
export function computeDelayMs(pollSeconds: number, backoffMaxSeconds: number, failures: number): number {
  const base = Math.max(1, pollSeconds) * 1000;
  if (failures <= 0) return base;
  const backedOff = base * 2 ** failures;
  const cap = Math.max(base, Math.max(1, backoffMaxSeconds) * 1000);
  return Math.min(backedOff, cap);
}

@Injectable()
export class QuotaSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuotaSourceService.name);
  private snap: QuotaSnapshot = emptySnapshot();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inFlight = false;

  constructor(
    // 显式 @Inject：esbuild/vitest 不产 design:paramtypes，类令牌注入必须写明（同 key.guard 的教训）。
    @Inject(RelayConfigService) private readonly config: RelayConfigService,
    /* [v0.5.0] 活提供商协议（anthropic 时不轮询额度）。@Optional 兼容旧测试构造。 */
    @Optional() @Inject(ProvidersRepository) private readonly providers?: ProvidersRepository,
  ) {}

  onModuleInit(): void {
    // 启动即拉一次（有 key 时）。无 key 时 fetchOnce 直接返回，不会发网络。
    void this.tick();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** 停止轮询（幂等）。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 当前快照（只读副本，避免外部误改内部状态）。 */
  snapshot(): QuotaSnapshot {
    return { ...this.snap };
  }

  /** 现读 `quota.warnBelow`，把快照映射成响应块。 */
  block(now = Date.now()): QuotaBlock {
    return buildQuotaBlock(this.snap, this.config.get().quota.warnBelow, now);
  }

  /** 下次调度延迟（现读设置）——测试「改 pollSeconds 生效」的观测点。 */
  nextDelayMs(): number {
    // 上游已明确未提供该接口 → 每天重探一次，不按 pollSeconds 高频白打（task#57）
    if (this.snap.routeMissing) return NOT_PROVIDED_RECHECK_MS;
    const q = this.config.get().quota;
    return computeDelayMs(q.pollSeconds, q.backoffMaxSeconds, this.snap.failures);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // 不因轮询计时器阻止进程退出（如冒烟启动脚本）
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.fetchOnce();
    } catch (err) {
      // fetchOnce 内部已兜底；这里只是最后一道，避免计时器回调抛出导致轮询停摆
      this.logger.error(`额度轮询异常：${(err as Error).message}`);
    }
    this.schedule(this.nextDelayMs());
  }

  /**
   * 拉取一次并更新快照。返回是否成功。
   * [v0.5.1] 多生效：对**每个**生效的 openai 提供商各拉一次，剩余额度**求和**
   * （都是 WorkBuddy 系积分口径）；anthropic 提供商不参与（无额度接口）。
   * [v0.6.1] qoder 同样不参与 —— Qoder 网关没有 WorkBuddy 口径的额度端点
   * （实测其 matrix 端点对非设备态请求返回 503）；积分以客户端/控制台账本为准。
   * @param fetchImpl 注入以便测试；默认全局 fetch。
   */
  async fetchOnce(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const actives = this.providers?.listActive() ?? [];
    /* providers 未装配（旧测试直构）或表空 → 回落全局单上游（旧路径）。 */
    const targets = actives.length > 0
      ? actives.filter((p) => p.protocol === 'openai')
      : [{ id: '__global', name: '全局', base_url: this.config.get().upstream.baseUrl }];
    if (actives.length > 0 && targets.length === 0) {
      /* 全部是非 openai 协议（anthropic / qoder）：都没有额度接口 —— 积分以客户端内显示为准。 */
      this.snap.hasKey = true;
      this.snap.routeMissing = true;
      this.recordFailure('当前提供商（无配额接口的协议）不提供额度接口 —— 积分以客户端内显示为准');
      return false;
    }
    const key = this.config.upstreamKey;
    if (!key) {
      this.snap.hasKey = false;
      return false;
    }
    this.snap.hasKey = true;

    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      /* 逐家拉取（通常 1-2 家，串行足够；失败一家不算整体失败，只汇总成功家的和）。 */
      let remain: number | null = 0;
      let total: number | null = 0;
      let okCount = 0;
      const ledgerRows: WbLedgerRow[] = [];
      let lastError: string | null = null;
      let resetAt: string | null = null;
      for (const provider of targets) {
        const pkey = this.providerCredential(provider);
        if (!pkey) {
          lastError = `提供商 ${provider.name} 未配置凭证`;
          continue;
        }
        const url = buildQuotaUrl(stripTrailingSlash(provider.base_url));
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${pkey}`,
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'user-agent': QUOTA_UA,
              'x-product': 'SaaS', // 探针实测同款头族（X-User-Id 不需要：带/不带均 200）
            },
            body: buildQuotaRequestBody(),
            signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
          });
          if (!res.ok) {
            // 404 = 上游就没有这个接口 → 标「上游未提供」；非 404 按临时故障记
            this.snap.routeMissing = res.status === 404;
            lastError = res.status === 404 ? '上游未提供该额度接口（HTTP 404 / 路由不存在）' : `提供商 ${provider.name} HTTP ${res.status}`;
            continue;
          }
          this.snap.routeMissing = false;
          const payload = (await res.json()) as unknown;
          const parsed = parseQuotaPayload(payload);
          if (!parsed) {
            lastError = `提供商 ${provider.name} 响应体不是可识别的额度结构`;
            continue;
          }
          if (!hasAmount(parsed)) {
            // 字段名对不上：记下上游真实键名，便于补别名（**不猜、不编**）
            lastError = `提供商 ${provider.name} 响应里没有可识别的剩余/总量字段（实测键名：${parsed.observedKeys.join(', ') || '空'}）`;
            continue;
          }
          /* 求和口径：任一家「未知（null）」则合计也为 null —— 未知优先于编造（单家时与旧语义一致）。 */
          remain = parsed.remain === null ? null : remain === null ? null : remain + parsed.remain;
          total = parsed.total === null ? null : total === null ? null : total + parsed.total;
          if (parsed.resetAt) resetAt = resetAt ?? parsed.resetAt;
          /* [v1.4.1] 账本行：聚合 + 包明细（失败家不进账本，保留旧值由 applySuccess 整体替换）。 */
          if (parsed.packages.length > 0) {
            ledgerRows.push({
              providerId: provider.id,
              providerName: provider.name,
              remaining: parsed.remain,
              granted: parsed.total,
              consumed: parsed.used,
              nextExpireAt: parsed.packages.reduce<number | null>((min, p) => (p.expireAt === null ? min : min === null ? p.expireAt : Math.min(min, p.expireAt)), null),
              packages: parsed.packages,
            });
          }
          okCount += 1;
        } catch (err) {
          const name = (err as Error)?.name;
          lastError = name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : ((err as Error).message || '网络错误');
        }
      }
      if (okCount === 0) {
        this.recordFailure(lastError ?? '没有可用的额度来源');
        return false;
      }
      this.applySuccess({ remain, total, resetAt }, ledgerRows);
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  /** openai 提供商的凭证（文件优先，回落全局位 —— 与 proxy/catalog-sync 同规则）。 */
  private providerCredential(provider: { id: string }): string {
    try {
      const key = readFileSync(join(resolveDataDir(), 'providers', `${provider.id}.key`), 'utf8').trim();
      if (key) return key;
    } catch {
      /* 回落全局位 */
    }
    return this.config.upstreamKey;
  }

  private applySuccess(parsed: { remain: number | null; total: number | null; resetAt: string | null }, ledger: WbLedgerRow[] = []): void {
    this.snap.hasData = true;
    this.snap.ledger = ledger;
    this.snap.remain = parsed.remain;
    this.snap.total = parsed.total;
    this.snap.resetAt = parsed.resetAt;
    this.snap.fetchedAt = Date.now();
    this.snap.lastError = null;
    this.snap.lastErrorAt = null;
    this.snap.failures = 0;
  }

  /** 记一次失败。默认保留旧值（keep_and_mark）；只有 `onFailure==='clear'` 才清空。 */
  private recordFailure(message: string): void {
    this.snap.lastError = message;
    this.snap.lastErrorAt = Date.now();
    this.snap.failures += 1;
    if (this.config.get().quota.onFailure === 'clear') {
      this.snap.hasData = false;
      this.snap.remain = null;
      this.snap.total = null;
      this.snap.resetAt = null;
    }
    this.logger.warn(`额度拉取失败（第 ${this.snap.failures} 次）：${message}`);
  }
}
