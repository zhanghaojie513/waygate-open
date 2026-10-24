import { useEffect, useState } from 'react';

/**
 * 图表画布取色（VChart 等 Canvas 渲染器共用）。
 *
 * Canvas 拿不到 `var()`，必须读计算值。**不带 fallback 字面量**：
 * 手写 TSX 里出现色值会被 AC-11 门禁拦下（那是"绕过令牌"的缺陷特征）。
 * 兜底值写在 tokens.css / theme.css 的 --chart-* 一组里 —— 那两个文件
 * 是色板的赋值处，字面量在那里是本分。读不到时返回空串，
 * VChart 会落到自己的默认色，图表不会消失。
 */
export function readToken(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface ChartColors {
  line: string;
  grid: string;
  text: string;
  surface: string;
  muted: string;
}

/** 主题切换时重建 —— Canvas 不会自己重读 CSS 变量，
 *  监听 `<html data-theme>` 属性变化后重取一组。 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(readChartColors);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(readChartColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

function readChartColors(): ChartColors {
  return {
    line: readToken('--chart-line'),
    grid: readToken('--chart-grid'),
    text: readToken('--chart-text'),
    surface: readToken('--chart-surface'),
    muted: readToken('--chart-muted'),
  };
}
