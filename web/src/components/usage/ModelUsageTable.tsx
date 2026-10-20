import type { BreakdownItem } from '../../types/api';
import { formatCredits, formatInt, formatPercent, formatTokens } from '../../lib/format';
import { Tooltip } from '../ui/Tooltip';

/**
 * 按模型消耗明细表。
 *
 * 「平均单次」= **Token 消耗 ÷ 请求次数**（v0.6.4 按用户要求从「单次积分」改为单次 token ——
 * 用量页主量纲是 token，单次 token 更能回答「这条为什么吃量」）。接口的 `BreakdownItem`
 * 没有 `ms` 字段，所以这里不显示耗时，也不编一个。
 * 占比用服务端给的 `share`，**不自行求和再相除**（api-contract §3.4 的一致性纪律）。
 * [v0.4.8] `windowLabel`：空态文案跟随所选时间窗（原写死「近 30 天」）。
 */
export function ModelUsageTable({ items, windowLabel }: { items: BreakdownItem[]; windowLabel: string }) {
  if (items.length === 0) {
    return <div className="empty-note" style={{ padding: '8px 0' }}>{windowLabel}没有按模型的消耗记录。</div>;
  }

  return (
    <>
      {/* [task#60] 同 `.tbl` 族的横向滚动防护：多列 nowrap，窄容器下横滚而不是被裁掉。 */}
      <div className="tbl-scroll">
        <table className="tbl">
          <caption className="sr-only">按模型的 token 消耗明细，共 {items.length} 个模型</caption>
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col" className="r">请求次数</th>
            <th scope="col" className="r">Token 消耗</th>
            {/* [v0.5.18] 占比列名带上口径：本表按 **tokens** 排序（用量页主量纲），
                所以占比也必须是 token 占比。旧版只写「占比」而值按积分算，
                与排序口径错位（用户报障）。积分另有独立列，不再借占比列表达。 */}
            <th scope="col" className="r">Token 占比</th>
            <th scope="col" className="r">消耗积分</th>
            <th scope="col" className="r">平均单次 Token</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => {
            const name = m.displayName ?? m.model ?? '未知模型';
            return (
              <tr key={m.model ?? name}>
                <td className="td-strong">
                  {name}
                  {/* [2026-10-08] 计价标签（限时免费 / 夜间折扣 / 订阅优先）——
                      这是「这行为什么这么便宜」的直接答案，而 `model_catalog.tag`
                      一直在库里、也一直是 `/api/models` 的字段，只是这一页没渲染。
                      放在模型名旁边而不是单独一列：它是**这一行模型的属性**，不是可比较的度量。 */}
                  {m.tag ? <span className="mu-tag">{m.tag}</span> : null}
                  {m.multiplier == null ? (
                    /* 倍率未知的行必须标注 —— 它是这一行**目录元数据**缺失的信号。
                       [2026-10-18 更正] 原先这里写「该行积分按中性倍率估算」：
                       那是 v0.5.8 之前的本地兜底公式行为，**公式已整段移除**。
                       现在积分一律取上游实扣（`usage.credit`），未回报即 `--`，
                       所以「倍率未知」只影响**倍率/均价**这类派生列的解读，
                       不代表积分不可信 —— 积分可不可信只看它是不是 `null`。
                       这里刻意用 `==` 而不是 `===`：`BreakdownItem.multiplier` 是可选的，
                       显式 null 与键缺失（undefined）都必须落进这一支 —— 只判 null 的话，
                       键一缺就静默不标，恰好放过「最该被标注的那一行」。eslint 已配 `{ null: 'ignore' }`，`== null` 合规。 */
                    <Tooltip content="目录（接口与本地快照）里都没有这个模型的倍率 —— 只影响本行派生列的解读，不影响积分口径：积分一律取上游实扣，上游未回报时该行显示 --，本服务不估算">
                      <span className="mu-unknown">倍率未知</span>
                    </Tooltip>
                  ) : null}
                </td>
                <td className="r td-mono">{formatInt(m.requests)}</td>
                <td className="r td-mono">{formatTokens(m.tokens ?? 0)}</td>
                {/* ★ 列序必须与表头严格一致（Token占比 → 消耗积分 → 平均单次 token）——
                    此前渲染成 credits/share/avg，与表头的 share/credits 错位（用户报障）。
                    末列按用户要求改为**平均单次 token**（tokens ÷ 请求数）。 */}
                <td className="r td-mono">{formatPercent(m.share)}</td>
                <td className="r td-mono">
                  {/* [v0.6.4] 全未回报 → `--` + 说明（不显示 0 —— 0 会被读成免费，与事实相反）。
                      [v1.6.29] 必须点明「未回报 ≠ 没扣费」。实测（2026-10-20）：
                      M3.1-Flash 的**未订阅**账户照常扣费（单次 15.78），但上游照样
                      不在 usage 里回报 credit。原文案只说"未回报"，会被读成"免费"。 */}
                  {m.credits === null ? (
                    <Tooltip
                      content={
                        (m.creditsUnknownCount
                          ? `本窗口 ${formatInt(m.creditsUnknownCount)} 条请求上游未回报单次费用。`
                          : '上游未回报单次费用。') +
                        '\n未回报 ≠ 没扣费：该模型在账户账本里可能照常扣。' +
                        '\n真实消耗以「积分账本」的已消耗为准（独立数据源）。'
                      }
                    >
                      <span className="cred-unknown">--</span>
                    </Tooltip>
                  ) : (
                    formatCredits(m.credits)
                  )}
                </td>
                <td className="r td-mono">
                  {m.requests > 0 ? formatTokens(Math.round((m.tokens ?? 0) / m.requests)) : '--'}
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
      <div className="footer-note">
        平均单次 = Token 消耗 ÷ 请求次数。接口不提供按模型的耗时，「较昨日」与「本计费周期」也无对应字段 ——
        这三样一律留空而不是补一个看着合理的数。
        <br />
        标着<b>「倍率未知」</b>的行，是上游接口与本地快照都没有倍率记录的模型 —— 它只说明<b>目录元数据缺失</b>；
        <b>积分口径不受影响</b>：一律取上游实扣，上游未回报时显示 <code>--</code>（本服务不估算）。
      </div>
    </>
  );
}
// @zbiti-ai:f:77:893d5eec
