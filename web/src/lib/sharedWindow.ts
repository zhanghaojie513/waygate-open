import type { TimeWindow } from '../types/api';

/**
 * 时间窗口的跨页共享（2026-10-17 评审 P2）。
 *
 * 评审背景：概览/用量/提供商管理各自持有独立的 `'today'` 状态，
 * 典型追查路径「概览看到异常 → 去用量看趋势」一跨页窗口即丢，要重选。
 *
 * 选 sessionStorage 而非 URL query：窗口是**会话内的工作上下文**，
 * 不是可分享的深链（分享给别人时对方该看自己的默认窗口）；
 * 也不是 localStorage —— 新会话该从「今日」开始，不该继承上周的 7d。
 *
 * 静默失败：隐私模式 sessionStorage 可能抛异常，读写都包 try/catch，
 * 拿不到就各自回落默认值，不因共享机制砸页面。
 */
const KEY = 'relay.window';

const VALID: TimeWindow[] = ['today', '1h', '24h', '7d', '30d'];

export function readSharedWindow(): TimeWindow | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    return VALID.includes(v as TimeWindow) ? (v as TimeWindow) : null;
  } catch {
    return null;
  }
}

export function writeSharedWindow(win: TimeWindow): void {
  try {
    window.sessionStorage.setItem(KEY, win);
  } catch {
    /* 隐私模式下静默丢弃——各页回落自己的默认值 */
  }
}
