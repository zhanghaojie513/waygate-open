/**
 * `QuotaBlock` 类型与「快照 → 响应块」的映射（task#53）—— **纯函数**。
 *
 * 独立成文件的原因：`overview.service.ts` 已接近 300 行门禁，且这段逻辑
 * （含 available / stale / low 的判定与文案）值得单独单测。
 *
 * 铁律：**拿不到的字段一律 null**。不推算、不拿 used/total 相减、不默认 0。
 */

/** `/api/overview` 的 `quota` 块（契约 §3.4）。 */
export interface QuotaBlock {
  available: boolean;
  reason: string | null;
  remain: number | null;
  total: number | null;
  resetAt: string | null;
  /** 上次成功值已过期（拉取失败时保留旧值并置 true）。 */
  stale: boolean;
  /** 剩余积分低于 `quota.warnBelow` 阈值（消费者见 `group-quota.ts` 的 why）。 */
  low: boolean;
  message: string;
}

/** 额度来源的内部快照（由 `QuotaSourceService` 维护）。 */
export interface QuotaSnapshot {
  /** 当前是否配置了上游访问密钥。 */
  hasKey: boolean;
  /** 是否**曾**成功取到过数据。 */
  hasData: boolean;
  /**
   * **上游是否明确未提供该额度数据**（实测该端点返回 404 / 路由不存在）。
   *
   * 与「网络/临时失败」区分：404 是「上游就没有这个接口」，重试无意义；
   * 网络失败是「这次没打通」，值得按退避重试。一旦置 true，轮询退避到每天一次。
   */
  routeMissing: boolean;
  remain: number | null;
  total: number | null;
  resetAt: string | null;
  /** 最近一次**成功**的时刻（epoch ms）；null = 从未成功。 */
  fetchedAt: number | null;
  /** 最近一次**错误**的人话描述；null = 无错误。 */
  lastError: string | null;
  /** 最近一次错误的时刻（epoch ms）。 */
  lastErrorAt: number | null;
  /** 连续失败次数（成功即清零）——退避与 stale 判定用。 */
  failures: number;
  /** [v1.4.1] 按提供商的 WorkBuddy 账本行（成功拉取时更新；失败保留旧值）。 */
  ledger: WbLedgerRow[];
}

/** [v1.4.1] WorkBuddy 账本行（快照内按提供商保留，供概览「积分账本」并列展示）。 */
export interface WbLedgerRow {
  providerId: string;
  providerName: string;
  /** 资源包聚合的剩余/总量/已用（Accounts 口径；多包求和）。 */
  remaining: number | null;
  granted: number | null;
  consumed: number | null;
  /** 有效包里最早的过期时刻（epoch ms；null = 全部永久/未知）。 */
  nextExpireAt: number | null;
  packages: Array<{ name: string; remain: number; size: number; used: number | null; expireAt: number | null }>;
}

export function emptySnapshot(): QuotaSnapshot {
  return {
    hasKey: false,
    hasData: false,
    routeMissing: false,
    remain: null,
    total: null,
    resetAt: null,
    fetchedAt: null,
    lastError: null,
    lastErrorAt: null,
    failures: 0,
    ledger: [],
  };
}

/** epoch ms → ISO（容错：非法值返回 null）。 */
function iso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * 把内部快照映射成响应块。
 *
 * 分支（互斥，顺序即优先级）：
 *   1. 未配置密钥      → available=false, reason=upstream_credential_missing
 *   2. 有数据 + 有错   → available=true,  stale=true,  reason=stale   （**保留旧值**）
 *   3. 有数据 + 无错   → available=true,  stale=false, reason=ok
 *   4. 无数据 + 上游404 → available=false, reason=upstream_not_provided（**端到端就没这接口**）
 *   5. 无数据 + 有错   → available=false, reason=fetch_failed（附最近错误）
 *   6. 无数据 + 无错   → available=false, reason=pending（首次拉取尚未完成）
 *
 * `low` 仅在 available 且有 remain 时才有意义；`warnBelow <= 0` 视为「不告警」。
 */
export function buildQuotaBlock(snap: QuotaSnapshot, warnBelow: number, now = Date.now()): QuotaBlock {
  const low = (remain: number | null): boolean =>
    remain !== null && warnBelow > 0 && remain < warnBelow;
  void now;

  if (!snap.hasKey) {
    return {
      available: false,
      reason: 'upstream_credential_missing',
      remain: null,
      total: null,
      resetAt: null,
      stale: false,
      low: false,
      message: '未配置上游访问密钥，无法获取剩余积分。请在「接入」页配置后重试。',
    };
  }

  if (snap.hasData) {
    const at = iso(snap.fetchedAt);
    if (snap.failures > 0) {
      return {
        available: true,
        reason: 'stale',
        remain: snap.remain,
        total: snap.total,
        resetAt: snap.resetAt,
        stale: true,
        low: low(snap.remain),
        message:
          `剩余积分为上次成功获取的值（${at ?? '未知时间'}）；最近一次获取失败：` +
          `${snap.lastError ?? '未知错误'}。数值可能已过期。`,
      };
    }
    return {
      available: true,
      reason: 'ok',
      remain: snap.remain,
      total: snap.total,
      resetAt: snap.resetAt,
      stale: false,
      low: low(snap.remain),
      message: `剩余积分来自上游额度接口（更新于 ${at ?? '未知时间'}）。`,
    };
  }

  if (snap.routeMissing) {
    return {
      available: false,
      reason: 'upstream_not_provided',
      remain: null,
      total: null,
      resetAt: null,
      stale: false,
      low: false,
      message:
        '上游订阅未提供额度查询接口（GET /v2/billing/meter/get-user-resource 实测 404，同级候选路径亦无路由）。' +
        '本服务无法取得剩余积分；「已消耗积分」仍按本地日志计算，不受影响。',
    };
  }

  if (snap.lastError) {
    return {
      available: false,
      reason: 'fetch_failed',
      remain: null,
      total: null,
      resetAt: null,
      stale: false,
      low: false,
      message: `未能从上游获取剩余积分：${snap.lastError}。`,
    };
  }

  return {
    available: false,
    reason: 'pending',
    remain: null,
    total: null,
    resetAt: null,
    stale: false,
    low: false,
    message: '正在从上游获取剩余积分…',
  };
}
