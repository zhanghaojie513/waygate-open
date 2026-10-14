/**
 * MiniMax 积分账本（v0.5.7）—— **真实口径**，不是估算。
 *
 * ## 为什么需要它
 * mavis 的聊天响应**不含单次费用**（只有 token 数），所以 relay 此前对 MiniMax 请求
 * 的积分是按 WorkBuddy 公式 × 中性倍率**估**出来的。而 MiniMax 其实有完整账本：
 *
 *   GET /minimax-cloud/api/v1/credit/details   （Bearer = access token，客户端同款）
 *   → { details: [{ credit_type, granted_amount, remaining_amount, consumed_amount,
 *                   granted_at_ms, expire_at_ms }], total_count }
 *
 * 每笔发放（签到赠送 / 购买）各自的额度与消耗，**精确到 0.01**。所以「还剩多少积分」
 * 「账户总共扣了多少」都能如实读到 —— 概览不该再拿估算冒充。
 *
 * ## 口径
 * · `remaining` / `consumed` / `granted` = 各笔**求和**（跨批次合并是正确语义：
 *   消耗会先从快过期的批次扣）。
 * · `nextExpireAt` = 最近一笔的过期时刻（积分 30 天有效，这是「不用就没了」的提醒）。
 * · 拿不到的字段一律 `null` —— 不推算、不用 granted−remaining 反推 consumed
 *   （rounding 会引入假精度），与 quota-block 同一纪律。
 *
 * ## 刷新
 * 每 5 分钟轮询一次（积分随请求变化，但账本是聚合口径，不需要每请求都拉）。
 * 拉取失败保留旧值并置 `stale`（与 QuotaSourceService 同策略）。
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { MinimaxTokenService } from './minimax-token.service';

const CREDIT_DETAILS_URL = 'https://agent.minimax.cn/minimax-cloud/api/v1/credit/details';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 超过这个时长没刷新成功就标 stale（两个轮询周期）。 */
const STALE_AFTER_MS = 12 * 60 * 1000;

/** 一笔积分发放。 */
export interface CreditGrant {
  creditType: number;
  granted: number;
  remaining: number;
  consumed: number;
  grantedAt: number;
  expireAt: number;
}

export interface CreditSnapshot {
  /** 是否曾成功取到过数据。 */
  hasData: boolean;
  granted: number | null;
  remaining: number | null;
  consumed: number | null;
  /** 最近一笔的过期时刻（epoch ms）—— 「不用就没了」的提醒。 */
  nextExpireAt: number | null;
  grants: CreditGrant[];
  fetchedAt: number | null;
  error: string | null;
}

/** 对外的账本块（概览 / 提供商列表消费）。 */
export interface CreditLedgerBlock {
  providerId: string;
  providerName: string;
  available: boolean;
  granted: number | null;
  remaining: number | null;
  consumed: number | null;
  nextExpireAt: string | null;
  /** 拉取失败但保留旧值。 */
  stale: boolean;
  /** 最近一次成功拉取时刻。 */
  fetchedAt: string | null;
  message: string;
}

const EMPTY: CreditSnapshot = {
  hasData: false,
  granted: null,
  remaining: null,
  consumed: null,
  nextExpireAt: null,
  grants: [],
  fetchedAt: null,
  error: null,
};

/** 字符串金额 → number；不可解析返回 null（不编造）。 */
function toAmount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

@Injectable()
export class MinimaxCreditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MinimaxCreditService.name);
  private readonly snapshots = new Map<string, CreditSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    @Inject(MinimaxTokenService) private readonly tokens: MinimaxTokenService,
    /* 定时开关：测试直构时传 false。@Optional 让 Nest 不去解析这个原始类型参数
       （否则 UnknownDependencies：boolean 没有 provider）。 */
    @Optional() private readonly autoStart?: boolean,
  ) {}

  onModuleInit(): void {
    if (this.autoStart === false) return;
    this.timer = setInterval(() => void this.refreshAll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshAll();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 对所有 oauth_minimax 提供商各拉一次账本。 */
  async refreshAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.providers.listActive().filter((p) => p.cred_kind === 'oauth_minimax');
      for (const provider of targets) {
        try {
          await this.refreshOne(provider);
        } catch (err) {
          this.markFailure(provider.id, (err as Error).message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 拉一家的账本（也可单独调用，例如刚签完到想让数字立刻更新）。 */
  async refreshOne(provider: ProviderRow): Promise<CreditSnapshot> {
    const token = await this.tokens.accessToken(provider);
    const res = await fetch(CREDIT_DETAILS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`账本接口 HTTP ${res.status}`);
    const body = (await res.json()) as {
      base_resp?: { status_code?: number; status_msg?: string };
      details?: unknown;
      total_count?: unknown;
    };
    const code = body.base_resp?.status_code;
    if (typeof code === 'number' && code !== 0) {
      throw new Error(body.base_resp?.status_msg ?? `上游业务码 ${code}`);
    }
    if (!Array.isArray(body.details)) throw new Error('账本响应缺少 details 数组。');

    const grants: CreditGrant[] = [];
    for (const raw of body.details) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      const granted = toAmount(d.granted_amount);
      const remaining = toAmount(d.remaining_amount);
      const consumed = toAmount(d.consumed_amount);
      /* 三个金额任一缺失就跳过这一笔 —— 宁可少算也不编。 */
      if (granted === null || remaining === null || consumed === null) continue;
      grants.push({
        creditType: typeof d.credit_type === 'number' ? d.credit_type : 0,
        granted,
        remaining,
        consumed,
        grantedAt: typeof d.granted_at_ms === 'number' ? d.granted_at_ms : 0,
        expireAt: typeof d.expire_at_ms === 'number' ? d.expire_at_ms : 0,
      });
    }

    const sum = (pick: (g: CreditGrant) => number): number =>
      Math.round(grants.reduce((s, g) => s + pick(g), 0) * 100) / 100;
    const expiring = grants.filter((g) => g.expireAt > Date.now()).map((g) => g.expireAt);
    const snap: CreditSnapshot = {
      hasData: true,
      granted: sum((g) => g.granted),
      remaining: sum((g) => g.remaining),
      consumed: sum((g) => g.consumed),
      nextExpireAt: expiring.length > 0 ? Math.min(...expiring) : null,
      grants,
      fetchedAt: Date.now(),
      error: null,
    };
    this.snapshots.set(provider.id, snap);
    return snap;
  }

  /** 拉取失败：保留旧值、记错误（拿不到就如实说，不抹零）。 */
  private markFailure(providerId: string, message: string): void {
    const prev = this.snapshots.get(providerId) ?? EMPTY;
    this.snapshots.set(providerId, { ...prev, error: message });
    this.logger.warn(`MiniMax 账本拉取失败（保留旧值）：${message}`);
  }

  /** 读快照（不触发网络）。 */
  snapshot(providerId: string): CreditSnapshot {
    return this.snapshots.get(providerId) ?? EMPTY;
  }

  /**
   * 对外块。`available` = 曾成功拉到过；`stale` = 最近一次成功已超过两个轮询周期
   * （或最近一次拉取失败）。
   */
  block(provider: ProviderRow): CreditLedgerBlock {
    const snap = this.snapshot(provider.id);
    const stale =
      snap.hasData &&
      (snap.error !== null || (snap.fetchedAt !== null && Date.now() - snap.fetchedAt > STALE_AFTER_MS));
    const message = !snap.hasData
      ? `账本暂不可用${snap.error ? `：${snap.error}` : '（尚未拉取）'}。`
      : snap.error
        ? `最近一次拉取失败（显示的是 ${new Date(snap.fetchedAt ?? 0).toLocaleString('zh-CN')} 的值）：${snap.error}`
        : `积分账本（${snap.grants.length} 笔发放，精确到 0.01）。`;
    return {
      providerId: provider.id,
      providerName: provider.name,
      available: snap.hasData,
      granted: snap.granted,
      remaining: snap.remaining,
      consumed: snap.consumed,
      nextExpireAt: snap.nextExpireAt === null ? null : new Date(snap.nextExpireAt).toISOString(),
      stale,
      fetchedAt: snap.fetchedAt === null ? null : new Date(snap.fetchedAt).toISOString(),
      message,
    };
  }

  /** 概览用：所有 oauth 提供商的账本块。 */
  allBlocks(): CreditLedgerBlock[] {
    return this.providers
      .listActive()
      .filter((p) => p.cred_kind === 'oauth_minimax')
      .map((p) => this.block(p));
  }
}
