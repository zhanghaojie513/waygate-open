/** 控制台只展示、不造数的公共常量与小工具。 */

import type { TimeWindow } from '../types/api';

export const WINDOW_LABEL: Record<TimeWindow, string> = {
  /* [2026-10-08] 'today' = 本地零点到现在（日历日，不是滚动 24h）——
     用户要"今天到目前为止"的口径，跨夜清零才符合直觉。 */
  today: '今日',
  '1h': '最近 1 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
};

export const WINDOW_OPTIONS = (Object.keys(WINDOW_LABEL) as TimeWindow[]).map((v) => ({
  value: v,
  label: WINDOW_LABEL[v],
}));

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
