import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { RequestsRepository } from './repositories/requests.repo';
import { AggregatesRepository, dayBucket } from './repositories/aggregates.repo';

/**
 * 日志保留清理（task#37，A4）：按 `logs.retainDays` 每日删除过期数据。
 *
 * 契约 §6.5 要求：日志清理每日执行一次 `DELETE FROM requests WHERE ts < ?`，
 * **同时**清理对应的过期 `aggregates` bucket。此前 `logs.retainDays` 只是设置页上
 * 一个「界面能填、后端不做」的空壳项 —— 本服务把它接上。
 *
 * 设计要点：
 *   - **每日一次**：`setInterval(24h)`，并在应用启动后立即跑一次（补上停机期间过期的行）。
 *     首次清理放在 `onApplicationBootstrap`（而非 `onModuleInit`）：确保 `RelayConfigService`
 *     已从磁盘加载完设置，绝不用「默认 30 天」误删用户设成 3650 天的旧行。
 *   - **每次实时读配置**：`retainDays` 改了不用重启服务，下一次清理即生效。
 *   - **绝不抛**：清理失败（如正撞上外部备份 cron 持有的库锁 → SQLITE_BUSY）只记 warn，
 *     不影响服务运行，也不干扰备份。定时器 `unref`，不阻止进程退出。
 *   - **只删过期行**：`requests.clearBefore(cutoff)`；聚合删 `bucket < 截止日` 的**整日**桶
 *     （保守：绝不动与存活请求行对应的桶）。
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: RelayConfigService,
    private readonly requests: RequestsRepository,
    private readonly aggregates: AggregatesRepository,
  ) {}

  onApplicationBootstrap(): void {
    // 启动后清一次，随后每日一次（契约 §6.5）。
    // 启动那次延后到下一轮事件循环并分批执行：长时间停机后首次清理可能有大量过期行，
    // 不应拖住服务就绪，也不应一次性长时间持锁。
    setImmediate(() => void this.safeSweep());
    this.timer = setInterval(() => void this.safeSweep(), 24 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true; // 进行中的分批清理在下一批前退出，不在关库后继续访问数据库
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 包一层：清理失败绝不能影响服务（例如与外部备份 cron 抢库锁）。 */
  private async safeSweep(): Promise<void> {
    try {
      await this.sweepIncremental();
    } catch (err) {
      this.logger.warn(`日志保留清理失败（不影响服务运行）：${(err as Error).message}`);
    }
  }

  /**
   * 线上用的增量清理：请求行按 BATCH 分批删，批间 setImmediate 让出事件循环，
   * 期间到达的代理请求/SSE 写出不会被一次大 DELETE 卡住。删完后刷新查询规划统计。
   * 新插入的行 ts 恒 ≥ cutoff，分批期间并发写入不影响正确性。
   */
  async sweepIncremental(now: number = Date.now()): Promise<{ requests: number; aggregates: number; retainDays: number }> {
    const retainDays = this.config.get().logs.retainDays;
    const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
    let requests = 0;
    for (;;) {
      const n = this.requests.clearBeforeBatch(cutoff, RetentionService.BATCH);
      requests += n;
      if (n < RetentionService.BATCH) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.stopped) return { requests, aggregates: 0, retainDays };
    }
    const aggregates = this.aggregates.clearBefore(dayBucket(cutoff));
    if (requests > 0 || aggregates > 0) {
      this.logger.log(
        `日志保留清理（保留 ${retainDays} 天）：删除请求行 ${requests} 条、聚合桶 ${aggregates} 个`,
      );
      this.requests.optimize(); // 数据分布变了，按需刷新规划统计
    }
    return { requests, aggregates, retainDays };
  }

  /** 服务关闭标记：分批清理每批之间检查。 */
  private stopped = false;

  /** 单批删除行数：约 5000 行 × 6 个二级索引，单批同步耗时在几十毫秒内。 */
  private static readonly BATCH = 5000;

  /**
   * 执行一次清理。`retainDays` 实时读自配置。
   * 返回删除计数，便于单测断言「只删过期、不误删」。
   */
  sweep(now: number = Date.now()): { requests: number; aggregates: number; retainDays: number } {
    const retainDays = this.config.get().logs.retainDays;
    const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
    const requests = this.requests.clearBefore(cutoff);
    const aggregates = this.aggregates.clearBefore(dayBucket(cutoff));
    if (requests > 0 || aggregates > 0) {
      this.logger.log(
        `日志保留清理（保留 ${retainDays} 天）：删除请求行 ${requests} 条、聚合桶 ${aggregates} 个`,
      );
    }
    return { requests, aggregates, retainDays };
  }
}
