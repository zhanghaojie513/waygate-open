import { useMemo, useRef, useState, useEffect } from 'react';
import type { TrendPoint } from '../../types/api';
import { formatInt } from '../../lib/format';
import { useChartColors } from './chartTheme';
import { Tooltip } from '../ui/Tooltip';

/**
 * 活跃度热力图（贡献图样式）—— **手写 CSS grid** 实现。
 *
 * ## [v1.10.4] 为什么从 VChart 退回手写（决策记录）
 *
 * VChart 的 cell mark 底层是 **symbol mark**（`mark/cell.js` → `createSymbol`），
 * builtin `RectSymbol.draw()` 用 `ctx.rect()` 画路径 —— **没有圆角代码路径**。
 * 运行时矩阵实验（4 种写法逐一像素量测）证明：`cornerRadius: 5`、
 * `cornerRadius: [5,5,5,5]`、`size + cornerRadius`、`customPath` 全部无效，
 * 四角 9/9 满红（直角）。这不是配置问题，是库的硬限制。
 *
 * 用户要求四项：圆角 / 正方形 / 12 个月全标 / 铺满 —— VChart 只能满足后三项，
 * CSS 版四项全能（`border-radius` 原生、格宽按列均分自动铺满且格恒为正方形、
 * 标签由我们生成）。v1 的手写版因"统一图表体系"裁决换走；圆角需求让它回来，
 * 这次带着 VChart 版沉淀的全部口径（null≠0、动态分档、周对齐、12 日历月）。
 *
 * ## 数据形态
 *
 * 每格一个 span。**null 的格（未来日期 / 窗口外的头几天）渲染占位空 span**
 * （保持网格对齐）但无背景 —— 「无格」与「那天零请求」（有格、最浅档）是两种语义。
 *
 * ## X 轴标签规则（v1.10.4，修「跳着显示」）
 *
 * 53 列跨 13 个月边界（首尾同月）。此前的问题：首列对齐周一产生的**首月残段
 * 只有 1-2 列**，"10月"与"11月"挤在开头，视觉上像标签缺失。规则：
 *   · 每月**第一列**标月份（月均 4.4 列一个标签，不挤）
 *   · 首月残段不足 2 列不标（留给次月完整展示）
 *   · 同一 (年,月) 第二次出现标「今年 N 月」消歧（首尾都是 10 月时）
 */
interface Cell {
  week: number;
  dow: number;
  requests: number;
  date: string;
}

const DOW_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
/** 星期轴列宽（grid 第一列）。measure 的宽度预算与模板都从这里取 —— 单一事实。 */
const DOW_COL_W = 22;

export function ActivityHeat({ points }: { points: TrendPoint[] }) {
  const c = useChartColors();
  const hostRef = useRef<HTMLDivElement>(null);
  /* 格宽：容器实测（列均分），钳 9-20px —— 铺满与正方形的同一套约束。 */
  const [step, setStep] = useState(13);

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const byDate = new Map(points.map((p) => [p.bucket.slice(0, 10), p.requests]));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    const dowOffset = (firstDay.getDay() + 6) % 7;
    firstDay.setDate(firstDay.getDate() - dowOffset);

    const cells: Cell[] = [];
    let week = 0;
    for (let d = new Date(firstDay); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (byDate.has(key)) {
        cells.push({ week, dow: (d.getDay() + 6) % 7, requests: byDate.get(key) as number, date: key });
      }
      if ((d.getDay() + 6) % 7 === 6) week += 1;
    }
    const weeks = week + 1;

    /* 分档阈值（P25 / P60）：不同账号量级差几个数量级，固定阈值读不出节律。 */
    const vals = cells.filter((x) => x.requests > 0).map((x) => x.requests);
    const sorted = [...vals].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const levels = sorted.length ? { l1: Math.max(1, q(0.25)), l2: Math.max(2, q(0.6)) } : { l1: 1, l2: 2 };

    /* 月份标签（三条规则见组件头注释）。 */
    const colMonth: Array<{ m: number; y: number }> = [];
    for (let w = 0; w < weeks; w++) {
      const d = new Date(firstDay);
      d.setDate(d.getDate() + w * 7);
      colMonth.push({ m: d.getMonth(), y: d.getFullYear() });
    }
    const labels: string[] = new Array(weeks).fill('');
    const seen: Record<number, number> = {};
    let lastM = -1;
    for (let w = 0; w < weeks; w++) {
      const { m, y } = colMonth[w];
      if (m === lastM) continue;
      let span = 0;
      for (let k = w; k < weeks && colMonth[k].m === m; k += 1) span += 1;
      lastM = m;
      const key = y * 100 + m;
      seen[key] = (seen[key] ?? 0) + 1;
      if (w === 0 && span < 2) continue;
      labels[w] = seen[key] > 1 ? `今年${m + 1}月` : `${m + 1}月`;
    }

    return {
      weeks,
      cells,
      levels,
      labels,
      active: vals.length,
      total: vals.reduce((a, b) => a + b, 0),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }, [points]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !model || model.weeks <= 0) return;
    /* [v1.10.5] 观察父元素而非自身：自身是块级元素宽度跟随父容器，
       首帧布局未稳定时量到的宽可能是错的，而自身宽度之后不一定再变 ——
       ResizeObserver 只在观察对象尺寸变化时回调，错误的首测值会**永久停留**
       （生产报障：右侧方块被裁一半 = step 停在了首帧的过大值）。
       观察父级则父级收束时必然触发一次重测。另加字体就绪后重测一次。 */
    const target = el.parentElement ?? el;
    const measure = () => {
      /* [v1.10.6] 宽度预算要扣**轴列**：grid 第一列是星期标签（22px）加它右侧的
         columnGap —— 这两块在 grid 内部、占据面板宽度，但不是格子的可用宽。
         v1.10.5 扣的 26 是旧布局的 paddingLeft:26；并入单 grid 后语义变了没跟着改，
         格子被挤右 25px → 右缘超界（用户报障"右边还是超出去一点"）。 */
      const usable = el.clientWidth - DOW_COL_W - Math.max(1, Math.round(step * 0.14));
      if (usable <= 0) return; /* 布局未稳/隐藏时不测，避免把 0 当真 */
      const weeks = model.weeks;
      let st = Math.floor(usable / weeks);
      for (let k = 0; k < 2; k += 1) {
        const gap = Math.max(1, Math.round(st * 0.14));
        st = Math.floor((usable - (weeks - 1) * gap) / weeks);
      }
      setStep(Math.max(9, Math.min(20, st)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    /* 字体加载改变文本宽度 → 面板布局微调可能不触发 RO（宽度未变），
       字体就绪是布局稳定的一个可靠锚点，补测一次。 */
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => measure());
    }
    return () => ro.disconnect();
  }, [model?.weeks]);

  if (!model) return null;
  const { cells, levels, labels } = model;

  const opacityFor = (v: number): number => {
    if (v === 0) return 0.07;
    if (v <= levels.l1) return 0.28;
    if (v <= levels.l2) return 0.55;
    return 0.92;
  };

  const grid = new Map<string, Cell>();
  for (const cell of cells) grid.set(`${cell.week}:${cell.dow}`, cell);

  const gap = Math.max(1, Math.round(step * 0.14));
  const radius = Math.max(2, Math.round(step * 0.18));

  return (
    <div className="activity-heat" ref={hostRef}>
      {/* [v1.10.6] 轴与格子并入**同一个 grid**（星期列 = 第一列、月份行 = 末行）。
          v1.10.5 的两套坐标复刻（absolute 星期列 + 独立月份行）在 .activity-heat
          有 padding-top:2px 时错位 —— absolute 的 top:0 定位到 padding box，
          normal flow 从 content box 起，恒差一个 padding；且月份行单独用
          「同列宽 grid」复刻对齐，任何一处 gap/step 不同步就整体漂移。
          单 grid 由结构保证对齐：gap/step 只写一次。 */}
      <div
        role="img"
        aria-label={`最近 12 个月活跃度：活跃 ${model.active} 天，共 ${formatInt(model.total)} 次请求`}
        style={{
          display: 'grid',
          gridTemplateColumns: `${DOW_COL_W}px repeat(${model.weeks}, ${step}px)`,
          gridAutoRows: `${step}px`,
          columnGap: `${gap}px`,
          rowGap: `${gap}px`,
          justifyContent: 'start',
        }}
      >
        {/* 行头（星期）：每行一个格 —— 占第一列，行高由 gridAutoRows 决定，天然与格子行对齐 */}
        {Array.from({ length: 7 }, (_, d) => (
          <span
            key={`dow-${d}`}
            style={{ gridColumn: 1, gridRow: d + 1, fontSize: 10, lineHeight: `${step}px`, color: c.muted, textAlign: 'right', width: DOW_COL_W, alignSelf: 'center' }}
            aria-hidden
          >
            {DOW_LABELS[d]}
          </span>
        ))}
        {Array.from({ length: model.weeks * 7 }, (_, i) => {
          const w = Math.floor(i / 7);
          const d = i % 7;
          const cell = grid.get(`${w}:${d}`);
          const pos = { gridColumn: w + 2, gridRow: d + 1 };
          if (!cell) return <span key={i} style={{ ...pos, borderRadius: radius }} />;
          /* [v1.10.5] 接回全站 Portal Tooltip（CSS 重写版误用原生 title）。
             371 格各一个 Tooltip：只在 mouseenter 时渲染 Portal，常态是轻量实例。 */
          return (
            <Tooltip key={i} content={`${cell.date} · ${formatInt(cell.requests)} 次请求`}>
              <span
                style={{ ...pos, background: c.line, opacity: opacityFor(cell.requests), borderRadius: radius, display: 'block', width: '100%', height: '100%' }}
              />
            </Tooltip>
          );
        })}
        {/* 月份标签：末行（gridRow = 8），与对应周的列一一占位 —— 无字的周也占格，保证有字的周落在自己的列上 */}
        {/* [v1.10.7] 月份标签相对**格子中心**对齐：文字宽（3 字 ≈ 30px）常大于列宽
            （step 9-20px），左对齐时文字溢出列盒向右、视觉像标签偏了半格（用户报障
            截图正是这个形态）。中心对齐让文字**中心**落在该月第一列的起始格上 ——
            贡献图的通行做法（GitHub 热力图同款）。 */}
        {labels.map((l, w) =>
          l ? (
            <span
              key={`m-${w}`}
              style={{
                gridColumn: w + 2,
                gridRow: 8,
                fontSize: 10,
                lineHeight: '14px',
                color: c.muted,
                whiteSpace: 'nowrap',
                justifySelf: 'start',
                marginLeft: `${Math.floor(step / 2)}px`,
                transform: 'translateX(-50%)',
              }}
            >
              {l}
            </span>
          ) : null,
        )}
      </div>
      <p className="ah-foot">
        <span className="ah-stat">
          活跃 <b>{model.active}</b> 天 · 共 <b>{formatInt(model.total)}</b> 次请求 · 单日峰值 <b>{formatInt(model.max)}</b>
        </span>
        <span className="ah-legend">
          少
          {[0.07, 0.28, 0.55, 0.92].map((o) => (
            <i key={o} style={{ background: c.line, opacity: o, borderRadius: 2 }} />
          ))}
          多
        </span>
      </p>
    </div>
  );
}
