import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';

/** 面板卡：标题 + 右上角 pill + 内容。对应原型 .card.panel + .panel-head。 */
export function Panel({
  title,
  aside,
  children,
  className = '',
  padded = true,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={`card${padded ? ' panel' : ''} ${className}`.trim()}>
      {title ? (
        <div className="panel-head" style={padded ? undefined : { padding: '18px 20px 0', marginBottom: 12 }}>
          <h3>{title}</h3>
          {aside}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * 统计条：四格数字。对应原型 .statbar。
 *
 * [v7.0-c] `detail`（口径说明）从**第三行**提到**右上角**，与标签同一水平线左右分布，
 * 数值独占第二行。理由：三行结构让每张卡内部都留出一块空地，四张并排时
 * 「每张卡里都有一块没用上的地方」的观感比留白本身更明显；
 * 而口径是一句**注脚**，不是这一格的主信息 —— 放在右上角既不丢，
 * 又把纵向占位压回两行，六张并排时整列高度明显收紧。
 *
 * `tip` 仍只绑定到真实数值节点，由 Portal Tooltip 负责视口内定位和键盘说明。
 */
export function StatBar({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; detail?: ReactNode; tone?: 'live' | 'amber'; tip?: ReactNode; tipPos?: 'down' }>;
}) {
  return (
    <div className="statbar" data-count={items.length}>
      {items.map((it) => (
        <div key={it.label}>
          <div className="sb-top">
            <span className="lb">{it.label}</span>
            {/* 注脚只作可见文字，**不挂 native `title`** —— 那会在悬停时弹出浏览器
                自带的 tooltip 浮层，与「口径写在明面上」的设计意图冲突（用户：
                两页指标卡右上角的 tooltip 去除）。 */}
            {it.detail ? <span className="sdl">{it.detail}</span> : null}
          </div>
          {it.tip ? (
            <Tooltip content={it.tip} placement={it.tipPos === 'down' ? 'below' : 'auto'} className="tooltip-value-anchor">
              <div
                className="vl"
                style={it.tone === 'live' ? { color: 'var(--signal-live)' } : it.tone === 'amber' ? { color: 'var(--warn-amber)' } : undefined}
              >
                {it.value}
              </div>
            </Tooltip>
          ) : (
            <div
              className="vl"
              style={it.tone === 'live' ? { color: 'var(--signal-live)' } : it.tone === 'amber' ? { color: 'var(--warn-amber)' } : undefined}
            >
              {it.value}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 指标卡（KPI 瓦片解剖 v2）：彩色图标芯片 + 标签 / 大数字 / 副注。
 *  `tone` 决定芯片色调（每个指标一种颜色，参考 dashboard 惯例 —— 全同色读不出"这是不同维度"）。 */
export function MetricCard({
  label,
  value,
  detail,
  tone,
  icon,
  tip,
  tipPos,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'up' | 'warn' | 'cyan' | 'violet' | 'green' | 'amber' | 'blue' | 'rose';
  icon?: ReactNode;
  /** 悬停给「这个数按客户端怎么拆」，说明只绑定在数值节点上。 */
  tip?: ReactNode;
  tipPos?: 'down';
}) {
  const chipTone = tone === 'cyan' || tone === 'violet' || tone === 'green' || tone === 'amber' || tone === 'blue' || tone === 'rose' ? ` m-${tone}` : '';
  return (
    <div className="card metric">
      <div className="m-top">
        {icon ? (
          <span className={`m-ico${chipTone}`} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="lb">{label}</span>
      </div>
      {tip ? (
        <Tooltip content={tip} placement={tipPos === 'down' ? 'below' : 'auto'} className="tooltip-value-anchor">
          <div className="vl">{value}</div>
        </Tooltip>
      ) : (
        <div className="vl">{value}</div>
      )}
      {detail ? <div className={`dl${tone === 'up' ? ' up' : tone === 'warn' ? ' warn' : ''}`}>{detail}</div> : null}
    </div>
  );
}
// @zbiti-ai:f:63:be70fb88
