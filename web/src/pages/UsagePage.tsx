import { useState, type ReactNode } from 'react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import { useFx } from '../hooks/useFx';
import type { TimeWindow } from '../types/api';
import { Topbar } from '../components/ui/Topbar';
import { Pill } from '../components/ui/Pill';
import { Select } from '../components/ui/Select';
import { Panel, StatBar } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { UsageSkeleton } from '../components/ui/PageSkeleton';
import { CreditBanner } from '../components/overview/CreditBanner';
import { TrendChart, METRIC_LABEL } from '../components/usage/TrendChart';
import type { TrendMetric } from '../components/usage/TrendChart';
import { BreakdownBars } from '../components/usage/BreakdownBars';
import { ClientModelTip } from '../components/usage/ClientModelTip';
import { ClientMetricTip } from '../components/usage/ClientMetricTip';
import { ModelUsageTable } from '../components/usage/ModelUsageTable';
import { QuotaSourceCard } from '../components/usage/QuotaSourceCard';
import { formatCredits, formatInt, formatPercent, formatRelative, formatTokens } from '../lib/format';
import { WINDOW_OPTIONS, WINDOW_LABEL } from '../lib/console';

/** 默认窗口「今日」（2026-10-09 用户口径：打开就看"今天到目前为止花了多少"）。
    与概览、提供商管理三页一致；`1h/24h/7d/30d` 仍在下拉里可选。
    [注意] today 是"今天到目前为止"不是完整一天，所以「日均消耗 / 按当前速度可用天数」
    这两块在它下面**按设计隐藏**（见下 WINDOW_DAYS_OF）—— 六块齐备的口径在 7d/30d 下验。 */
const DEFAULT_WINDOW: TimeWindow = 'today';
/** 「日均」类指标只对天级窗口有意义；today/1h/24h 窗口下隐藏（避免伪口径）。
    [2026-10-08] 'today' 也隐藏 —— 它是"今天到目前为止"，不是完整的一天，
    除出来的"日均"在早上会严重偏低（早 8 点看 ≈ 真实的 1/3）。 */
const WINDOW_DAYS_OF: Record<TimeWindow, number | null> = { today: null, '1h': null, '24h': null, '7d': 7, '30d': 30 };

/**
 * 积分与用量 —— 概览删掉的趋势 / 模型分布 / 提供商排行在这里落地。
 *
 * 「积分涨得快，是贵模型用得多还是请求变多了」这个问题需要同时看到两个量，
 * 所以趋势卡可以在 `credits ⇄ requests` 之间切 —— 切的是同一个 `trend` 数组的
 * 两个字段，不是两次请求。
 */
export function UsagePage() {
  const [win, setWin] = useState<TimeWindow>(DEFAULT_WINDOW);
  const res = useResource(() => api.overview(win), [win], { cacheKey: `overview:${win}` });
  useFx(`usage-${win}-${res.data ? 'ready' : 'pending'}`);
  /* [v0.5.11] 趋势主量纲从积分换成 token —— 积分对 MiniMax 是未知/免费
     （credits=null 不进合计），看积分会把 MiniMax 的量整个隐掉；token 才是
     跨提供商的普适量纲。 */
  const [metric, setMetric] = useState<TrendMetric>('tokens');
  const d = res.data;

  /* 日均 = 服务端字段 ÷ 窗口天数。**不遍历 trend 自行求和** ——
     api-contract §3.4 明令前端不得自行求和渲染；而且图表和统计条各算各的，
     同一页就会冒出两个「日均」。天级窗口才有；1h/24h 为 null（渲染层隐藏）。 */
  const windowDays = WINDOW_DAYS_OF[win];
  const dailyCredits = d && windowDays ? d.metrics.creditsUsed / windowDays : null;
  const dailyRequests = d && windowDays ? d.metrics.requests / windowDays : null;
  const dailyTokens = d && windowDays ? d.metrics.totalTokens / windowDays : null;

  /* 面板上写了「按 Token 排序」，就必须**真的排** —— 否则 Mock 里
     deepseek(23.32) 排在 minimax(41.50) 前面，页面上肉眼可见地自相矛盾
     （接口不保证顺序，降序得由这一层给）。 */
  const byModel = d ? [...d.byModel].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)) : [];
  const byClient = d ? [...d.byClient].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)) : [];

  /* 「按当前速度可用天数」只在额度接口真的给了剩余积分时才计算（AC-U05）。
     算不出就给 — 并写明为什么，绝不拿别的数凑一个像真的天数。 */
  const daysLeft =
    d && d.quota.available && d.quota.remain !== null && dailyCredits !== null && dailyCredits > 0
      ? Math.floor(d.quota.remain / dailyCredits)
      : null;
  const daysDetail = !d
    ? undefined
    : !d.quota.available
      ? '需要额度接口'
      : dailyCredits === null || dailyCredits <= 0
        ? `${WINDOW_LABEL[d.window]}无消耗记录`
        : `按日均 ${formatCredits(dailyCredits)} 积分估算`;

  /* [v0.5.11] 指标卡的悬停分布：同一指标按提供商拆开（数据就是 byClient，
     同一窗口同一来源 —— 不是另一套数）。每张卡按**自己那个量**排序，
     取前 6 名；没有提供商数据就不给 tip（悬停不出空框）。 */
  const clientTip = (kind: 'credits' | 'tokens' | 'requests'): ReactNode => {
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
        title="积分与用量"
        status={
          d ? <Pill tone="live" dot>{WINDOW_LABEL[d.window]} · {formatRelative(d.generatedAt)}</Pill> : null
        }
        actions={
          <Select value={win} options={WINDOW_OPTIONS} onChange={setWin} width={148} />
        }
      />

      <div className="view-body stack">
        {res.initial && res.loading ? (
          /* [v0.4.25] 骨架加载：横幅→统计条→趋势图→表格，与最终布局同形状 */
          <UsageSkeleton />
        ) : res.error ? (
          <Panel>
            <StateBlock kind="error" title="用量数据没取到" detail={errorDetail(res.error)} onRetry={res.reload} />
          </Panel>
        ) : d ? (
          <>
            <CreditBanner metrics={d.metrics} />

            <StatBar
              items={[
                {
                  label: `${WINDOW_LABEL[d.window]}消耗`,
                  value: formatCredits(d.metrics.creditsUsed),
                  detail: '经本服务转发 · 上游实扣累计',
                  tip: clientTip('credits'),
                  tipPos: 'down',
                },
                {
                  label: `${WINDOW_LABEL[d.window]}请求`,
                  value: formatInt(d.metrics.requests),
                  detail: `${formatInt(d.metrics.activeClients)} 个密钥活跃`,
                  tip: clientTip('requests'),
                  tipPos: 'down',
                },
                /* 天级窗口才有「日均」——1h/24h 下显示 tokens 密度替代（仍然真数据，不算日均）。
                   tipPos 一律 'down'：卡片是滚动容器的首行，向上弹会被容器上缘裁掉。 */
                ...(dailyCredits !== null
                  ? ([
                      {
                        label: '日均消耗',
                        value: formatCredits(dailyCredits),
                        detail: `${WINDOW_LABEL[d.window]}消耗 ÷ ${windowDays} 天`,
                        tip: clientTip('credits'),
                        tipPos: 'down',
                      },
                      {
                        label: '按当前速度可用天数',
                        value: daysLeft === null ? '—' : formatInt(daysLeft),
                        detail: daysDetail,
                        tone: d.quota.available ? undefined : ('amber' as const),
                      },
                    ] as const)
                  : ([
                      {
                        label: '本窗口总 tokens',
                        value: formatTokens(d.metrics.totalTokens),
                        detail: `输入 ${formatTokens(d.metrics.promptTokens)} · 输出 ${formatTokens(d.metrics.completionTokens)}`,
                        tip: clientTip('tokens'),
                        tipPos: 'down',
                      },
                    ] as const)),
              ]}
            />

            <Panel
              title={`${WINDOW_LABEL[d.window]}趋势`}
              aside={
                <span className="panel-aside-row">
                  <span className="seg-tabs" role="group" aria-label="趋势口径">
                    {(['tokens', 'requests'] as TrendMetric[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={metric === m ? 'on' : ''}
                        aria-pressed={metric === m}
                        onClick={() => setMetric(m)}
                      >
                        {m === 'tokens' ? 'Token' : '请求数'}
                      </button>
                    ))}
                  </span>
                  {/* 1h/24h/today 窗口的 trend 是小时桶（服务端 spec.bucket='hour'），
                      单位写「/ 天」就成了假口径 —— 跟着窗口说真话。 */}
                  <Pill>单位：{METRIC_LABEL[metric]} {win === '1h' || win === '24h' || win === 'today' ? '/ 小时' : '/ 天'}</Pill>
                </span>
              }
              padded={false}
            >
              <div style={{ padding: '0 20px 18px' }}>
                <TrendChart
                  points={d.trend}
                  metric={metric}
                  avg={metric === 'tokens' ? dailyTokens : dailyRequests}
                />
              </div>
            </Panel>

            <Panel
              title="按模型消耗明细"
              aside={<Pill>按 Token 排序</Pill>}
              padded={false}
            >
              <div style={{ padding: '0 20px 18px' }}>
                <ModelUsageTable items={byModel} windowLabel={WINDOW_LABEL[d.window]} />
              </div>
            </Panel>

            {/* [v0.4.28 用户要求] 「按工具消耗」已删除（与按提供商高度重合、信息增量低）；
                「按提供商消耗」改回全宽（duo 半宽对占比条太窄）。
                [v0.5.18] 条形值从积分改为 **tokens**：列表按 token 排序而条长按积分画，
                会出现「上面一行反而更短」的自相矛盾（用户实测报障）。条长/占比/排序
                三者现在同源（tokens）；积分作为附带信息留在尾注里。 */}
            <Panel title="按提供商消耗" aside={<Pill>按 Token 排序</Pill>}>
              <BreakdownBars
                windowLabel={WINDOW_LABEL[d.window]}
                items={byClient.map((c) => ({
                  key: c.clientId ?? '—',
                  label: c.client ?? '未识别',
                  value: c.tokens ?? 0,
                  format: 'int' as const,
                  trailing: `${formatPercent(c.share)} · ${formatCredits(c.credits)} 积分 · ${formatInt(c.requests)} 次`,
                  /* [v0.5.21] 悬停提供商名 → 该提供商的按模型消耗（服务端已按 tokens 取前 5）。 */
                  tip: <ClientModelTip row={c} />,
                }))}
              />
              <div className="footer-note">
                「未识别」是正常的识别分支，不是错误 —— 没绑定密钥又没匹配到特征时归到这里。
              </div>
            </Panel>

            <QuotaSourceCard quota={d.quota} provenance={d.provenance} windowLabel={WINDOW_LABEL[d.window]} />
          </>
        ) : null}
      </div>
    </div>
  );
}
// @zbiti-ai:f:243:ff3f4fa8
