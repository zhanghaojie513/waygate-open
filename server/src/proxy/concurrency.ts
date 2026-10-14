import type { RelayConfigService } from '../config/config.service';

/**
 * 并发闸的**单一事实来源**。
 *
 * 上限同时被两处使用，必须同源、不得各算各的：
 *   - `ProxyService.acquireSlot()` —— 真正卡住并发（满了 429，不排队）；
 *   - `ConsoleController.getOverview()` —— 把「占用 / 上限」暴露给控制台（task#37）。
 *
 * 为什么必须暴露：`ctx.release()` 一旦被某条失败路径跳过（task#36 修的正是这种），
 * `active` 会单调上涨直到把闸打满 → **永久 429**，而这个失败状态从外面完全看不见。
 * 「看不见的问题修不了」——所以占用必须是可观测的。
 */

/** 硬上限：同时打向上游的请求数。满了直接 429，不排队（2C2G 排队会雪崩）。 */
export const MAX_ACTIVE = 32;

/** 当前生效的并发上限：配置值封顶在 `MAX_ACTIVE`。 */
export function resolveConcurrencyLimit(config: RelayConfigService): number {
  return Math.min(config.get().limits.concurrency || 4, MAX_ACTIVE);
}
