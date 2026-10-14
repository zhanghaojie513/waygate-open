import type { ReactNode } from 'react';
import { formatCredits, formatInt } from '../../lib/format';
import { Tooltip } from '../ui/Tooltip';

interface BarItem {
  key: string;
  label: string;
  value: number;
  trailing: string;
  mono?: boolean;
  /** 条上那个数字怎么读：整数（请求数）还是两位小数（积分） */
  format?: 'int' | 'credits';
  /** [v0.5.21] 悬停名字时弹出的内容（「按客户端消耗」用它展示该客户端的按模型消耗）。 */
  tip?: ReactNode;
}

/** 横向占比条：名字 + 值 + 进度轨。用于「按客户端消耗」。
 *  [v0.2.1] `js-stagger js-grow`：轨道入场横向生长（逐行错峰），见 app.css .dist。
 *  [v0.4.8] `windowLabel`：空态文案跟随所选时间窗 —— 原来写死「近 30 天」，
 *  切到今日/7d 时文案在说谎。
 *  [v0.5.21] `tip`：悬停**名字**看该客户端的按模型消耗，由 Portal Tooltip 负责定位。 */
export function BreakdownBars({ items, windowLabel }: { items: BarItem[]; windowLabel: string }) {
  if (items.length === 0) {
    return <div className="empty-note">{windowLabel}没有可拆分的请求。</div>;
  }
  const max = Math.max(1, ...items.map((it) => it.value));
  const nameStyle = (mono?: boolean) => (mono ? undefined : { fontFamily: 'var(--font-body)' });
  return (
    <div className="dist js-stagger js-grow">
      {items.map((it) => (
        <div className="d-row" key={it.key}>
          {it.tip ? (
            <Tooltip content={it.tip}>
              <span className="d-name" style={nameStyle(it.mono)}>{it.label}</span>
            </Tooltip>
          ) : (
            <span className="d-name" style={nameStyle(it.mono)}>{it.label}</span>
          )}
          <span className="d-val">
            {it.format === 'credits' ? formatCredits(it.value) : formatInt(it.value)} · {it.trailing}
          </span>
          <span className="d-track">
            <i style={{ width: `${Math.max(2, Math.round((it.value / max) * 100))}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}
// @zbiti-ai:f:37:13bd0ea9
