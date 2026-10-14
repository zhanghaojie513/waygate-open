import type { CSSProperties } from 'react';
import { formatGroup } from './data';

/**
 * 官网各区块共用的小工具。
 *
 * `numProps`：给「滚动到可视区才做数字滚动」的节点生成属性。
 *   驱动方是 page.ts 的 countUp（读 `data-count`）；
 *   文本先写成**终值** —— 所以 JS 没跑或降级动效时，页面显示的是正确数字，
 *   而不是一个 0 或空框。`value === null` 时渲染「—」，绝不编造（见 data.ts）。
 */
type NumProps = {
  children: string | number;
  'data-count'?: number;
  'data-dec'?: number;
  'data-demo'?: string;
};

export function numProps(value: number | null, dec = 0, demo?: string): NumProps {
  if (value == null) return { children: '—' };
  const p: NumProps = { 'data-count': value, children: formatGroup(value, dec) };
  if (dec) p['data-dec'] = dec;
  if (demo) p['data-demo'] = demo;
  return p;
}

/** 服务状态的胶囊：在线=春薄荷实心，离线=琥珀。用于接入卡 / 页脚。 */
export function livePill(online: boolean): { cls: string; text: string } {
  return online ? { cls: 'pill pill-live', text: '可用' } : { cls: 'pill pill-amber', text: '离线' };
}

/** 状态点颜色（供 hero-badge 的 .dot 用；内联 var()，无字面量） */
export const DOT_COLOR = {
  live: 'var(--signal-live)',
  offline: 'var(--warn-amber)',
} as const;

/** 当前页面是不是用 IP 直连访问的（而不是域名）。IPv6 的 hostname 带 `[]` 且含 `:`。 */
export function isIpHost(host: string = window.location.hostname): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * 证书来源 —— **必须按当前访问地址现算，不能写死**。
 *
 * 部署上是两条并存的 TLS 通道（同时挂在 8443，共用同一份 nginx location）：
 *   · 域名站 `relay.example.com` → **Let's Encrypt 公共 CA**（2026-10-06 签发）；
 *   · IP 直连站 `relay.example.com` → **自签 CA**（刻意保留：换域名期间 IP 通道不能断）。
 *
 * 页面正上方就在展示一个由 `location.origin` 现算出来的接入地址，所以证书这一行
 * 只能描述「这个地址」用的证书：写死任何一边，在另一条通道上都是假的。
 */
export function tlsLabel(host?: string): string {
  return isIpHost(host) ? '自签证书' : '公共 CA';
}

/**
 * 内联自定义属性（`--i` / `--c` / `--tint` …）不在 React 的 CSSProperties 里，
 * 用这个别名把「照抄的设计参数」写进 style —— 运行时是有效的自定义属性。
 */
export const cssVars = (o: Record<string, string | number>): CSSProperties =>
  o as CSSProperties & Record<string, string | number>;
// @zbiti-ai:f:62:7200bd8d
