import { lazy, Suspense, useMemo } from 'react';
import type { TrendPoint } from '../../types/api';
import { formatBucket, formatTokens } from '../../lib/format';
import { useChartColors } from './chartTheme';
import { providerColor } from '../../lib/providerColor';
import { readToken } from './chartTheme';

type Row = {
  bucket?: string;
  provider?: string;
  tokens?: number;
  requests?: number;
  errors?: number;
  tokensText?: string;
  requestsText?: string;
  errorsText?: string;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/* providerColor 返回 var(--spectrum-N)——给 DOM 用没问题，
   **Canvas 不解析 CSS 变量**，直接传会回落成灰。这里剥出变量名读计算值。
   DOM 侧（图例 <i>）仍用原 var() 形式，主题切换自动跟随。 */
const canvasColor = (key: string): string => {
  const raw = providerColor(key);
  const m = raw.match(/var\((--[\w-]+)\)/);
  return m ? readToken(m[1]) : raw;
};

/**
 * 概览页的 token 消耗折线 —— VChart（VisActor）实现。
 *
 * ## 关于体积（必须写下来）
 *
 * `@visactor/react-vchart` 实测打进 bundle 是 **+579.5 KB gzip**（raw 2.1 MB，
 * 拖进来 12 个 @visactor/* 子包）。当前整个 vendor chunk 才 232 KB ——
 * 一条折线会让它涨到 2.5 倍。
 *
 * 所以这里做了两件事：
 *   ① **动态 import**：VChart 单独成 chunk，首屏不加载，只在概览页渲染图表时才拉；
 *   ② **只传极简 spec**：不带 toolbox / 图例 / 缩放 / 动画编排，
 *      VChart 的按需加载会因此少解析一截。
 *
 * 若日后嫌重，替换点只在这一个文件 —— 换成手写 SVG 约 60 行，
 * 接口（points + windowLabel）不变。
 */

/* 动态加载：把 VChart 甩到独立 chunk。Suspense 的占位必须与图表**同高**，
   否则加载完成时页面会跳一下（这是骨架屏最容易犯的错）。 */
const VChart = lazy(async () => {
  const mod = await import('@visactor/react-vchart');
  return { default: mod.VChart };
});

export function TokenTrend({ points, windowLabel }: { points: TrendPoint[]; windowLabel: string }) {
  const c = useChartColors();

  /* 空数据不画一条压底直线（那读作"归零"），给一句说明 —— 未知不等于 0。 */
  if (points.length === 0) {
    return (
      <div className="token-trend-empty">
        {windowLabel}还没有 token 消耗记录 —— 客户端发起第一次请求后这里会出现趋势。
      </div>
    );
  }

  const peak = Math.max(...points.map((p) => p.tokens), 0);

  /* [v8] 展平成「桶 × 提供商」长表：VChart 的堆叠靠 seriesField 分组，
     数据必须是每 (bucket, provider) 一行。某提供商在某桶没有数据就没有该行 ——
     堆叠时它贡献 0，面积不断开。
     提供商清单按全窗口 tokens 降序（图例顺序 = 视觉堆叠主次）。 */
  const { series, providerNames, nameById } = useMemo(() => {
    const nameTotal = new Map<string, number>();
    const nameById = new Map<string, string>();
    for (const p of points) for (const pr of p.providers ?? []) {
      const key = pr.providerId ?? pr.provider;
      nameTotal.set(key, (nameTotal.get(key) ?? 0) + pr.tokens);
      if (pr.provider) nameById.set(key, pr.provider);
    }
    const order = [...nameTotal.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const buckets = points.map((p) => formatBucket(p.bucket));
    const series = order.map((key) => {
      const byBucket = new Map<string, number>();
      for (const p of points) {
        const hit = (p.providers ?? []).find((pr) => (pr.providerId ?? pr.provider) === key);
        if (hit) byBucket.set(formatBucket(p.bucket), hit.tokens);
      }
      return {
        key,
        name: nameById.get(key) ?? key,
        data: buckets.map((b) => ({ bucket: b, tokens: byBucket.get(b) ?? 0 })),
      };
    });
    return { series, providerNames: order, nameById };
  }, [points]);

  /* as const：VChart 的 axes[].orient 要求字面量类型（'left' | 'bottom' | …），
     变量声明会被推成 string。 */
  const spec = {
    type: 'common' as const,
    /* 每提供商一个 area series，在同一 region 堆叠。
       颜色显式给（Canvas 不解析 var()，经 canvasColor 读计算值）——
       实测 seriesField + color scale 在堆叠 + Canvas 下不生效（面积是默认蓝/灰）。 */
    region: [{ id: "main" }],
    data: series.map((s) => ({ id: `trend-${s.key}`, values: s.data })),
    series: series.map((s, i) => ({
      type: 'area' as const,
      regionId: "main",
      dataIndex: i,
      xField: 'bucket',
      yField: 'tokens',
      stack: true,
      stackValue: "tokens",
      stackInverse: true,
      id: `area-${s.key}`,
      line: {
        style: {
          stroke: canvasColor(s.key),
          lineWidth: 2,
          curveType: 'monotoneX',
        },
      },
      area: {
        style: {
          fill: canvasColor(s.key),
          fillOpacity: 0.45,
        },
      },
      point: { visible: false },
    })),
    axes: [
      {
        orient: 'left' as const,
        label: {
          style: { fill: c.muted, fontSize: 11 },
          formatMethod: (v: string | string[]) => formatTokensAxis(Number(Array.isArray(v) ? v[0] : v)),
        },
        grid: { style: { stroke: c.grid, lineDash: [0, 0] } },
        domainLine: { visible: false },
        tick: { visible: false },
        nice: true,
        tickCount: 5,
        /* 堆叠图必须从 0 起：各层相加的总量才有意义。 */
        zero: true,
      },
      {
        orient: 'bottom' as const,
        label: {
          style: { fill: c.muted, fontSize: 11 },
          autoLimit: true,
        },
        grid: { visible: false },
        domainLine: { style: { stroke: c.grid } },
        tick: { visible: false },
      },
    ],
    crosshair: {
      xField: {
        visible: true,
        line: {
          type: 'line' as const,
          visible: true,
          style: { stroke: c.grid, lineWidth: 1, lineDash: [3, 3] },
        },
      },
    },
    tooltip: {
      visible: true,
      activeType: 'dimension' as const,
      dimension: {
        visible: true,
        title: { value: (d: unknown) => str((d as Row)?.bucket) },
        content: [
          { key: 'tokens', hasShape: true, value: (d: unknown) => str((d as Row)?.tokensText) },
        ],
      },
      style: {
        panel: {
          backgroundColor: c.surface,
          border: { color: c.grid, width: 1 },
          shadow: { x: 0, y: 4, blur: 12, spread: 0, color: 'rgba(0,0,0,.10)' },
        },
        titleLabel: { fill: c.text, fontSize: 12, fontWeight: 600 },
        keyLabel: { fill: c.muted, fontSize: 12 },
        valueLabel: { fill: c.text, fontSize: 12 },
      },
    },
    padding: { top: 12, right: 12, bottom: 26, left: 4 },
    animation: false,
    background: 'transparent',
  };

  return (
    <div className="token-trend">
      <Suspense fallback={<div className="token-trend-loading" aria-hidden="true" />}>
        <VChart spec={spec} style={{ width: '100%', height: 220 }} />
      </Suspense>
      {/* [v8] 图例：按全窗口 tokens 降序（与堆叠层次一致），色点用同一身份色。 */}
      <div className="tt-legend">
        {providerNames.map((n) => (
          <span className="tt-legend-item" key={n}>
            <i style={{ background: providerColor(n) }} />
            {nameById.get(n) ?? n}
          </span>
        ))}
      </div>
      <p className="token-trend-note">
        峰值 {formatTokens(peak)} tokens · 悬停查看各提供商在每个时段的消耗
      </p>
    </div>
  );
}

/** Y 轴刻度格式化：与 formatTokens 同族，但不带单位后缀的重复感。
 *  1.2K / 34K / 1.1M —— 轴上空间窄，只留量级。 */
function formatTokensAxis(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}K`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}
