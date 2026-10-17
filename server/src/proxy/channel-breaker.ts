/**
 * 11128 渠道熔断（v1.6.27，2026-10-17 事故复盘产物）。
 *
 * ## 为什么需要
 * WorkBuddy 上游的渠道校验拒绝（11128）呈**阵发**（10-06 59 次/12h、10-17 8 次/11min），
 * 阵发期每个失败要烧 ~65s（模板尝试 + 降级重试各 ~32s 慢拒绝）。并发槽是**全局单计数**，
 * 不按提供商分 —— 客户端重试会把 4 个槽全部占满 ~1 分钟，MiniMax/Qoder 的正常流量
 * 一起被饿死。熔断后改为立即失败（毫秒级、不占槽），阵发过去自动恢复。
 *
 * ## 只计「渠道级」信号（防误伤的关键）
 * 11128 有两种成因：
 *   · 内容级：system 模板指纹被拦（L1 改写漏了新变体）—— **降级重试（中性提示）能过**；
 *   · 渠道级：上游阵发全拒 —— **降级重试也是 11128**。
 * 只有第二种计入熔断（调用方以「请求带 sysprompt_degraded_retry note 且最终仍 11128」
 * 判定）。内容级失败计数会把某一个客户端的请求特征变成全提供商的闸门，误伤他人。
 *
 * ## 状态机（每提供商独立，内存态，重启即重学）
 *   CLOSED --连续 N 次(默认3)渠道级拒绝--> OPEN（冷却 30s，指数退避 ×2，封顶 300s）
 *   OPEN --冷却到期--> 放行下一请求作探测（半开，不单独建态：到期后请求自然放行）
 *   探测成功 --> 全复位；探测仍 11128 --> 再开闸，退避升一档
 * 任何成功（含降级重试成功）或非 11128 的业务失败（如 11115，说明校验链路活着）都复位。
 *
 * 纯逻辑、无 IO，时钟可注入 —— 单测不睡真时间（channel-breaker.spec.ts）。
 */

/** 连续渠道级拒绝多少次后开闸。 */
export const BREAKER_THRESHOLD = 3;
/** 首次开闸冷却；此后每次再开 ×2。 */
export const BREAKER_BASE_COOLDOWN_MS = 30_000;
/** 冷却封顶（与 quota.backoffMaxSeconds 同量级：长阵发期探测成本收敛到每 5 分钟一次）。 */
export const BREAKER_MAX_COOLDOWN_MS = 300_000;

interface BreakerState {
  /** 连续渠道级拒绝次数（成功即清零）。 */
  consec: number;
  /** 本次阵发已开闸次数（退避档位）。 */
  opens: number;
  /** 开闸截止时刻（epoch ms）；已过点即「半开」，放行探测。 */
  openUntil: number;
}

export interface BreakerTransition {
  /** 本次拒绝是否触发了开闸（服务层据此打 warn 日志）。 */
  opened: boolean;
  opens: number;
  cooldownMs: number;
}

export class ChannelBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 该提供商当前是否被熔断。
   * @returns 仍处开闸期 → 剩余毫秒数；否则 null（含「冷却已过、可放行探测」）。
   */
  blocked(providerId: string): number | null {
    const s = this.states.get(providerId);
    if (!s) return null;
    const remain = s.openUntil - this.now();
    return remain > 0 ? remain : null;
  }

  /** 记一次渠道级拒绝（仅「降级重试也 11128」的最终失败才该调这里）。 */
  recordChannelRejection(providerId: string): BreakerTransition {
    const s = this.states.get(providerId) ?? { consec: 0, opens: 0, openUntil: 0 };
    s.consec += 1;
    let opened = false;
    let cooldownMs = 0;
    if (s.consec >= BREAKER_THRESHOLD) {
      s.opens += 1;
      opened = true;
      cooldownMs = Math.min(BREAKER_BASE_COOLDOWN_MS * 2 ** (s.opens - 1), BREAKER_MAX_COOLDOWN_MS);
      s.openUntil = this.now() + cooldownMs;
    }
    this.states.set(providerId, s);
    return { opened, opens: s.opens, cooldownMs };
  }

  /** 记一次「渠道健康」信号：成功返回，或非 11128 的业务失败（校验链路已工作到深层）。全复位。 */
  recordHealthy(providerId: string): void {
    this.states.delete(providerId);
  }

  /** 测试/排障观察用。 */
  snapshot(providerId: string): { consec: number; opens: number; openUntil: number } | null {
    const s = this.states.get(providerId);
    return s ? { ...s } : null;
  }
}
