import { lazy, Suspense, useMemo } from 'react';
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
        /* 格子**不许被拉成横条**：band 上限 13px，面板再宽也只是轴变长、
           格间空隙微涨 —— 与参考图（贡献图）同一形态。 */
        maxBandSize: 13,
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
        /* 行高钉死：7×13px 小方块 */
        bandSize: 13,
        bandPadding: 0.18,
        label: {
          style: { fill: c.muted, fontSize: 11 },
          /* 只标 一 / 四 / 日（贡献图惯例）—— 七个字会挤成一列 */
          formatMethod: (v: string | string[]) => {
            const n = Number(Array.isArray(v) ? v[0] : v);
            return n === 0 ? '一' : n === 3 ? '四' : n === 6 ? '日' : '';
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
    <div className="activity-heat">
      <Suspense fallback={<div className="activity-heat-loading" aria-hidden="true" />}>
        <VChart spec={spec} style={{ width: '100%', height: 150 }} />
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
