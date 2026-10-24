import { lazy, Suspense, useMemo } from 'react';
import type { TrendPoint } from '../../types/api';
import { formatBucket, formatInt, formatTokens } from '../../lib/format';
import { useChartColors } from '../overview/chartTheme';

/**
 * 用量页趋势 —— VChart 柱状图（VisActor / Arco 图表体系）。
 *
 * ## 为什么是柱不是线（与概览堆叠面积的分工）
 *
 * 概览读「走势」（连续测量 → 线），这里读「每个桶的量级对比」（离散计数 → 柱）。
 * 同一份 trend 数据，两种形态各答一个问题（dataviz 的经典分工）。
 * [audit 2026-10-12] 的结论不变：柱墙在这里是**正确**形态。
 *
 * ## 为什么从手写 SVG 换成 VChart
 *
 * 用户裁决：图表统一用 Arco 体系（VisActor）。VChart 已因概览折线
 * 懒加载成独立 chunk，这里复用同一个 chunk，无增量体积。
 *
 * ## 与手写版的功能对齐
 *
 * 手写 TrendChart 有：日均参考线、失败红点、自绘 tooltip、键盘漫游。
 * VChart 版：日均线用 markLine、失败点用 point mark 绑 errors 字段、
 * tooltip 走 dimension 模式（预格式化文案，同 TokenTrend 教训）。
 * 键盘漫游暂缺 —— VChart 的 dimension tooltip 自带方向键支持（默认开启）。
 */

const VChart = lazy(async () => {
  const mod = await import('@visactor/react-vchart');
  return { default: mod.VChart };
});

export type TrendMetric = 'tokens' | 'requests';

export const METRIC_LABEL: Record<TrendMetric, string> = {
  tokens: '消耗 tokens',
  requests: '请求次数',
};

export function UsageTrend({
  points,
  metric,
  avg,
}: {
  points: TrendPoint[];
  metric: TrendMetric;
  /** 日均线（服务端口径：窗口消耗 ÷ 天数）。null = 天级窗口之外，不画线。 */
  avg: number | null;
}) {
  const c = useChartColors();

  const values = useMemo(
    () =>
      points.map((p) => ({
        bucket: formatBucket(p.bucket),
        value: metric === 'tokens' ? p.tokens : p.requests,
        errors: p.errors,
        text:
          metric === 'tokens'
            ? `${formatTokens(p.tokens)} tokens`
            : `${formatInt(p.requests)} 次请求`,
      })),
    [points, metric],
  );

  const spec = useMemo(() => {
    const isTokens = metric === 'tokens';
    /* as const 收敛字面量类型（同 TokenTrend）；markLine 分支后用 as 断言统一。 */
  const spec = {
      type: 'bar' as const,
      data: [{ id: 'trend', values }],
      xField: 'bucket',
      yField: 'value',
      /* 柱宽自适应，但上限钉住：桶少时（1h=2 格）柱子不会胀成方块。 */
      bar: { style: { fill: c.line, fillOpacity: 0.82, cornerRadius: [2, 2, 0, 0] } },
      axes: [
        {
          orient: 'left' as const,
          label: {
            style: { fill: c.muted, fontSize: 11 },
            formatMethod: (v: string | string[]) =>
              isTokens ? formatTokensAxis(Number(Array.isArray(v) ? v[0] : v)) : String(v),
          },
          grid: { style: { stroke: c.grid, lineDash: [0, 0] } },
          domainLine: { visible: false },
          tick: { visible: false },
          nice: true,
          tickCount: 5,
        },
        {
          orient: 'bottom' as const,
          label: { style: { fill: c.muted, fontSize: 11 }, autoLimit: true, visible: points.length <= 32 },
          grid: { visible: false },
          domainLine: { style: { stroke: c.grid } },
          tick: { visible: false },
        },
      ],
      /* 失败红点：绑在柱顶上方，只有 errors>0 才出现（其余 null 不渲染）。 */
      point: {
        visible: true,
        style: {
          shape: 'circle',
          size: (d: { errors: number }) => (d.errors > 0 ? 5 : 0),
          fill: 'var(--danger-red)',
          y: (d: { value: number }) => d.value,
        },
      },
      tooltip: {
        visible: true,
        activeType: 'dimension' as const,
        dimension: {
          visible: true,
          title: { value: (d: unknown) => str((d as Row)?.bucket) },
          content: [
            { key: isTokens ? '消耗' : '请求', value: (d: unknown) => str((d as Row)?.text) },
            {
              key: '失败',
              value: (d: unknown) => {
                const e = (d as Row)?.errors;
                return typeof e === 'number' && e > 0 ? `${e} 次` : '无';
              },
            },
          ],
        },
      },
      legends: { visible: false },
      animation: false,
      background: 'transparent',
      padding: { top: 14, right: 8, bottom: 24, left: 4 },
    };

    /* 日均线：markLine 水平参考线（仅天级窗口有 avg）。
       虚线 + 尾注「日均」，与手写版的语义一致。
       用展开合并而不是 spec.markLine 赋值 —— 推断出的字面量类型上没有这个键。 */
    const markLines =
      avg !== null && avg > 0
        ? [
        {
          y: avg,
          connectType: 'self' as const,
          label: {
            visible: true,
            text: isTokens ? `日均 ${formatTokens(avg)}` : `日均 ${formatInt(Math.round(avg))}`,
            position: 'insideEndTop' as const,
            style: { fill: c.muted, fontSize: 11 },
          },
          line: {
            style: { stroke: c.muted, lineWidth: 1, lineDash: [5, 4], opacity: 0.7 },
          },
        },
      ]
    : [];
    return { ...spec, markLine: markLines } as Parameters<typeof VChart>[0]['spec'];
  }, [values, metric, avg, c]);

  return (
    <Suspense fallback={<div className="usage-trend-loading" aria-hidden="true" />}>
      <VChart spec={spec} style={{ width: '100%', height: 240 }} />
    </Suspense>
  );
}

type Row = { bucket?: string; value?: number; errors?: number; text?: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Y 轴刻度（tokens 档）：与概览的 formatTokensAxis 同族。 */
function formatTokensAxis(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}K`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}
