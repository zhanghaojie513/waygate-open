import { useState, type ReactNode } from 'react';
import { AlertTriangle, Coins, Gauge, Plus, TrendingUp, Zap } from 'lucide-react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import { useFx } from '../hooks/useFx';
import type { TimeWindow } from '../types/api';
import { readSharedWindow, writeSharedWindow } from '../lib/sharedWindow';
import type { Route } from '../hooks/useHashRoute';
import { Topbar } from '../components/ui/Topbar';
import { Pill } from '../components/ui/Pill';
import { Panel, KpiTile, KpiRow } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { OverviewSkeleton } from '../components/ui/PageSkeleton';
import { TokenTrend } from '../components/overview/TokenTrend';
import { ActivityHeat } from '../components/overview/ActivityHeat';
import { Banner } from '../components/ui/Banner';
import { ClientMetricTip } from '../components/usage/ClientMetricTip';
import { formatInt, formatCacheHitRate, formatCredits, formatPercent, formatRelative, formatTokens, formatRate } from '../lib/format';
import { WINDOW_LABEL } from '../lib/console';

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

  /* [v8] 活跃度热力图的一年数据。**固定 1y 窗口（364 天 = 52 周整）、不随页面窗口切** ——
     热力图的价值是长期节律，跟着「今日 / 24 小时」切换会失去意义。
     独立请求而不是并入主响应：overview 的窗口参数决定整套聚合口径
     （metrics / byModel / byProvider 全跟着变），为 91 个小数字多算一遍全套不值。
     后续若在意这一次额外请求，可在后端响应加独立 activity 字段 —— 接口不变。 */
  const heat = useResource(() => api.overview('1y'), [], { cacheKey: 'overview:1y:heat' });

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
    '90d': 91 * 24 * 60, // 91 天（13 周整），与窗口毫秒数同口径
    '1y': 364 * 24 * 60, // 52 周整（364 天）
  };
  const winMinutes = d ? WINDOW_MINUTES[d.window] : null;
  const avgRpm = d && winMinutes ? d.metrics.requests / winMinutes : null;
  const avgTpm = d && winMinutes ? d.metrics.totalTokens / winMinutes : null;

  /* [v0.5.16 用户要求] 「请求数」「已消耗积分」指标卡悬停给按提供商拆分 ——
     与用量页指标卡同一格式；byClient 的归属口径是「模型→目录 provider」（v0.5.15）。
     [2026-10-18 修] 分母必须与 metric **同量纲**：此前 tokens 落到 requests 分支，
     于是「Token 分布」算的是 tokens ÷ 请求数，占比能超过 100%。
     用量页同一处三分支齐全（UsagePage.tsx），两页口径必须一致。 */
  const clientTip = (kind: 'requests' | 'credits' | 'tokens'): ReactNode => {
    if (!d || d.byClient.length === 0) return undefined;
    const rows = [...d.byClient].sort((a, b) => (b[kind] ?? 0) - (a[kind] ?? 0));
    return (
      <ClientMetricTip
        rows={rows}
        metric={kind}
        windowLabel={WINDOW_LABEL[d.window]}
        total={kind === 'credits' ? d.metrics.creditsUsed : kind === 'tokens' ? d.metrics.totalTokens : d.metrics.requests}
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
            {/* [v7] 时间选择：分段控件只放三档常用的（今日 / 24 小时 / 7 天）。
                四段平铺：今日 / 24 小时 / 7 天 / 30 天 —— 不设下拉，
                档位一次可见、一次可点。「最近 1 小时」已删（用户裁决）：
                它和「今日」差一个量级，来回切会让四张卡的数看起来乱跳。 */}
            <span className="win-seg" role="group" aria-label="时间窗口">
              {(['today', '24h', '7d', '30d'] as TimeWindow[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  className={win === w ? 'on' : ''}
                  aria-pressed={win === w}
                  onClick={() => { writeSharedWindow(w); setWin(w); }}
                >
                  {w === 'today' ? '今日' : w === '24h' ? '24 小时' : w === '7d' ? '7 天' : '30 天'}
                </button>
              ))}
            </span>
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

            {/* [2026-10-17 评审裁决] KPI 只留三张：已消耗积分 / 平均 RPM / 平均 TPM。
                砍掉的：请求数（RPM 已含其量纲）、请求成功率（健康时是常数，
                异常时由横幅与请求页承担）、平均耗时（诊断数据不是决策数据）。
                三卡也解决了「6 卡 6 色一行铺彩虹」的扫读过载。 */}
            {/* [v5] 四张等宽 KPI 卡（原型解剖）。
                与上一版的差异：① 变化胶囊只承载**环比**（峰值/占比/告警下沉成 sub 灰字）；
                ② 补回第四张「成功率」——它此前被移走，但"今天跑得好不好"正是概览该回答的；
                ③ 四张等宽，首卡带品牌色图标标记核心指标（不跨列）。 */}
            <KpiRow count={4}>
              <KpiTile
                lead
                label="已消耗积分"
                value={<>{formatCredits(d.metrics.creditsUsed)}<span className="u">credits</span></>}
                icon={<Coins size={14} />}
                tip={clientTip('credits')}
                tipPos="down"
                sub={
                  d.metrics.creditsUnknownCount > 0
                    ? `另 ${formatInt(d.metrics.creditsUnknownCount)} 条未回报，未计入（≠ 没扣费）`
                    : '全部请求均已回报'
                }
              />
              <KpiTile
                label="平均 RPM"
                value={avgRpm !== null ? formatRate(avgRpm) : '—'}
                icon={<Gauge size={14} />}
                tip={clientTip('requests')}
                tipPos="down"
                sub={`每分钟请求 · ${WINDOW_LABEL[d.window]}`}
              />
              <KpiTile
                label="平均 TPM"
                value={avgTpm !== null ? (avgTpm < 1000 ? formatRate(avgTpm) : formatTokens(Math.round(avgTpm))) : '—'}
                icon={<TrendingUp size={14} />}
                tip={clientTip('tokens')}
                tipPos="down"
                sub={`每分钟 tokens · ${WINDOW_LABEL[d.window]}`}
              />
              {/* [v7] 第四张从「成功率」换成「缓存命中率」。
                  成功率是"健康时恒为 99%+ 的常数"，异常时由顶部横幅与请求日志承担 ——
                  它占着黄金位置却不提供日常决策信息。缓存命中率反过来：它直接决定花多少钱
                  （命中部分按缓存价计费），横幅撤掉后这里正好接住。 */}
              <KpiTile
                label="缓存命中率"
                value={formatCacheHitRate(d.metrics.cacheHitRate)}
                icon={<Zap size={14} />}
                sub={`${formatTokens(d.metrics.cachedTokens)} / ${formatTokens(d.metrics.promptTokens)} 输入 tokens`}
              />
            </KpiRow>

            {/* [v7] 活跃度热力图：13 周 × 7 天，颜色深浅 = 当日请求数。
                放在指标卡正下方 —— 它是四张卡的"时间维展开"：
                卡回答"这个窗口多少"，热力图回答"这 91 天里哪几天多"。 */}
            {heat.data && heat.data.trend.length > 0 ? (
              <Panel title="活跃度" aside={<Pill>最近 12 个月 · 每日请求数</Pill>}>
                <ActivityHeat points={heat.data.trend} />
              </Panel>
            ) : null}

            {/* [v7] token 消耗折线。数据取自同一个 overview 响应的 trend 字段，
                不额外请求 —— 与用量页的柱状趋势是同一份数；形态不同是因为
                那一页读「每桶量级」，这一页读「走势」。 */}
            <Panel
              title={`${WINDOW_LABEL[d.window]} token 消耗`}
              aside={<Pill>峰值 {formatTokens(Math.max(...d.trend.map((p) => p.tokens), 0))}</Pill>}
            >
              <TokenTrend points={d.trend} windowLabel={WINDOW_LABEL[d.window]} />
            </Panel>

            {/* [2026-10-17] 积分账本面板已从概览**移除**（用户裁决）：账户级账本
                （全部历史、含非本服务消耗）与概览的使命（本服务窗口实扣）天然打架，
                aside 口径补丁治标不治本 —— 三轮对账困惑后定案删除。数据没有丢：
                同一份 creditLedgers 仍在「设置 → 提供商健康卡」（语境正确，带口径
                悬停解释）与「客户端管理 → 模型数 tooltip」（剩余/已用）展示。 */}

            {/* [2026-10-17 修正] 本表改渲染 **byProvider**（按提供商归因：模型 id → 目录 provider）。
                此前误用 byClient（按 API 密钥）——密钥显示名取首绑提供商，两把密钥
                首绑同一家时（如 workbuddy 与 all 都首绑 WorkBuddy）出现"两个 WorkBuddy"，
                与标题「提供商用量摘要」不符。byProvider 无逐模型明细（该维度在下方模型摘要表），
                故本表不再挂 ClientModelTip。 */}
            <Panel title="提供商用量摘要" aside={<Pill>{d.byProvider.length} 个提供商 · 按 Token 排序</Pill>}>
              {d.byProvider.length > 0 ? (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <caption className="sr-only">提供商用量摘要，共 {d.byProvider.length} 个提供商</caption>
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
                      {[...d.byProvider].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 6).map((p) => {
                        const share = d && d.metrics.totalTokens > 0 ? (p.tokens ?? 0) / d.metrics.totalTokens : null;
                        return (
                        <tr key={p.providerId ?? '__unattributed__'}>
                          <td className="td-strong">
                            {/* providerId=null = 目录外模型（请求日志「提供商」列同口径显示 —） */}
                            <span>{p.provider ?? '未归属'}</span>
                          </td>
                          <td className="r td-mono">{formatInt(p.requests)}</td>
                          <td className="r td-mono">{formatTokens(p.tokens ?? 0)}</td>
                          <td className="r td-mono">{formatCredits(p.credits)}</td>
                          <td className="r td-mono">{formatPercent(share)}</td>
                          <td>
                            <div className="ov-bar-track">
                              <div className="ov-bar-fill" style={{ width: `${Math.max(2, Math.round((share ?? 0) * 100))}%` }} />
                            </div>
                          </td>
                        </tr>
                        );
                      })}
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
