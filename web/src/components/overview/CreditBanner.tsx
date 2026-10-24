import { formatCacheHitRate, formatCredits, formatInt, formatTokens } from '../../lib/format';
import type { OverviewMetrics } from '../../types/api';

/**
 * 用量横幅（task#62 改版；[v5] 二次改版）。
 *
 * ## 为什么不再显示「订阅剩余积分」
 *
 * 用户原话：「订阅积分现在是空白」。根因是上游**没有**提供额度查询接口
 * （额度端点实测 404，见 probe/03-upstream-verified.md）—— 那个数**根本取不到**。
 * 前端此前只能给一个 `--` 占位 + 一句「未取到额度来源…」，读起来像坏了/在加载，
 * 且永远好不了。用户明确要求：**别显示这个取不到的数**。
 *
 * ## [v5] 为什么把它从「三栏横幅」改成「一条读数带 + 一句脚注」
 *
 * 上一版是三段式：左边大数字（总 tokens）、中间积分口径说明、右边缓存命中率。
 * 问题不是不好看，是**和下方的四张 KPI 卡重复**：总 tokens 就是卡里的
 * 「平均 TPM」的分子，积分就是卡里的「已消耗积分」，同一个数在一屏里出现两次，
 * 而且横幅的 42px 大数字比 KPI 卡的 26px 更抢眼 —— 页面的视觉重心落在
 * 一个"重复信息"上。
 *
 * 新版只保留 KPI 卡里**没有**的两个指标（缓存命中率 + 输入/输出构成），
 * 并把口径说明折叠成一条脚注。这样它不再是一个"横幅"，
 * 而是 KPI 区域的一句补充 —— 信息一个没少，重复的部分删掉了。
 *
 * ## 命中率为 0 的展示（口径，保持原样）
 *
 * 缓存命中率**为 0 就是 0%**（DeepSeek 系上游真实返回 `cached_tokens: 0`），
 * 是真值、不是「上游未提供」。格式化统一走 `formatCacheHitRate`（纯函数，永远出百分比）。
 */
export function CreditBanner({ metrics }: { metrics: OverviewMetrics }) {
  return (
    <div className="credit-strip">
      {/* 左栏：三格读数 */}
      <div className="cs-readouts">
        <div className="cs-item">
          <span className="cs-k">缓存命中率</span>
          <span className="cs-v">{formatCacheHitRate(metrics.cacheHitRate)}</span>
          <span className="cs-d">
            {formatTokens(metrics.cachedTokens)} / {formatTokens(metrics.promptTokens)} 输入 tokens
          </span>
        </div>

        <div className="cs-item">
          <span className="cs-k">输入 / 输出</span>
          <span className="cs-v">
            {formatTokens(metrics.promptTokens)}
            <span className="cs-sep">/</span>
            {formatTokens(metrics.completionTokens)}
          </span>
          <span className="cs-d">本窗口 tokens 构成</span>
        </div>

        <div className="cs-item cs-total">
          <span className="cs-k">本窗口总 tokens</span>
          <span className="cs-v">{formatTokens(metrics.totalTokens)}</span>
          <span className="cs-d">输入 + 输出</span>
        </div>
      </div>

      {/* 右栏：这组数字怎么来的。
          [v6] 此前这段是横幅下方一整行脚注（占两行 49px），而右侧空着 483px ——
          内容没错，位置不对：它解释的就是左边那三个数，按距离应该在旁边。
          后两句是边界说明（未回报≠没扣费 / 直连不计入），低频但删了会误读，
          收进 <details> 按需展开。 */}
      <div className="cs-provenance">
        <p className="cs-prov-main">
          积分 <b>{formatCredits(metrics.creditsUsed)}</b> 为<b>上游实扣</b>，仅统计经本服务转发的请求
          {metrics.creditsUnknownCount > 0 ? (
            <>
              ；本窗口另有 <b>{formatInt(metrics.creditsUnknownCount)}</b> 条上游未回报积分，不计入合计
            </>
          ) : (
            '；全部请求均已回报'
          )}
          。
        </p>
        <details className="cs-prov-more">
          <summary>口径说明</summary>
          <p>
            未回报不等于没扣费 —— 部分模型（如 MiniMax 系）照常扣积分却不在响应里回报单次费用，
            那部分只体现在「积分账本」的已消耗里。官方客户端直连的消耗不计入，
            账户总消耗与余额以官方客户端为准。
          </p>
        </details>
      </div>
    </div>
  );
}
