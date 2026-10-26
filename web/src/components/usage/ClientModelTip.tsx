import type { BreakdownItem } from '../../types/api';
import { formatCredits, formatInt, formatPercent, formatTokens } from '../../lib/format';

/**
 * 入参取「本组件真正读到的字段」而非整个 BreakdownItem ——
 * [v1.10.2] 概览的 byProvider 行也复用本组件（悬停「按模型消耗」），
 * 它没有 model/displayName/share 这些模型维字段；按结构化子集收窄，
 * 两类调用方都类型安全。
 */
export type ClientModelTipRow = Pick<BreakdownItem, 'tokens' | 'credits'> & {
  /** 桶的显示名（byClient = 客户端名；byProvider = 提供商名）。 */
  client?: string | null;
  models?: Array<{
    model: string;
    displayName: string | null;
    requests: number;
    tokens: number;
    /* byProvider 切片的 credits 可空（整模型未回报 → `--`，与 byClient 同口径）。 */
    credits: number | null;
  }>;
  modelCount?: BreakdownItem['modelCount'];
};

export function ClientModelTip({ row }: { row: ClientModelTipRow }) {
  const models = row.models ?? [];
  const rest = Math.max(0, (row.modelCount ?? models.length) - models.length);
  const totalTokens = Math.max(0, row.tokens ?? 0);
  const clientName = row.client ?? '未归属';

  return (
    <div className="client-model-tip">
      <div className="client-model-tip-head">
        <div className="client-model-tip-title">
          <strong>{clientName}</strong>
          <span>模型消耗明细</span>
        </div>
        <span className="client-model-tip-tag">按模型</span>
      </div>

      <div className="client-model-tip-summary">
        <div>
          <span>总 tokens</span>
          <b>{formatTokens(totalTokens)}</b>
        </div>
        <div>
          <span>总积分</span>
          <b>{formatCredits(row.credits)}</b>
        </div>
      </div>

      {models.length > 0 ? (
        <div className="client-model-tip-list">
          {models.map((model, index) => {
            const ratio = totalTokens > 0 ? model.tokens / totalTokens : 0;
            const label = model.displayName ?? model.model;
            const showId = Boolean(model.displayName && model.displayName !== model.model);
            return (
              <div className="client-model-tip-row" key={model.model}>
                <div className="client-model-tip-row-head">
                  <span className="client-model-tip-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div className="client-model-tip-name">
                    <strong>{label}</strong>
                    {showId ? <span>{model.model}</span> : null}
                  </div>
                  <b>{formatTokens(model.tokens)} <em>tokens</em></b>
                </div>
                <div className="client-model-tip-row-meta">
                  <span className="client-model-tip-track"><i style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} /></span>
                  <span>{formatPercent(ratio)}</span>
                  <span>{formatInt(model.requests)} 次</span>
                  <span>{formatCredits(model.credits)} 积分</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="client-model-tip-empty">当前窗口没有可拆分的模型记录。</div>
      )}

      {rest > 0 ? (
        <div className="client-model-tip-note">另有 {rest} 个模型未展开，完整明细见「按模型消耗明细」。</div>
      ) : null}
    </div>
  );
}
