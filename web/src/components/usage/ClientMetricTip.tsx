import type { ReactNode } from 'react';
import type { BreakdownItem } from '../../types/api';
import { formatCredits, formatInt, formatPercent, formatTokens } from '../../lib/format';

type ClientMetric = 'credits' | 'tokens' | 'requests';

const METRIC_LABEL: Record<ClientMetric, string> = {
  credits: '消耗积分',
  tokens: 'Token 消耗',
  requests: '请求次数',
};

function valueOf(row: BreakdownItem, metric: ClientMetric): number {
  return row[metric] ?? 0;
}

function formatValue(value: number, metric: ClientMetric): string {
  /* tokens 走 K/M/B/T/Q 阶梯（与卡片、表格同一口径）；requests 保持精确整数 ——
     次数是几十几百的量，压缩成「1.2K 次」反而难读。 */
  if (metric === 'credits') return formatCredits(value);
  return metric === 'tokens' ? formatTokens(value) : formatInt(value);
}

function formatUnit(metric: ClientMetric): string {
  return metric === 'credits' ? '积分' : metric === 'tokens' ? 'tokens' : '次';
}

export function ClientMetricTip({
  rows,
  metric,
  windowLabel,
  total,
  totalCount,
}: {
  rows: BreakdownItem[];
  metric: ClientMetric;
  windowLabel: string;
  total: number;
  totalCount: number;
}): ReactNode {
  const displayed = rows.slice(0, 6);
  const remaining = Math.max(0, totalCount - displayed.length);
  const safeTotal = Math.max(0, total);

  return (
    <div className="client-metric-tip">
      <div className="client-metric-tip-head">
        <div>
          <strong>客户端拆分</strong>
          <span>{windowLabel} · {METRIC_LABEL[metric]}</span>
        </div>
        <span className="client-metric-tip-tag">TOP {displayed.length}</span>
      </div>
      <div className="client-metric-tip-total">
        <span>窗口合计</span>
        <b>{formatValue(safeTotal, metric)} <em>{formatUnit(metric)}</em></b>
      </div>
      <div className="client-metric-tip-list">
        {displayed.map((row, index) => {
          const value = valueOf(row, metric);
          const ratio = safeTotal > 0 ? value / safeTotal : 0;
          return (
            <div className="client-metric-tip-row" key={row.clientId ?? row.client ?? index}>
              <div className="client-metric-tip-row-top">
                <span className="client-metric-tip-rank">{String(index + 1).padStart(2, '0')}</span>
                <span className="client-metric-tip-name">{row.client ?? '未识别'}</span>
                <b>{formatValue(value, metric)} <em>{formatUnit(metric)}</em></b>
              </div>
              <div className="client-metric-tip-row-bottom">
                <span className="client-metric-tip-track"><i style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} /></span>
                <span>{formatPercent(ratio)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {remaining > 0 ? (
        <div className="client-metric-tip-note">另有 {remaining} 个客户端未展开，完整明细见按客户端列表。</div>
      ) : null}
    </div>
  );
}

export type { ClientMetric };
