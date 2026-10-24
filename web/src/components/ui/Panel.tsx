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
  items: Array<{ label: string; value: ReactNode; detail?: ReactNode; tone?: 'live' | 'amber'; tip?: ReactNode; tipPos?: 'down'; lead?: boolean }>;
}) {
  return (
    <div className="statbar" data-count={items.length}>
      {items.map((it) => (
        <div key={it.label} className={it.lead ? 'sb-lead' : undefined}>
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

/**
 * KpiTile —— 指标卡（v5 解剖）。
 *
 * 与 `MetricCard` 的分工：MetricCard 是「彩色图标芯片 + 标签 + 大数字」，
 * 强调"不同维度"（每卡一种色调）；KpiTile 是"同一组并列指标"，
 * 四张等宽、只有一个强调位（首卡），其余中性 —— 因为它们是同一件事的四个切面，
 * 给四种颜色会让读者以为它们属于不同系统。
 *
 * 结构（自上而下）：
 *   ① chiprow：图标芯片（30px）+ 环比胶囊（可选）
 *   ② 标签
 *   ③ 大数字（tabular-nums）
 *   ④ sub：一句补充（"较昨日同期 / 峰值 / 占比"），**不放进胶囊**
 *
 * 为什么胶囊只承载环比：上一版把「涨跌 / 峰值 / 占比 / 告警」四种语义
 * 塞进同一个样式的小胶囊里，读者必须先读文字才知道它在说什么。
 * 现在胶囊只有一个含义（与上一等长周期比较），其余信息一律下沉成 sub 灰字。
 */
export function KpiTile({
  label,
  value,
  icon,
  delta,
  sub,
  tip,
  tipPos,
  lead = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  /** 环比：`{ dir: 'up' | 'down', text: '12.4%' }`。没有可比量时**不传**，不要塞凑数的。 */
  delta?: { dir: 'up' | 'down'; text: string };
  /** 一句补充说明（峰值/占比/告警条数）。不要重复 value 里的信息。 */
  sub?: ReactNode;
  /** 悬停拆分（如"这个数按客户端怎么分"）。只绑数值节点。 */
  tip?: ReactNode;
  tipPos?: 'down';
  /** 首卡：带品牌色图标芯片与极淡光晕，标记"这是核心指标"（仍是等宽，不跨列）。 */
  lead?: boolean;
}) {
  return (
    <div className={`kpi${lead ? ' kpi-lead' : ''}`}>
      {/* [v5] 左右两栏：图标在左列、内容在右列。
          此前是四层纵排（图标行 / 标签 / 数字 / 说明），单卡高约 145px；
          两栏后同样内容压到约 96px —— 因为图标列与内容列并排，
          省掉了"图标独占一行"的那 41px。 */}
      <div className="kpi-side">
        {icon ? (
          <span className="kpi-ico" aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="kpi-body">
        <div className="kpi-head">
          <span className="kpi-lb">{label}</span>
          {delta ? (
            <span className={`kpi-delta kpi-${delta.dir}`}>
              {delta.dir === 'up' ? '↑' : '↓'} {delta.text}
            </span>
          ) : null}
        </div>
      {tip ? (
        <Tooltip content={tip} placement={tipPos === 'down' ? 'below' : 'auto'} className="tooltip-value-anchor">
          <span className="kpi-val">{value}</span>
        </Tooltip>
      ) : (
        <span className="kpi-val">{value}</span>
      )}
        {sub ? <span className="kpi-sub">{sub}</span> : null}
      </div>
    </div>
  );
}

/** 指标卡组：四列等宽。`data-count` 供 CSS 在 3/4 格时微调间距。 */
export function KpiRow({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="kpi-row-grid" data-count={count}>
      {children}
    </div>
  );
}
