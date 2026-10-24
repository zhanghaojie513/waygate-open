import { useState, type ReactNode } from 'react';
import { Coins, Hash, Layers } from 'lucide-react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import { useFx } from '../hooks/useFx';
import type { TimeWindow } from '../types/api';
import { readSharedWindow, writeSharedWindow } from '../lib/sharedWindow';
import { Topbar } from '../components/ui/Topbar';
import { Pill } from '../components/ui/Pill';
import { Panel, KpiRow, KpiTile } from '../components/ui/Panel';
import { Tooltip } from '../components/ui/Tooltip';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { UsageSkeleton } from '../components/ui/PageSkeleton';
import { UsageTrend, METRIC_LABEL } from '../components/usage/UsageTrend';
import type { TrendMetric } from '../components/usage/UsageTrend';
import { BreakdownBars } from '../components/usage/BreakdownBars';
import { ClientModelTip } from '../components/usage/ClientModelTip';
import { ClientMetricTip } from '../components/usage/ClientMetricTip';
import { ModelUsageTable } from '../components/usage/ModelUsageTable';
import { QuotaSourceCard } from '../components/usage/QuotaSourceCard';
import { formatCacheHitRate, formatCredits, formatInt, formatPercent, formatRelative, formatTokens } from '../lib/format';
import { WINDOW_LABEL } from '../lib/console';

/** 默认窗口「今日」（2026-10-09 用户口径：打开就看"今天到目前为止花了多少"）。
    与概览、提供商管理三页一致；`1h/24h/7d/30d` 仍在下拉里可选。
    [注意] today 是"今天到目前为止"不是完整一天，所以「日均消耗 / 按当前速度可用天数」
    这两块在它下面**按设计隐藏**（见下 WINDOW_DAYS_OF）—— 六块齐备的口径在 7d/30d 下验。 */
const DEFAULT_WINDOW: TimeWindow = 'today';
/** 「日均」类指标只对天级窗口有意义；today/1h/24h 窗口下隐藏（避免伪口径）。
    [2026-10-08] 'today' 也隐藏 —— 它是"今天到目前为止"，不是完整的一天，
    除出来的"日均"在早上会严重偏低（早 8 点看 ≈ 真实的 1/3）。 */
const WINDOW_DAYS_OF: Record<TimeWindow, number | null> = { today: null, '1h': null, '24h': null, '7d': 7, '30d': 30, '90d': 91, '1y': 364 };

/**
 * 积分与用量 —— 概览删掉的趋势 / 模型分布 / 提供商排行在这里落地。
 *
 * 「积分涨得快，是贵模型用得多还是请求变多了」这个问题需要同时看到两个量，
 * 所以趋势卡可以在 `credits ⇄ requests` 之间切 —— 切的是同一个 `trend` 数组的
 * 两个字段，不是两次请求。
 */
export function UsagePage() {
  const [win, setWin] = useState<TimeWindow>(() => readSharedWindow() ?? DEFAULT_WINDOW);
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

  /* [v6] 指标卡**固定三张**：消耗积分 / 请求数 / Token 消耗。
     用户口径：「积分与用量的指标卡片固定 3 个」。

     此前是按窗口变化的 4-6 张（用了 data-count 1..6 五套列定义）。问题：
     切开页面先看到一排在变形的卡片，同一组指标在不同窗口下占不同位置，
     眼睛每次都要重新找「消耗」在哪。

     现在三张卡恒等宽，其余指标降到卡片下方的一条读数行（见 subStats）：
     日均 / 可用天数 / 我方开销 / 首字节 P95 —— 它们是**派生**或**次要**量，
     不配与三个主指标平起平坐。 */
  const kpiItems: Array<{
    label: string;
    value: ReactNode;
    icon: ReactNode;
    detail?: ReactNode;
    tip?: ReactNode;
    lead?: boolean;
  }> = d
    ? [
        {
          lead: true,
          label: `${WINDOW_LABEL[d.window]}消耗积分`,
          value: formatCredits(d.metrics.creditsUsed),
          icon: <Coins size={14} />,
          detail:
            d.metrics.creditsUnknownCount > 0
              ? `另 ${formatInt(d.metrics.creditsUnknownCount)} 条未回报，未计入`
              : '经本服务转发 · 上游实扣累计',
          tip: clientTip('credits'),
        },
        {
          label: `${WINDOW_LABEL[d.window]}请求数`,
          value: formatInt(d.metrics.requests),
          icon: <Hash size={14} />,
          detail: `${formatInt(d.metrics.activeClients)} 个密钥活跃`,
          tip: clientTip('requests'),
        },
        {
          /* Token 消耗：副注给出输入/输出构成与缓存命中率 ——
             这三项此前在横幅里各占一格，现在合成一张卡的副注，
             信息一条没少，但不再与卡片抢视线。 */
          label: `${WINDOW_LABEL[d.window]} Token 消耗`,
          value: formatTokens(d.metrics.totalTokens),
          icon: <Layers size={14} />,
          detail: (
            <>
              输入 {formatTokens(d.metrics.promptTokens)} · 输出 {formatTokens(d.metrics.completionTokens)}
              <br />
              输入缓存命中 {formatCacheHitRate(d.metrics.cacheHitRate)}
            </>
          ),
          tip: clientTip('tokens'),
        },
      ]
    : [];

  /* 补充读数行：三个主指标之外的派生量。
     **只放日均与可用天数** —— 它们在这个窗口下才成立，界面上也没有别处给。
     延迟指标（我方开销 / 首字节 P95）已从这里撤掉：用户口径是「是均值，不需要，
     这个在请求日志里能看到每条的」—— 请求日志每行都有首字与总耗时的真实值，
     这里的窗口均值反而抹平了分布，留着是重复且更不精确的那一份。 */
  const subStats: Array<{ label: string; value: ReactNode; detail?: string; tip?: string }> = d
    ? [
        ...(dailyCredits !== null
          ? [
              {
                label: '日均消耗',
                value: formatCredits(dailyCredits),
                detail: `${windowDays} 天均值`,
                tip: `${WINDOW_LABEL[d.window]}消耗 ÷ ${windowDays} 天。天级窗口才有 —— today/1h/24h 不是完整一天，除出来的日均会严重偏低。`,
              },
              {
                label: '按当前速度可用天数',
                value: daysLeft === null ? '—' : formatInt(daysLeft),
                detail: daysDetail,
                tip: '剩余积分 ÷ 日均消耗。额度接口不可用或本窗口无消耗时给「—」，不拿别的数凑。',
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="view on">
      {/* [v8] 与概览同款的分段控件（今日 / 24 小时 / 7 天 / 30 天）。
          两页同一控件，用户学一次就够；WINDOW_OPTIONS 已滤掉 1h/90d/1y。 */}
      <Topbar
        title="积分与用量"
        status={
          d ? <Pill tone="live" dot>{WINDOW_LABEL[d.window]} · {formatRelative(d.generatedAt)}</Pill> : null
        }
        actions={
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
            {/* [v6] 三张卡 + 一条读数带 + 一句脚注。
                横幅（.credit-strip）在此页**撤销**：它的「本窗口总 tokens」
                与第三张卡是同一个数，「输入/输出」是同一张卡的构成 ——
                同一份信息在一屏里出现两次，还把视觉重心放在了重复项上。
                横幅独有的三样（缓存命中率、输入输出构成、积分口径脚注）
                分别落到第三张卡的副注与这条脚注里，信息一条没少。 */}
            <KpiRow count={3}>
              {kpiItems.map((it) => (
                <KpiTile
                  key={it.label}
                  lead={it.lead}
                  label={it.label}
                  value={it.value}
                  icon={it.icon}
                  sub={it.detail}
                  tip={it.tip}
                  tipPos="down"
                />
              ))}
            </KpiRow>

            {subStats.length > 0 ? (
              <div className="substats">
                {subStats.map((s) => (
                  /* Tooltip 只接受单个子元素 —— 三项包在一层里，
                     悬停区就是整格，不是只有数字。 */
                  <Tooltip key={s.label} content={s.tip} placement="below" className="substat">
                    <span className="ss-cell">
                      <span className="ss-k">{s.label}</span>
                      <span className="ss-v">{s.value}</span>
                      {s.detail ? <span className="ss-d">{s.detail}</span> : null}
                    </span>
                  </Tooltip>
                ))}
              </div>
            ) : null}

            {/* 积分口径脚注：解释整组数字，不属于任何单一指标，
                所以留在卡外一行 —— 与 API 密钥页的 footer-note 同一处理。 */}
            <p className="footer-note usage-note">
              积分 {formatCredits(d.metrics.creditsUsed)} 为<b>上游实扣</b>，仅统计经本服务转发的请求
              {d.metrics.creditsUnknownCount > 0
                ? `（本窗口 ${formatInt(d.metrics.creditsUnknownCount)} 条上游未回报积分，不计入合计）`
                : ''}
              。未回报不等于没扣费 —— 部分模型（如 MiniMax 系）照常扣积分却不在响应里回报单次费用，
              那部分只体现在「积分账本」的已消耗里。官方客户端直连的消耗不计入，账户总消耗与余额以官方客户端为准。
            </p>

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
                <UsageTrend
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
