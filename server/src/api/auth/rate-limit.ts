/**
 * 登录失败限流（api-contract §1.4）：
 * "按来源 IP，10 分钟内失败 ≥ 10 次 → 锁定 10 分钟，返回 429 并带 retryAfterSeconds"。
 *
 * 纯内存实现（无状态进程重启即清零）——这个取舍是有意的：
 *   - 单机自用服务，重启是管理员主动行为，重启即解锁可以接受，甚至算逃生通道
 *   - 落库会引入"磁盘写失败 → 限流失效"的新失效模式，得不偿失
 *
 * 计数器是进程内的 Map，**必须自己清理过期条目**，否则长期运行会无限增长
 * （每个扫到的 IP 留一个 key）。清理挂在 `recordFailure` 里顺手做，不另起定时器。
 */

export interface RateLimitConfig {
  /** 观察窗口，毫秒 */
  windowMs: number;
  /** 窗口内允许的失败次数上限，达到即锁 */
  maxFailures: number;
  /** 锁定时长，毫秒 */
  lockMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 10 * 60 * 1000,
  maxFailures: 10,
  lockMs: 10 * 60 * 1000,
};

interface Bucket {
  failures: number[]; // 失败时刻（毫秒）
  lockedUntil: number; // 0 表示未锁定
}

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds: number;
  /**
   * 窗口内当前累计的失败次数（**仅在 `recordFailure` 的返回值里有意义**；
   * `status()` 是只读查询，不回填此字段）。用于审计日志，不参与判定逻辑。
   */
  failures?: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: RateLimitConfig = DEFAULT_RATE_LIMIT) {}

  /** 当前是否处于锁定状态。不修改状态。 */
  status(ip: string, now = Date.now()): LockStatus {
    const bucket = this.buckets.get(ip);
    if (!bucket) return { locked: false, retryAfterSeconds: 0 };
    if (bucket.lockedUntil > now) {
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
      };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  /**
   * 记一次失败。返回记完之后的状态 —— 若本次恰好触发锁定，
   * 调用方应当**直接回 429**（契约：达到阈值即锁，不给第 11 次尝试机会）。
   */
  recordFailure(ip: string, now = Date.now()): LockStatus {
    this.sweep(now);
    const bucket = this.buckets.get(ip) ?? { failures: [], lockedUntil: 0 };

    // 只保留窗口内的失败记录
    bucket.failures = bucket.failures.filter((t) => now - t < this.cfg.windowMs);
    bucket.failures.push(now);

    // 触发锁定时先记下本次计数，供日志使用（锁定后 failures 会被清空）
    const reached = bucket.failures.length;

    if (bucket.failures.length >= this.cfg.maxFailures) {
      bucket.lockedUntil = now + this.cfg.lockMs;
      bucket.failures = []; // 清空，锁定期满后重新开始计数
    }

    this.buckets.set(ip, bucket);
    return { ...this.status(ip, now), failures: reached };
  }

  /** 登录成功：清掉该 IP 的失败记录（避免"错 9 次再成功"长期挂着计数）。 */
  recordSuccess(ip: string): void {
    this.buckets.delete(ip);
  }

  /** 清理既未锁定、窗口内也没有失败记录的条目，防 Map 无限增长。 */
  private sweep(now: number): void {
    if (this.buckets.size < 512) return; // 自用小服务，小规模时不必每次扫
    for (const [ip, bucket] of this.buckets) {
      const expired = bucket.lockedUntil <= now && bucket.failures.every((t) => now - t >= this.cfg.windowMs);
      if (expired) this.buckets.delete(ip);
    }
  }

  /** 仅供测试断言使用。 */
  size(): number {
    return this.buckets.size;
  }
}
