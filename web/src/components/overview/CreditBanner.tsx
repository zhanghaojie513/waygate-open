import { formatCacheHitRate, formatCredits, formatInt, formatTokens } from '../../lib/format';
import type { OverviewMetrics } from '../../types/api';

/**
 * 用量横幅（task#62 改版）。
 *
 * ## 为什么不再显示「订阅剩余积分」
 *
 * 用户原话：「订阅积分现在是空白」。根因是上游**没有**提供额度查询接口
 * （额度端点实测 404，见 probe/03-upstream-verified.md）—— 那个数**根本取不到**。
 * 前端此前只能给一个 `--` 占位 + 一句「未取到额度来源…」，读起来像坏了/在加载，
 * 且永远好不了。用户明确要求：**别显示这个取不到的数**。
 *
 * 于是整块换掉：主数字改成**本窗口总 tokens**（纯本地日志可算，永远有值），
 * 并补上输入/输出 tokens 与缓存命中率 —— 都是能对账的真数字。
 *
 * ## 命中率为 0 的展示（口径）
 *
 * 缓存命中率**为 0 就是 0%**（DeepSeek 系上游真实返回 `cached_tokens: 0`），
 * 是真值、不是「上游未提供」。格式化统一走 `formatCacheHitRate`（纯函数，永远出百分比）。
 * 对应原型 .credit-banner。
 */
export function CreditBanner({ metrics }: { metrics: OverviewMetrics }) {
  return (
    <div className="credit-banner">
      <div className="cb-left">
        <div className="cb-label">本窗口总 tokens</div>
        <div>
          <span className="cb-num">{formatTokens(metrics.totalTokens)}</span>
        </div>
        <div className="cb-why">
          <span>
            输入 {formatTokens(metrics.promptTokens)} · 输出 {formatTokens(metrics.completionTokens)}
          </span>
        </div>
      </div>

      <div className="cb-mid">
        <div className="row">
          <span className="t">经本服务转发已用 {formatCredits(metrics.creditsUsed)} 积分</span>
        </div>
        <div className="cb-note">
          仅统计经本服务转发的请求（取上游实扣 usage.credit；上游未回报的行积分未知，不计入合计
          {metrics.creditsUnknownCount > 0 ? `，本窗口 ${formatInt(metrics.creditsUnknownCount)} 条` : ''}）。
          <b>未回报不等于没扣费</b> —— 部分模型（如 MiniMax 系）照常扣积分却不在响应里回报单次费用，
          那部分只体现在「积分账本」的已消耗里。
          官方客户端直连的消耗不计入 —— 账户总消耗与余额以官方客户端为准。
        </div>
      </div>

      <div className="cb-right">
        <div className="cb-label">缓存命中率</div>
        <div className="cb-num" style={{ fontSize: 22 }}>
          {formatCacheHitRate(metrics.cacheHitRate)}
        </div>
        <div className="cb-note">
          {formatTokens(metrics.cachedTokens)} / {formatTokens(metrics.promptTokens)} 输入 tokens
        </div>
      </div>
    </div>
  );
}
// @zbiti-ai:f:59:a9147165
