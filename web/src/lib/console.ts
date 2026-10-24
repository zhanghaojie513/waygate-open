/** 控制台只展示、不造数的公共常量与小工具。 */

import type { TimeWindow } from '../types/api';

export const WINDOW_LABEL: Record<TimeWindow, string> = {
  /* [2026-10-08] 'today' = 本地零点到现在（日历日，不是滚动 24h）——
     用户要"今天到目前为止"的口径，跨夜清零才符合直觉。 */
  today: '今日',
  /* [v7] '1h' 已从选项中移除（用户裁决）：它和「今日」在同一屏里差一个量级，
     来回切会让四张卡的数看起来在乱跳，实际只是分母变了。
     类型上保留 '1h'（服务端仍支持、老链接仍可解析），只是不再出现在选择器里。 */
  '1h': '最近 1 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  /* [v7] 90d：概览活跃度热力图需要 13 周（91 天）数据。 */
  '90d': '最近 90 天',
  '1y': '最近一年',
};

/** 选择器里可选的窗口。'1h' 与 '90d' 刻意排除：
 *  '1h' 用户裁决删除；'90d'/'1y' 只作为概览热力图的固定数据窗口，
 *  不进入任何选择器。两者都保留在类型与服务端（老链接可解析）。 */
export const WINDOW_OPTIONS = (Object.keys(WINDOW_LABEL) as TimeWindow[])
  .filter((v) => v !== '1h' && v !== '90d' && v !== '1y')
  .map((v) => ({ value: v, label: WINDOW_LABEL[v] }));

/**
 * 密钥形态：`sk-waygate-4f9c…7a2e` —— 前缀 + 随机段首尾各 4 位。
 *
 * 不再写死 `slice(0, 13)`：那是「9 位前缀 + 4」算出来的常数，前缀更名成 11 位后
 * 会把随机段切进掩码里（`sk-waygate-4f` 看着像前缀变长，实际是随机段漏出）。
 * 改为按形态解析：随机段是尾部 24 位十六进制，前缀是它之前的部分。
 */
export function maskKeyPrefix(plaintext: string): string {
  const m = /^(.*?)([0-9a-f]{24})$/.exec(plaintext);
  if (!m) return plaintext.length <= 13 ? plaintext : `${plaintext.slice(0, 13)}…${plaintext.slice(-4)}`;
  return `${m[1]}${m[2].slice(0, 4)}…${m[2].slice(-4)}`;
}

/** 新建密钥的前缀（与服务端 `auth/keys.ts` 的 KEY_PREFIX 一致）。 */
export const KEY_PREFIX = 'sk-waygate-';

/** 三态判定：启用 / 已停用 / 已过期（过期优先于停用 —— 过期更具体，用户需要知道要重建） */
export type KeyState = 'live' | 'off' | 'exp';

export function keyState(enabled: boolean, expiresAt: string | null): KeyState {
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return 'exp';
  return enabled ? 'live' : 'off';
}

export const KEY_STATE_LABEL: Record<KeyState, string> = {
  live: '启用',
  off: '已停用',
  exp: '已过期',
};
