/**
 * Qoder CN 签到与积分（v1.6.0）。
 *
 * ## 端点（自客户端 app.asar + growth H5 逆向，2026-10-14 生产实测）
 *
 * ⚠️ 关键：这批端点在 **openapi.qoder.com.cn**（**不是**聊天用的 gateway.qoder.com.cn），
 * 且**不需要 COSY 的 md5 签名** —— 认证只用 `Authorization: Bearer <accessToken>`
 * 加几个 `Cosy-*` 身份头（签名是 `/algo` 聊天接口才要的）。
 *
 *   GET  /sash/api/v1/me/campaigns                      → 活动列表（含每日签到）
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim   → 领取（**要 UUID，不是 campaignKey**）
 *   GET  /sash/api/v2/me/usage                          → **真实余额**（套餐内 + 资源包，见下）
 *   GET  /sash/api/v1/ai-conversations/credits-summary  → 累计消耗与单日峰值（**不是余额**）
 *   GET  /sash/api/v1/ai-conversations/seat-activity    → 连续活跃天数
 *   GET  /sash/api/v1/ai-conversations/credits-heatmap  → 每日消耗热力图
 *
 * ## 余额口径（v1.6.1 更正）
 * 此前判为「Qoder 无余额端点」是**错的** —— 那是只查了 v1 端点集合的漏判。
 * 客户端 asar 里 v1/v2 并存，**`v2/me/usage` 才是余额数据源**（`operation: account.getQuotaUsage`），
 * 即桌面端「我的用量」面板里那张「资源包 5/500 · 剩余 495」：
 *   `qoderUsage.userQuota`        套餐内 Credits（免费档 0/0/0）
 *   `qoderUsage.addOnQuota`       资源包（签到赠送的 Credits 进这里）
 *   `qoderUsage.orgResourcePackage` 组织资源包（企业版，个人档不出现）
 * 而 `credits-summary.totalCredits` 是**历史累计消耗**（对得上 heatmap 逐日和），
 * 与资源包 `used` 不是一回事，**不可混用**。
 *
 * ## 签到规则（上游文案，实测）
 * 「每天领 100 Credits」：每日 **10:00（UTC+8）** 刷新，领取后 **30 天**有效，
 * 有每日与累计上限。上游自带幂等（重复领取返回已领状态，带 `replayed` 标记）。
 *
 * ## 为什么由 relay 代签
 * Qoder 凭证是「同账号单会话」（客户端登录会顶掉 relay）。但签到**用的就是 relay
 * 已在维护的 access token** —— 于是不必登客户端，直接代签。
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { QoderCredentialStore } from './credential';

/** 活动/积分接口的宿主（与聊天网关不同）。 */
export const QODER_OPENAPI_BASE = 'https://openapi.qoder.com.cn';
/** Qoder 桌面端 clientType（COSY 身份头之一）。 */
const CLIENT_TYPE = '10';
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * 每日检查时刻：本地 **10:05**（Asia/Shanghai）。
 *
 * ⚠️ 与 MiniMax 的 08:05 **不同**，别照抄对齐 —— Qoder 官方标注活动
 * 「每日 10:00（UTC+8）刷新，领取后 30 天有效，+100 Credits」，
 * 在 08:05 检查时当天活动尚未刷新（签的是前一天、或直接报"没有可领取的活动"）。
 * 留 5 分钟缓冲避开刷新瞬时抖动。改动此处需同步前端提示文案
 * （ProviderTable 的签到 tooltip 按提供商显示各自时刻）。
 */
const DAILY_CHECK_HOUR = 10;
const DAILY_CHECK_MINUTE = 5;
/** 签到「今天」的时区边界（上游活动按 UTC+8 刷新）。 */
const SIGNIN_TZ = 'Asia/Shanghai';
/** [v1.6.7] 账本刷新间隔 —— 与 MiniMax 账本同节奏（5 分钟），且独立于签到时刻闸。 */
const LEDGER_INTERVAL_MS = 5 * 60 * 1000;

export interface QoderCampaign {
  campaignId: string;
  campaignKey: string;
  actionType: string;
  /** 'CLAIMABLE' = 可领 | 'CLAIMED' = 已领。 */
  claimStatus: string;
  benefitKind: string | null;
  benefitAmount: number | null;
  title: string | null;
}

/** 积分账本块（与 minimax-credit 的 CreditLedgerBlock 同形，供概览页并列展示）。 */
export interface QoderLedgerBlock {
  providerId: string;
  providerName: string;
  available: boolean;
  /** 累计发放 = 套餐内 total + 资源包 total（v1.6.1 起真实值；此前恒 null）。 */
  granted: number | null;
  /** 剩余 = 套餐内 + 资源包（签到赠送进资源包）。 */
  remaining: number | null;
  /** 已消耗 = 套餐内 + 资源包 used（**注意**：不是历史累计，后者见 lifetimeConsumed）。 */
  consumed: number | null;
  /** 上游不提供到期时刻 → 恒 null。 */
  nextExpireAt: string | null;
  /** [v1.6.1] 历史累计消耗（credits-summary.totalCredits）——与余额口径不同，单列以免混淆。 */
  lifetimeConsumed?: number | null;
  stale: boolean;
  fetchedAt: string | null;
  message: string;
}

/** 一组额度（套餐内 / 资源包 / 组织资源包 同形）。 */
export interface QoderQuota {
  total: number | null;
  used: number | null;
  remaining: number | null;
  unit: string | null;
}

/** `v2/me/usage` 的解析结果（真实余额口径）。 */
export interface QoderQuotaUsage {
  userType: string | null;
  /** 套餐内 Credits（免费档为 0/0/0）。 */
  plan: QoderQuota | null;
  /** 资源包（签到赠送进这里）—— 桌面端「我的用量」展示的那一项。 */
  addOn: QoderQuota | null;
  /** 组织资源包（企业版；个人档通常无）。 */
  orgResourcePackage: QoderQuota | null;
  isQuotaExceeded: boolean | null;
}

export interface QoderPanel {

  /** 服务端认为今天有可领。 */
  claimable: boolean;
  campaigns: QoderCampaign[];
  /** 最近一次签到的连签/活跃天数（best-effort，取不到为 null）。 */
  consecutiveDays: number | null;
}

export interface QoderCheckinResult {
  ok: boolean;
  outcome: 'claimed' | 'none' | 'error';
  points: number | null;
  streak: number | null;
  message: string;
}

/** Asia/Shanghai 的本地日期（YYYY-MM-DD）—— 幂等闸的键。 */
function localDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SIGNIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 从 placements 里挑活动标题（优先中文）。 */
function pickTitle(placements: unknown): string | null {
  if (!Array.isArray(placements)) return null;
  for (const p of placements) {
    if (!p || typeof p !== 'object') continue;
    const content = (p as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const c = content as Record<string, unknown>;
    const zh = c.zh && typeof c.zh === 'object' ? (c.zh as Record<string, unknown>) : null;
    if (typeof zh?.title === 'string' && zh.title) return zh.title;
    const en = c.en && typeof c.en === 'object' ? (c.en as Record<string, unknown>) : null;
    if (typeof en?.title === 'string' && en.title) return en.title;
  }
  return null;
}

/** 解析一组额度对象；上游缺字段就是 null（不补 0）。 */
function pickQuota(v: unknown): QoderQuota | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    total: num(o.total),
    used: num(o.used),
    remaining: num(o.remaining),
    unit: typeof o.unit === 'string' && o.unit ? o.unit : null,
  };
}

/** 解析 `v2/me/usage` 响应（`qoderUsage` 段）。 */
function pickQuotaUsage(body: Record<string, unknown>): QoderQuotaUsage {
  const u = body.qoderUsage && typeof body.qoderUsage === 'object' ? (body.qoderUsage as Record<string, unknown>) : {};
  return {
    userType: typeof u.userType === 'string' && u.userType ? u.userType : null,
    plan: pickQuota(u.userQuota),
    addOn: pickQuota(u.addOnQuota),
    orgResourcePackage: pickQuota(u.orgResourcePackage),
    isQuotaExceeded: typeof u.isQuotaExceeded === 'boolean' ? u.isQuotaExceeded : null,
  };
}

@Injectable()
export class QoderActivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QoderActivityService.name);
  private readonly store = new QoderCredentialStore();
  private timer: NodeJS.Timeout | null = null;
  /* [v1.6.7] 账本刷新定时器（独立于签到 timer）。 */
  private ledgerTimer: NodeJS.Timeout | null = null;
  private running = false;
  /**
   * [v1.6.0] 各提供商的账本快照（内存）。
   * ⚠️ 余额取 `v2/me/usage`（资源包 addOnQuota，v1.6.1 更正：**上游有余额端点**，
   * 此前判为"无余额"是漏查 v2 的错判）；「最近到期」该端点确实不给 → 如实 null。
   */
  private readonly ledgers = new Map<string, { snapshot: Omit<QoderLedgerBlock, "providerId" | "providerName"> }>();

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    /* 定时开关（测试里关掉）。 */
    @Optional() private readonly autoStart = true,
  ) {}

  onModuleInit(): void {
    if (this.autoStart === false) return;
    /* 签到检查：每 30 分钟醒来一次（到点才真打上游，幂等闸在 runDaily）。 */
    this.timer = setInterval(() => void this.runDaily(), 30 * 60 * 1000);
    this.timer.unref?.();
    void this.runDaily();
    /* [v1.6.7] 账本刷新**独立于签到**（与 MiniMax 账本同设计）：
       此前 refreshLedgers 挂在 runDaily 末尾，而 runDaily 在本地 08:05 前直接 return ——
       于是凌晨重启后账本 map 恒空、概览页 Qoder 行整行消失（实测：01:03 重启后无行）。
       账本与「签到时刻」无关，必须启动即拉、按自己的间隔刷新。 */
    this.ledgerTimer = setInterval(() => void this.refreshLedgers().catch(() => undefined), LEDGER_INTERVAL_MS);
    this.ledgerTimer.unref?.();
    void this.refreshLedgers().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ledgerTimer) {
      clearInterval(this.ledgerTimer);
      this.ledgerTimer = null;
    }
  }

  /** 到点则对每个生效的 qoder 提供商签到（幂等：同一天只签一次）。 */
  async runDaily(): Promise<void> {
    if (this.running) return;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: SIGNIN_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const [h, m] = local.split(':').map(Number);
    if ((h ?? 0) < DAILY_CHECK_HOUR || ((h ?? 0) === DAILY_CHECK_HOUR && (m ?? 0) < DAILY_CHECK_MINUTE)) return;

    const today = localDate();
    const targets = this.providers.listActive().filter((p) => p.protocol === 'qoder');
    if (targets.length === 0) return;

    this.running = true;
    try {
      for (const provider of targets) {
        if (provider.signin_checked_on === today) continue; // 今天已签，幂等跳过
        const r = await this.checkin(provider);
        if (r.outcome === 'claimed') {
          this.logger.log(`Qoder 每日签到成功：${provider.name} +${r.points ?? '?'} Credits（连签 ${r.streak ?? '?'} 天）`);
        } else if (r.outcome === 'error') {
          this.logger.warn(`Qoder 每日签到失败：${provider.name} —— ${r.message}`);
        }
      }
    } finally {
      this.running = false;
    }
    /* [v1.6.7] 账本刷新已移出本方法 —— 它有自己的定时器（见 onModuleInit）。
       此前挂在这里会在 08:05 前永不执行，凌晨重启后账本行整行消失。 */
  }

  /** 打一次 openapi（带 Cosy 身份头）。 */
  private async call<T = Record<string, unknown>>(provider: ProviderRow, path: string, init: { method?: 'GET' | 'POST' } = {}): Promise<T> {
    const { identity } = this.store.session(provider.id);
    const res = await fetch(`${QODER_OPENAPI_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${identity.token}`,
        accept: 'application/json',
        'user-agent': 'Qoder',
        'cosy-clienttype': CLIENT_TYPE,
        ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${path} 返回非 JSON（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      const o = (parsed ?? {}) as Record<string, unknown>;
      const detail = typeof o.errorMessage === 'string' ? o.errorMessage : '';
      throw new Error(`${path} HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    return parsed as T;
  }

  /** 查活动面板（不领取）。 */
  async panel(provider: ProviderRow): Promise<QoderPanel> {
    const body = await this.call<{ claimable?: unknown; campaigns?: unknown }>(provider, '/sash/api/v1/me/campaigns');
    const raw = Array.isArray(body.campaigns) ? body.campaigns : [];
    const campaigns: QoderCampaign[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      if (typeof c.campaignId !== 'string' || !c.campaignId) continue;
      const benefit = c.benefit && typeof c.benefit === 'object' ? (c.benefit as Record<string, unknown>) : null;
      campaigns.push({
        campaignId: c.campaignId,
        campaignKey: typeof c.campaignKey === 'string' ? c.campaignKey : '',
        actionType: typeof c.actionType === 'string' ? c.actionType : '',
        claimStatus: typeof c.claimStatus === 'string' ? c.claimStatus : '',
        benefitKind: typeof benefit?.kind === 'string' ? benefit.kind : null,
        benefitAmount: num(benefit?.amount),
        title: pickTitle(c.placements),
      });
    }
    /* 连续活跃天数（best-effort —— 查不到不影响签到）。 */
    let consecutiveDays: number | null = null;
    try {
      const seat = await this.call<Record<string, unknown>>(provider, '/sash/api/v1/ai-conversations/seat-activity');
      consecutiveDays = num(seat.currentConsecutiveDays);
    } catch {
      /* 静默：面板主体已拿到 */
    }
    return { claimable: body.claimable === true, campaigns, consecutiveDays };
  }

  /**
   * 签到：领取所有「可领」的活动（上游幂等，重复调用安全）。
   * `force` 为 false 时，今天已签过直接返回 'already'（不打上游）。
   */
  async checkin(provider: ProviderRow, force = false): Promise<QoderCheckinResult> {
    const today = localDate();
    if (!force && provider.signin_checked_on === today) {
      return { ok: true, outcome: 'none', points: provider.signin_last_points, streak: provider.signin_streak, message: '今天已经签过了。' };
    }

    let panel: QoderPanel;
    try {
      panel = await this.panel(provider);
    } catch (err) {
      return { ok: false, outcome: 'error', points: null, streak: null, message: (err as Error).message };
    }

    const claimable = panel.campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
    if (claimable.length === 0) {
      const already = panel.campaigns.some((c) => c.claimStatus === 'CLAIMED');
      /* 已签也落闸 —— 避免同一天反复打上游。 */
      if (already) this.providers.setSignin(provider.id, today, panel.consecutiveDays, provider.signin_last_points);
      return {
        ok: true,
        outcome: 'none',
        points: null,
        streak: panel.consecutiveDays,
        message: already ? '今天已签到（每日 10:00 UTC+8 刷新）' : '当前没有可领取的活动',
      };
    }

    let points = 0;
    let sawAmount = false;
    try {
      for (const c of claimable) {
        const body = await this.call<{ benefit?: unknown }>(
          provider,
          `/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`,
          { method: 'POST' },
        );
        const benefit = body.benefit && typeof body.benefit === 'object' ? (body.benefit as Record<string, unknown>) : null;
        const amount = num(benefit?.amount);
        if (amount !== null) {
          points += amount;
          sawAmount = true;
        }
      }
    } catch (err) {
      return { ok: false, outcome: 'error', points: null, streak: panel.consecutiveDays, message: (err as Error).message };
    }
    const finalPoints = sawAmount ? points : null;
    this.providers.setSignin(provider.id, today, panel.consecutiveDays, finalPoints);
    return {
      ok: true,
      outcome: 'claimed',
      points: finalPoints,
      streak: panel.consecutiveDays,
      message: finalPoints !== null ? `签到成功 +${finalPoints} Credits` : '领取完成（上游未回报金额）',
    };
  }

  /**
   * 积分概况，供控制台展示。
   *
   * 三个口径并存，**不要混用**：
   * - `total` / `peak`：**历史累计消耗**（`credits-summary`，实测 = heatmap 各日之和）——不是余额；
   * - `quota.addOn`：**资源包当前余额**（`v2/me/usage`，桌面端「我的用量」那张卡）；
   * - `seat.consecutiveDays`：连续活跃天数。
   */
  async credits(provider: ProviderRow): Promise<{
    total: number | null;
    peak: number | null;
    peakDate: string | null;
    consecutiveDays: number | null;
    maxConsecutiveDays: number | null;
    activeDays: number | null;
    /** [v1.6.1] 真实余额（资源包 + 套餐内）。取不到为 null。 */
    quota: QoderQuotaUsage | null;
  }> {
    const [s, seat, usage] = await Promise.all([
      this.call<Record<string, unknown>>(provider, '/sash/api/v1/ai-conversations/credits-summary'),
      this.call<Record<string, unknown>>(provider, '/sash/api/v1/ai-conversations/seat-activity').catch(() => ({}) as Record<string, unknown>),
      this.call<Record<string, unknown>>(provider, '/sash/api/v2/me/usage').catch(() => null),
    ]);
    return {
      total: num(s.totalCredits),
      peak: num(s.peakCredits),
      peakDate: typeof s.peakDate === 'string' ? s.peakDate : null,
      consecutiveDays: num(seat.currentConsecutiveDays),
      maxConsecutiveDays: num(seat.maxConsecutiveDays),
      activeDays: num(seat.cumulativeActiveDays),
      quota: usage ? pickQuotaUsage(usage) : null,
    };
  }

  /**
   * [v1.6.0] 拉取各 qoder 提供商的积分账本（概览页「积分账本」并列展示）。
   * 失败保留旧值并标 stale（与 MiniMax 账本同语义：拿不到就如实说，不抹零）。
   *
   * [v1.6.1] 改用 `v2/me/usage` 的**真实余额**：
   *   累计发放 = 套餐内 total + 资源包 total
   *   剩余     = 套餐内 remaining + 资源包 remaining
   *   已消耗   = 套餐内 used + 资源包 used
   * 免费档套餐内恒 0/0/0，故实际等于资源包——但求和写法在升级套餐后自然成立。
   * 「最近到期」该端点确实不提供 → 如实 null（不推算）。
   */
  async refreshLedgers(): Promise<void> {
    const targets = this.providers.listActive().filter((p) => p.protocol === "qoder");
    for (const provider of targets) {
      try {
        const c = await this.credits(provider);
        const q = c.quota;
        /* 求和：只累加"上游给了值"的项；全缺则为 null（不补 0）。 */
        const sumOf = (pick: (x: QoderQuota) => number | null): number | null => {
          const parts = [q?.plan, q?.addOn, q?.orgResourcePackage]
            .filter((x): x is QoderQuota => x !== null && x !== undefined)
            .map(pick)
            .filter((v): v is number => v !== null);
          return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
        };
        const granted = q ? sumOf((x) => x.total) : null;
        const remaining = q ? sumOf((x) => x.remaining) : null;
        const used = q ? sumOf((x) => x.used) : null;
        const addOn = q?.addOn ?? null;
        const planTouched = q?.plan !== null && q?.plan !== undefined
          && ((q.plan.total ?? 0) > 0 || (q.plan.remaining ?? 0) > 0 || (q.plan.used ?? 0) > 0);
        this.ledgers.set(provider.id, {
          snapshot: {
            available: true,
            /* 该端点不缺字段时，把「历史累计消耗」也带上供上层参考（不与余额混算）。 */
            granted,
            remaining,
            consumed: used,
            nextExpireAt: null, // 上游不给到期时刻（客户端「已过期」态由本地判断，无接口数据）
            stale: false,
            fetchedAt: new Date().toISOString(),
            lifetimeConsumed: c.total ?? null,
            message:
              remaining === null
                ? "上游未回报额度（v2/me/usage 无可解析字段）"
                : addOn && !planTouched
                  ? `口径：资源包余额（${addOn.remaining ?? "?"}/${addOn.total ?? "?"}）；到期时刻上游不提供`
                  : "口径：套餐内 + 资源包合计；到期时刻上游不提供",
          },
        });
      } catch (err) {
        const prev = this.ledgers.get(provider.id);
        const msg = (err as Error).message;
        this.ledgers.set(provider.id, {
          snapshot: prev
            ? { ...prev.snapshot, stale: true, message: "最近拉取失败（保留旧值）：" + msg }
            : { available: false, granted: null, remaining: null, consumed: null, nextExpireAt: null, stale: false, fetchedAt: null, lifetimeConsumed: null, message: "拉取失败：" + msg },
        });
        this.logger.warn("Qoder 账本拉取失败（" + provider.name + "）：" + msg);
      }
    }
  }

  /** 各 qoder 提供商的账本块（概览页消费）。 */
  allBlocks(): QoderLedgerBlock[] {
    const out: QoderLedgerBlock[] = [];
    for (const provider of this.providers.listActive().filter((p) => p.protocol === "qoder")) {
      const entry = this.ledgers.get(provider.id);
      if (!entry) continue;
      out.push({ providerId: provider.id, providerName: provider.name, ...entry.snapshot });
    }
    return out;
  }
}
