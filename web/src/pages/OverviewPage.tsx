import { useState, type ReactNode } from 'react';
import { AlertTriangle, Coins, Gauge, Plus, TrendingUp } from 'lucide-react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import { useFx } from '../hooks/useFx';
import type { TimeWindow } from '../types/api';
import { readSharedWindow, writeSharedWindow } from '../lib/sharedWindow';
import type { Route } from '../hooks/useHashRoute';
import { Topbar } from '../components/ui/Topbar';
import { Pill } from '../components/ui/Pill';
import { Select } from '../components/ui/Select';
import { Panel, MetricCard } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { OverviewSkeleton } from '../components/ui/PageSkeleton';
import { CreditBanner } from '../components/overview/CreditBanner';
import { Tooltip } from '../components/ui/Tooltip';
import { Banner } from '../components/ui/Banner';
import { ClientModelTip } from '../components/usage/ClientModelTip';
import { ClientMetricTip } from '../components/usage/ClientMetricTip';
import { formatInt, formatCredits, formatDateTime, formatPercent, formatRelative, formatTokens } from '../lib/format';
import { WINDOW_OPTIONS, WINDOW_LABEL } from '../lib/console';

/**
 * 概览 —— 只留结论：积分横幅 + 4 个指标卡 + 最近请求。
 *
 * 请求趋势 / 模型分布 / 客户端排行已移入「积分与用量」（Spec v4-console-usage §3）。
 * 根因不是"首页内容太多"，而是**明细原来没有自己的页面**：结论页本就该只有结论，
 * 移走而不是折叠，才不会让同一组数字出现两个入口。
 *
 * 横幅与指标卡展示的是**本地可算的**指标（tokens / 缓存命中 / 积分）——
 * 上游取不到的订阅剩余积分已从界面移除（task#62）。
 */
export function OverviewPage({ navigate }: { navigate: (r: Route) => void }) {
  const [win, setWin] = useState<TimeWindow>(() => readSharedWindow() ?? 'today');
  const res = useResource(() => api.overview(win), [win], { cacheKey: `overview:${win}` });
  useFx(`overview-${win}-${res.data ? 'ready' : 'pending'}`);

  const d = res.data;

  /* [v0.4.28] 平均 RPM / TPM：总量 ÷ 窗口分钟数。
     today 窗口是「零点到现在」，时长不定——用当前时刻到零点的实际分钟数。 */
  const WINDOW_MINUTES: Record<TimeWindow, number | null> = {
    today: (() => {
      const now = new Date();
      return now.getHours() * 60 + now.getMinutes() || 1; // 至少 1 分钟
    })(),
    '1h': 60,
    '24h': 24 * 60,
    '7d': 7 * 24 * 60,
    '30d': 30 * 24 * 60,
  };
  const winMinutes = d ? WINDOW_MINUTES[d.window] : null;
  const avgRpm = d && winMinutes ? d.metrics.requests / winMinutes : null;
  const avgTpm = d && winMinutes ? d.metrics.totalTokens / winMinutes : null;

  /* [v0.5.16 用户要求] 「请求数」「已消耗积分」指标卡悬停给按提供商拆分 ——
     与用量页指标卡同一格式；byClient 的归属口径是「模型→目录 provider」（v0.5.15）。 */
  const clientTip = (kind: 'requests' | 'credits' | 'tokens'): ReactNode => {
    if (!d || d.byClient.length === 0) return undefined;
    const rows = [...d.byClient].sort((a, b) => (b[kind] ?? 0) - (a[kind] ?? 0));
    return (
      <ClientMetricTip
        rows={rows}
        metric={kind}
        windowLabel={WINDOW_LABEL[d.window]}
        total={kind === 'credits' ? d.metrics.creditsUsed : d.metrics.requests}
        totalCount={rows.length}
      />
    );
  };

  return (
    <div className="view on">
      <Topbar
        title="概览"
        status={
          d ? (
            <Pill tone="live" dot>
              本机日志聚合 · {formatRelative(d.generatedAt)}
            </Pill>
          ) : null
        }
        actions={
          <>
            <Select value={win} options={WINDOW_OPTIONS} onChange={(v) => { writeSharedWindow(v); setWin(v); }} width={148} />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('keys')}>
              <Plus size={14} />
              新建密钥
            </button>
          </>
        }
      />

      <div className="view-body stack">
        {/* [v0.4.25] 骨架加载代替文字卡 —— 形状与最终布局一致，出数据时原位替换不跳变 */}
        {res.initial && res.loading ? (
          <OverviewSkeleton />
        ) : res.error ? (
          <Panel>
            <StateBlock kind="error" title="概览数据没取到" detail={errorDetail(res.error)} onRetry={res.reload} />
          </Panel>
        ) : d ? (
          <>
            {/* [2026-10-07] 方案 E：渠道校验（11128）持续拒绝的告警横幅。固定口径=最近 1 小时
                （后端 OverviewService.alerts），阈值由后端同返回。10/06 故障持续 2 小时控制台
                零提示 —— 这条横幅就是那次排障耗掉一整晚的结构性修复。 */}
            {d.alerts.channelReject.count >= d.alerts.channelReject.threshold ? (
              <Banner tone="warn">
                <AlertTriangle size={14} aria-hidden />
                最近 1 小时出现 <b>{d.alerts.channelReject.count} 次</b>上游渠道校验拒绝（11128）：
                请求的 system 提示命中了上游的第三方客户端指纹。本服务会自动改写模板行、被拒时降级重试，
                连续失败说明出现了新的指纹变体。请到「请求日志」筛 note 含 upstream_11128 的行排查。
              </Banner>
            ) : null}

            {/* [2026-10-17 评审裁决] 密钥失效升格横幅：它是「唯一会让服务停摆的状态」
                （请求页脚注自己写的），此前却只是筛选项+统计格。单次即报（阈值 1），
                tone=error 而非 warn —— 没有 11128 那样的自动降级兜底，出现即全局 502。 */}
            {d.alerts.credentialInvalid?.count != null &&
            d.alerts.credentialInvalid.count >= d.alerts.credentialInvalid.threshold ? (
              <Banner tone="error" actions={<a href="#/clients" className="btn btn-quiet btn-sm">去提供商管理</a>}>
                <AlertTriangle size={14} aria-hidden />
                最近 1 小时出现 <b>{d.alerts.credentialInvalid.count} 次</b>上游访问密钥失效：
                所有请求将以 502 失败，直到换新为止。
              </Banner>
            ) : null}

            <CreditBanner metrics={d.metrics} />

            {/* [2026-10-17 评审裁决] KPI 只留三张：已消耗积分 / 平均 RPM / 平均 TPM。
                砍掉的：请求数（RPM 已含其量纲）、请求成功率（健康时是常数，
                异常时由横幅与请求页承担）、平均耗时（诊断数据不是决策数据）。
                三卡也解决了「6 卡 6 色一行铺彩虹」的扫读过载。 */}
            <div className="metric-row">
              <MetricCard
                label="已消耗积分"
                value={formatCredits(d.metrics.creditsUsed)}
                /* [v0.5.8] 口径铁律：这个数是**上游实扣**（usage.credit）的合计，不是估算。
                   上游没回报的行不计入合计（credits=null），故必须把「有多少行没算进来」
                   一起说出来 —— 否则用户会把这个数当成全部消耗。 */
                detail={
                  d.metrics.creditsUnknownCount > 0
                    ? `上游实扣 · 另 ${formatInt(d.metrics.creditsUnknownCount)} 条上游未回报，未计入`
                    : '上游实扣 · 全部请求均已回报'
                }
                tone="amber"
                icon={<Coins size={14} />}
                tip={clientTip('credits')}
                tipPos="down"
              />
              <MetricCard
                label="平均 RPM"
                value={avgRpm !== null ? formatInt(Math.round(avgRpm)) : '—'}
                detail={`每分钟请求 · ${WINDOW_LABEL[d.window]}`}
                tone="violet"
                icon={<Gauge size={14} />}
                tip={clientTip('requests')}
                tipPos="down"
              />
              <MetricCard
                label="平均 TPM"
                value={avgTpm !== null ? formatTokens(Math.round(avgTpm)) : '—'}
                detail={`每分钟 tokens · ${WINDOW_LABEL[d.window]}`}
                tone="green"
                icon={<TrendingUp size={14} />}
                tip={clientTip('tokens')}
                tipPos="down"
              />
            </div>

            {/* [v0.5.7] 积分账本（真实口径）—— MiniMax credit/details（精确到 0.01）。
                [v1.4.1] WorkBuddy 资源包聚合（get-user-resource 的 Accounts）同表并列：
                剩余/总量/已用都是包级真实数（Σ CapacityRemain/Size/Used）。 */}
            {/* aside 口径说明（2026-10-17 用户对账困惑后定稿）：账本记的是上游**账户**
                的全部历史消耗 —— 含用户在官方客户端等非本服务渠道花掉的积分，因此
                与上方「已消耗积分」卡片（本服务 24h 窗口实扣）天然不相等，不是 bug。 */}
            {d.creditLedgers.length > 0 ? (
              <Panel title="积分账本" aside={<Pill>上游账户账本（全部历史，含非本服务消耗）</Pill>}>
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">提供商</th>
                        <th scope="col" className="r">剩余积分</th>
                        <th scope="col" className="r">已消耗</th>
                        <th scope="col" className="r">累计发放</th>
                        <th scope="col">最近过期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.creditLedgers.map((c) => (
                        <tr key={c.providerId}>
                          <td className="td-strong">
                            {c.providerName}
                            {c.stale ? <Pill tone="ghost">数据偏旧</Pill> : null}
                          </td>
                          {/* 口径按家不同：上游没给的字段显示 —（不是 0）。 */}
                          <td className="r td-mono">{c.remaining !== null ? formatCredits(c.remaining) : '—'}</td>
                          <td className="r td-mono">{c.consumed !== null ? formatCredits(c.consumed) : '—'}</td>
                          <td className="r td-mono">{c.granted !== null ? formatCredits(c.granted) : '—'}</td>
                          <td className="td-sub td-mono">
                            {c.nextExpireAt ? formatDateTime(c.nextExpireAt) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* [2026-10-17 评审] 110 字口径脚注常驻每屏底部 —— 「读一次就该消失」
                    的内容做成了永久占据。收进 details 折叠（默认收起、点开即读，
                    语义不丢、屏占归零）。 */}
                <details className="footer-note ledger-caveat">
                  <summary>各家账本口径不同（含官方直连消耗，比逐条统计更全）</summary>
                  <b>MiniMax</b> 来自 credit/details（余额/已用/发放齐全，精确到 0.01）；
                  <b>WorkBuddy</b> 来自资源包聚合（get-user-resource，剩余/发放为包级真实数）；
                  <b>Qoder</b> 来自 me/usage（套餐内 + 资源包合计，签到赠送进资源包）。
                  到期时刻上游不提供，该列显示「—」。
                </details>
              </Panel>
            ) : null}

            {/* [v0.5.2] 提供商用量摘要 —— 回答「谁在用」：哪把密钥消耗了多少。
                与下方模型摘要（"花在哪"）构成两个正交视角，数据同源同窗口。 */}
            <Panel title="提供商用量摘要" aside={<Pill>{d.byClient.length} 个提供商 · 按 Token 排序</Pill>}>
              {d.byClient.length > 0 ? (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <caption className="sr-only">提供商用量摘要，共 {d.byClient.length} 个提供商</caption>
                    <thead>
                      <tr>
                        <th scope="col">提供商</th>
                        <th scope="col" className="r">请求次数</th>
                        <th scope="col" className="r">Token 消耗</th>
                        <th scope="col" className="r">消耗积分</th>
                        {/* [v0.5.18] 列名带口径：本表按 tokens 排序，占比也必须是 token 占比
                            （旧版只写「占比」而值按积分算，与排序口径错位）。 */}
                        <th scope="col" className="r">Token 占比</th>
                        <th scope="col">分布</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.byClient].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 6).map((c) => (
                        <tr key={c.clientId ?? c.client ?? 'unknown'}>
                          <td className="td-strong">
                            {/* 悬停提供商名 → 该提供商的按模型消耗；Portal Tooltip 会脱离表格滚动容器定位。 */}
                            <Tooltip content={<ClientModelTip row={c} />}>
                              <span>{c.client ?? '未归属'}</span>
                            </Tooltip>
                          </td>
                          <td className="r td-mono">{formatInt(c.requests)}</td>
                          <td className="r td-mono">{formatTokens(c.tokens ?? 0)}</td>
                          <td className="r td-mono">{formatCredits(c.credits)}</td>
                          <td className="r td-mono">{formatPercent(c.share)}</td>
                          <td>
                            <div className="ov-bar-track">
                              <div className="ov-bar-fill" style={{ width: `${Math.max(2, Math.round((c.share ?? 0) * 100))}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-note" style={{ padding: '24px 0' }}>{WINDOW_LABEL[d.window]}没有提供商消耗记录。</div>
              )}
            </Panel>

            {/* [v0.4.28] 模型用量摘要（替代「最近请求」原始流）——
                回答「积分花在哪了」这个问题，比逐条请求流有用得多。 */}
            <Panel title="模型用量摘要" aside={<Pill>{d.byModel.length} 个模型 · 按 Token 排序</Pill>}>
              {d.byModel.length > 0 ? (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <caption className="sr-only">模型用量摘要，共 {d.byModel.length} 个模型</caption>
                    <thead>
                      <tr>
                        <th scope="col">模型</th>
                        <th scope="col" className="r">请求次数</th>
                        <th scope="col" className="r">Token 消耗</th>
                        <th scope="col" className="r">消耗积分</th>
                        {/* [v0.5.18] 列名带口径：本表按 tokens 排序，占比也必须是 token 占比
                            （旧版只写「占比」而值按积分算，与排序口径错位）。 */}
                        <th scope="col" className="r">Token 占比</th>
                        <th scope="col">分布</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.byModel].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 8).map((m) => {
                        const name = m.displayName ?? m.model ?? '未知';
                        return (
                          <tr key={m.model ?? name}>
                            <td className="td-strong">{name}</td>
                            <td className="r td-mono">{formatInt(m.requests)}</td>
                            <td className="r td-mono">{formatTokens(m.tokens ?? 0)}</td>
                            <td className="r td-mono">{formatCredits(m.credits)}</td>
                            <td className="r td-mono">{formatPercent(m.share)}</td>
                            <td>
                              <div className="ov-bar-track">
                                <div className="ov-bar-fill" style={{ width: `${Math.max(2, Math.round((m.share ?? 0) * 100))}%` }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-note" style={{ padding: '24px 0' }}>{WINDOW_LABEL[d.window]}没有模型消耗记录。</div>
              )}
              <div className="footer-note">
                这一页只留结论。详细构成去「积分与用量」，逐条请求去「请求日志」。
              </div>
            </Panel>

            <div className="footer-note" style={{ marginTop: 0 }}>{d.provenance.note}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
// @zbiti-ai:f:132:0b9e0f79
