import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { TrendPoint } from '../../types/api';
import { formatInt } from '../../lib/format';
import { useChartColors } from './chartTheme';

/**
 * 活跃度热力图（13 周 × 7 天，贡献图样式）—— VChart（VisActor）实现。
 *
 * ## 为什么从手写 CSS 换成 VChart
 *
 * 第一版是 91 个 span 的 CSS grid。用户裁决：**用 Arco 体系的热力图**
 * （Arco 的图表层是 VChart / VisActor，与 TokenTrend 同源）。
 * 统一进图表体系后，主题、tooltip、无障碍由同一层负责。
 *
 * ## 字段（查过类型定义：heatmap 是 `valueField`，不是 colorField）
 *
 * `IHeatmapSeriesSpec` 的值编码字段是 `valueField`（series/heatmap/interface.d.ts）。
 * 颜色**不走 scale 配置**（那条链路版本间变化多）—— 而是给 cell mark 显式
 * `fill`（品牌色）+ `fillOpacity` 按量级分档：同色透明度阶梯，
 * 视觉上等价 color-mix，但 Canvas 里直接可用。
 *
 * ## 数据形态
 *
 * 每格一行：`{ week, dow, requests, date, text }`。
 * **null 的格（未来日期 / 对齐周多出的窗口外头几天）直接不进 values**
 * —— heatmap 只为出现的组合画格，缺的组合自然是空白（=「无格」，
 * 与「那天零请求」（有格、最浅档）是两种语义）。
 */
const VChart = lazy(async () => {
  const mod = await import('@visactor/react-vchart');
  return { default: mod.VChart };
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Cell {
  /** 第几周（0..12），x 轴 band */
  week: number;
  /** 周几（0=周一..6=周日），y 轴 band */
  dow: number;
  requests: number;
  date: string;
  /** tooltip 用的预格式化文案（VChart 的 value 回调拿干净字符串最稳） */
  text: string;
}

export function ActivityHeat({ points }: { points: TrendPoint[] }) {
  const c = useChartColors();

  /* [v1.10.2] 正方形 + 铺满的两半：x 轴不钉死（列均分面板宽），y 轴行高取
     「容器宽 ÷ 列数」—— 两个轴同一个步长，格子恒为正方形且铺满面板。
     测量用 ResizeObserver（容器随窗口变），首帧未测到时回落 13px。 */
  const hostRef = useRef<HTMLDivElement>(null);
  const [bandStep, setBandStep] = useState<number | null>(null);

  const model = useMemo(() => {
    if (points.length === 0) return null;

    /* 服务端日桶是本地时区 YYYY-MM-DD */
    const byDate = new Map(points.map((p) => [p.bucket.slice(0, 10), p.requests]));

    /* [v9] 动态 12 个日历月：起点 = 11 个月前那个月的 1 号（不是固定 364 天）。
       跨度随今天的日期浮动（~334–365 天），列数随对齐后的周数走 ——
       用户口径「动态的 12 个月就行，不用固定死」。
       起点再对齐回周一，多出的头几天落在 API 窗口（364 天）之外 → 无格。 */
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    const dowOffset = (firstDay.getDay() + 6) % 7; // 周一=0
    firstDay.setDate(firstDay.getDate() - dowOffset);
    /* 迭代到今天为止；最后一列补满 7 天（未来天跳过，不渲染格）。
       列数由总天数动态决定，不写死。 */
    const cells: Cell[] = [];
    let week = 0;
    for (let d = new Date(firstDay); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const has = byDate.has(key);
      if (has) {
        cells.push({
          week,
          dow: (d.getDay() + 6) % 7,
          requests: byDate.get(key) as number,
          date: key,
          text: `${formatInt(byDate.get(key) as number)} 次`,
        });
      }
      if ((d.getDay() + 6) % 7 === 6) week += 1; // 周日走完 → 下一列
    }
    const weeks = week + 1;

    /* 分档阈值动态取（P25 / P60 / max）：不同账号请求量差几个量级，
       固定阈值会让小量级账号全是浅格、大量级全是深格，读不出节律。 */
    const vals = cells.filter((x) => x.requests > 0).map((x) => x.requests);
    const sorted = [...vals].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const levels = sorted.length
      ? { l1: Math.max(1, q(0.25)), l2: Math.max(2, q(0.6)) }
      : { l1: 1, l2: 2 };

    /* x 轴月份标签：每列取首日，月份变化的那列才标（其余空串）。 */
    const weekLabels: string[] = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const d = new Date(firstDay);
      d.setDate(d.getDate() + w * 7);
      const m = d.getMonth();
      weekLabels.push(m !== lastMonth ? `${m + 1}月` : '');
      lastMonth = m;
    }

    return {
      weeks,
      cells,
      levels,
      weekLabels,
      active: vals.length,
      total: vals.reduce((a, b) => a + b, 0),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }, [points]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !model || model.weeks <= 0) return;
    const measure = () => {
      /* 可用绘图宽 ≈ 容器宽 − 左侧星期标签区（26，与 spec.padding.left 一致）− 右 padding（4）。 */
      const usable = el.clientWidth - 26 - 4;
      const step = Math.floor(usable / model.weeks);
      /* 钳在 9–20px：太窄读不出色阶，太宽超过贡献图的密度惯例。 */
      setBandStep(Math.max(9, Math.min(20, step)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    /* deps 只认 weeks：el / 图表高度变化走 ResizeObserver，不进 deps。
       （上游原注释引用了未配置的 react-hooks/exhaustive-deps 规则导致 lint 红，改写为普通说明。） */
  }, [model?.weeks]);

  if (!model) return null;
  const { cells, levels, weekLabels } = model;

  /* 同色透明度阶梯：0 档贴底（0.07 叠在面板底上 ≈ 空底），
     高档 0.92 接近实色品牌。阈值来自上面的动态分位。 */
  const opacityFor = (v: number): number => {
    if (v === 0) return 0.07;
    if (v <= levels.l1) return 0.28;
    if (v <= levels.l2) return 0.55;
    return 0.92;
  };

  const spec = {
    type: 'heatmap' as const,
    data: [{ id: 'activity', values: cells }],
    xField: 'week',
    yField: 'dow',
    /* heatmap 的值编码字段（类型定义是 valueField，不是 colorField） */
    valueField: 'requests',
    axes: [
      {
        orient: 'bottom' as const,
        /* [v1.10.2] 正方形格 + 铺满面板：x 轴**不钉死** band（让 52 列均分可用宽度），
           y 轴的 bandSize 由外层按「面板宽 ÷ 列数」算出同一值传入 —— 两个轴用同一个
           步长，格子恒为正方形，且时间轴铺满面板（不再右侧留白）。
           此前双向钉死 13px：格是方的，但 52 列只占面板 2/3，右侧空一大段（用户报障）。 */
        bandPadding: 0.18,
        label: {
          style: { fill: c.muted, fontSize: 11 },
          formatMethod: (v: string | string[]) => {
            const idx = Number(Array.isArray(v) ? v[0] : v);
            return weekLabels[idx] ?? '';
          },
        },
        domainLine: { style: { stroke: c.grid, opacity: 0 } },
        tick: { visible: false },
      },
      {
        orient: 'left' as const,
        /* [v1.10.2] 行高 = x 步长（由外层测量后传入）：正方形的另一半。
           ⚠️ autoRegionSize 是关键（读 band-axis.js 源码得出）：bandSize 固定后，
           只有它为 true 时 VChart 才把 region 高度撑到「bandSize × 行数」；
           缺省时 region 高由容器总高均分 —— y 轴被压进剩余窄条，格高 7px 横竖不等。 */
        bandSize: bandStep ?? 13,
        maxBandSize: bandStep ?? 13,
        maxExtent: bandStep ? bandStep * 7 : 91,
        autoRegionSize: true,
        bandPadding: 0.18,
        label: {
          style: { fill: c.muted, fontSize: 11 },
          /* [v1.10.2] 七天全标（周一–周日）。此前只标 一/四/日 是防挤 ——
             七行各有行内空间，不会挤。用户口径「Y 轴要显示全周一-周五」。 */
          formatMethod: (v: string | string[]) => {
            const n = Number(Array.isArray(v) ? v[0] : v);
            return ['一', '二', '三', '四', '五', '六', '日'][n] ?? '';
          },
        },
        domainLine: { visible: false },
        tick: { visible: false },
      },
    ],
    /* 颜色不走 scale：cell 显式给品牌色 + 透明度分档（见组件头注释） */
    cell: {
      style: {
        fill: c.line,
        fillOpacity: (d: unknown) => opacityFor((d as Cell).requests),
        cornerRadius: 2,
        /* [v1.10.2] 正方形闸门（读 heatmap.js 源码定案）：cell 的 size 来自
           series 级 `[x带宽, y带宽]` —— y 轴 region 被布局压窄时格就变扁。
           用户级 style 覆盖它：size 显式给 `[步长×0.82, 步长×0.82]`（0.82 = 剥
           bandPadding 0.18 后的净格宽），恒为正方形，不再依赖任何轴的布局行为。 */
        size: [bandStep ? Math.floor(bandStep * 0.82) : 11, bandStep ? Math.floor(bandStep * 0.82) : 11],
      },
      state: { hover: { stroke: c.line, lineWidth: 1 } },
    },
    tooltip: {
      visible: true,
      activeType: 'mark' as const,
      mark: {
        title: { value: (d: unknown) => String((d as Cell)?.date ?? '') },
        content: [{ key: '请求', value: (d: unknown) => str((d as Cell)?.text) }],
      },
    },
    legends: { visible: false },
    animation: false,
    background: 'transparent',
    padding: { top: 4, right: 4, bottom: 22, left: 26 },
  };

  return (
    <div className="activity-heat" ref={hostRef}>
      <Suspense fallback={<div className="activity-heat-loading" aria-hidden="true" />}>
        {/* 行高随测得的步长走（7 行 × step + 轴留白）—— 否则步长变大时格子溢出固定高。 */}
        <VChart spec={spec} style={{ width: '100%', height: (bandStep ?? 13) * 7 + 32 }} />
      </Suspense>
      <p className="ah-foot">
        <span className="ah-stat">
          活跃 <b>{model.active}</b> 天 · 共 <b>{formatInt(model.total)}</b> 次请求 · 单日峰值 <b>{formatInt(model.max)}</b>
        </span>
        <span className="ah-legend">
          少
          {[0.07, 0.28, 0.55, 0.92].map((o) => (
            <i key={o} style={{ background: c.line, opacity: o }} />
          ))}
          多
        </span>
      </p>
    </div>
  );
}
