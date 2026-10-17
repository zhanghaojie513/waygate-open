import { useState } from 'react';
import { useResource } from '../../hooks/useResource';
import { api } from '../../services/api';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';
import { formatCredits, formatInt } from '../../lib/format';
import { Tooltip } from '../ui/Tooltip';
import { Drawer } from '../ui/Drawer';

/**
 * 「提供商健康」卡片（v0.6.5 新增）。
 *
 * ## 为什么放在设置页
 * 本服务已从「单上游」演进为**多提供商并存**（WorkBuddy=openai / MiniMax Code=anthropic /
 * Qoder CN=qoder）。但三家各自的**健康信息与坑**此前散落在各处：
 *   · MiniMax 凭证轮换冲突（同账号被客户端登录会互相顶下线）只在「新增提供商」弹层提过一句；
 *   · Qoder 的零内容断流自动重试（v0.6.3）没有任何界面说明；
 *   · 「凭证是否有效 / 账本剩余多少 / 今天签到没」要分别去三个地方看。
 * 设置页是「系统状态总览」的自然落点，故收在这里。**只读**，不提供写操作。
 *
 * ## 数据来源（全部复用现有 API，无新增端点）
 *   `GET /api/providers` → 每家的 protocol / configured / active / credits（账本）/ signin（签到）
 *
 * ## 三项常驻说明（如实，不含推测）
 *   ① `requests` 表无 provider_id → 提供商归属按模型目录推断，逐条请求不记服务方；
 *   ② MiniMax 凭证互斥 → 建议专用账号；
 *   ③ Qoder 零内容重试 → 最多 1 次、对客户端无感。
 */

/** 协议 → 人话徽标色（与提供商表一致）。 */
const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI 方言',
  anthropic: 'Anthropic 方言',
  qoder: 'COSY 协议',
};

export function ProviderHealthCard() {
  const res = useResource(() => api.providers(), [], { cacheKey: 'providers' });
  const rows = res.data?.items ?? [];
  /* [v1.4.5] 任务面板（从提供商管理的提供商行迁来）：完成态/进度/奖励，只读抽屉。 */
  const [viewingGrowth, setViewingGrowth] = useState<(typeof rows)[number] | null>(null);
  const growthRes = useResource(() => api.providerGrowthPanel(viewingGrowth!.id), [viewingGrowth?.id], {
    enabled: viewingGrowth !== null,
  });

  return (
    <Panel
      title="提供商健康"
      aside={<Pill>{rows.length} 家 · 只读总览</Pill>}
    >
      {res.initial && res.loading ? (
        <div className="empty-note" style={{ padding: '8px 0' }}>正在读取提供商…</div>
      ) : res.error ? (
        <div className="empty-note" style={{ padding: '8px 0' }}>提供商列表没取到，稍后重试。</div>
      ) : rows.length === 0 ? (
        <div className="empty-note" style={{ padding: '8px 0' }}>
          还没有登记任何提供商 —— 到「提供商管理 → 提供商」新增。
        </div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <caption className="sr-only">各提供商的健康状态</caption>
            <thead>
              <tr>
                <th scope="col">提供商</th>
                <th scope="col">协议</th>
                <th scope="col">凭证</th>
                <th scope="col">状态</th>
                <th scope="col" className="r">模型数</th>
                <th scope="col">积分 / 签到</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="td-strong">{p.name}</td>
                  <td className="td-sub">{PROTOCOL_LABEL[p.protocol] ?? p.protocol}</td>
                  <td>
                    <span className={`up-badge${p.configured ? '' : ' warn'}`}>
                      {p.configured ? '有效' : '未配置'}
                    </span>
                  </td>
                  <td>
                    {p.active ? <Pill tone="live">已启用</Pill> : <Pill tone="ghost">未启用</Pill>}
                  </td>
                  <td className="r td-mono">{formatInt(p.modelCount ?? 0)}</td>
                  <td className="td-sub td-mono">
                    {p.credits?.available ? (
                      /* [2026-10-17] 三家统一给「剩余 / 已消耗 / 累计发放」（用户要求：账本
                         从概览移除后，这里是账本的常驻归宿）。已消耗/累计=账户级全部历史
                         （含官方客户端直连、含已过期包），与剩余不同口径 —— 弱化 + 悬停解释。 */
                      <>
                        剩余 {formatCredits(p.credits.remaining ?? 0)}
                        {p.credits.consumed !== null ? (
                          <>
                            {' '}
                            <Tooltip content={'已消耗 / 累计发放 —— 账户级全部历史（含官方客户端直连的用量）。\n不是本服务转发的那部分，与剩余不是同一种量。'}>
                              <span className="credit-aside">
                                已消耗 {formatCredits(p.credits.consumed)}
                                {p.credits.granted !== null ? ` / 发放 ${formatCredits(p.credits.granted)}` : ''}
                              </span>
                            </Tooltip>
                          </>
                        ) : null}
                        {p.credits.stale ? '（偏旧）' : ''}
                      </>
                    ) : p.qoderCredits ? (
                      /* [v1.6.1] Qoder 账本：余额取 v2/me/usage（套餐内 + 资源包）。
                         [v1.6.3] 「累计消耗」与余额不是同一种量（余额=还能用多少；
                         累计消耗=账号级近一年花掉多少，含官方客户端直连），
                         故弱化显示 + 虚线 + 悬停解释，不并列成同级数。 */
                      <>
                        {p.qoderCredits.remaining !== null
                          ? `剩余 ${formatCredits(p.qoderCredits.remaining)}`
                          : '余额未知'}
                        {p.qoderCredits.lifetimeConsumed !== null && p.qoderCredits.lifetimeConsumed !== undefined ? (
                          <>
                            {' '}
                            <Tooltip
                              content={
                                '累计消耗 —— 这个账号近一年在该平台消耗掉的 credits 总量（账号级）。\n' +
                                '它不是当前余额，也不是本服务转发的那部分：含官方客户端直连的用量。\n' +
                                '数值等于每日消耗热力图近 371 天之和。'
                              }
                            >
                              <span className="credit-aside">累计消耗 {formatCredits(p.qoderCredits.lifetimeConsumed)}{p.qoderCredits.granted !== null ? ` / 发放 ${formatCredits(p.qoderCredits.granted)}` : ''}</span>
                            </Tooltip>
                          </>
                        ) : null}
                        {p.qoderCredits.stale ? '（偏旧）' : ''}
                        {p.signin?.streak ? `（连续活跃 ${formatInt(p.signin.streak)} 天）` : ''}
                      </>
                    ) : p.wbCredits ? (
                      /* [v1.4.1] WorkBuddy 账本（资源包聚合）。[2026-10-17] 补已消耗/累计发放
                         —— consumed/granted 已含过期包（quota-parse 口径修正），与剩余分流：
                         剩余只算未过期包（不可用余额不作数），已消耗/发放是历史事实。 */
                      <>
                        剩余 {formatCredits(p.wbCredits.remaining ?? 0)}
                        {p.wbCredits.consumed !== null ? (
                          <>
                            {' '}
                            <Tooltip content={'已消耗 / 累计发放 —— 账户全部资源包的历史合计（含已过期包、\n含官方客户端直连的用量）。剩余只统计未过期包，两者口径不同。'}>
                              <span className="credit-aside">
                                已消耗 {formatCredits(p.wbCredits.consumed)}
                                {p.wbCredits.granted !== null ? ` / 发放 ${formatCredits(p.wbCredits.granted)}` : ''}
                              </span>
                            </Tooltip>
                          </>
                        ) : null}
                        {p.wbSignin?.streak ? `（连签 ${formatInt(p.wbSignin.streak)} 天）` : ''}
                      </>
                    ) : p.signin?.checkedOn ? (
                      <>今日已签到{p.signin.lastPoints ? ` +${formatInt(p.signin.lastPoints)}` : ''}</>
                    ) : p.wbSignin?.checkedOn ? (
                      <>今日已签到{p.wbSignin.lastPoints ? ` +${formatInt(p.wbSignin.lastPoints)}` : ''}</>
                    ) : (
                      '—'
                    )}
                  </td>
                  {/* [v1.4.5] 任务面板入口移到这里（提供商管理行内太挤）：WorkBuddy 有 OAuth 时可看任务完成情况。 */}
                  <td>
                    {p.protocol === 'openai' && p.wbOAuth?.configured ? (
                      <Tooltip content="查看成长任务的完成情况（进度/奖励/状态，只读）">
                        <button
                          type="button"
                          className="mini-pill"
                          onClick={() => setViewingGrowth(p)}
                        >
                          任务
                        </button>
                      </Tooltip>
                    ) : (
                      <span className="td-sub">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 常驻说明 —— 都是实测结论，不是推测 */}
      <ul className="ph-notes">
        <li>
          <b>积分口径（三家各不同）</b>：本表「积分」列都取<b>上游真实余额</b>，非本地推算。
          MiniMax Code 来自 <span className="code-chip">credit/details</span>（余额/已用/累计发放齐全，精确到 0.01）；
          WorkBuddy 来自资源包聚合 <span className="code-chip">get-user-resource</span>（剩余/发放为包级真实数）；
          Qoder CN 来自 <span className="code-chip">v2/me/usage</span>（套餐内 + 资源包合计 —— 签到赠送的
          Credits 进资源包，故签完此处会上涨）。<b>到期时刻仅 Qoder 不提供</b>（上游无此字段），
          概览「积分账本」对应列显示 <span className="code-chip">—</span>。
          另一种「累计消耗」是<b>账号级近一年消耗总量</b>（含官方客户端直连），与余额不是一回事，
          两者不混算。
        </li>
        <li>
          <b>每日签到</b>：MiniMax Code 由本服务每天 08:05 后自动代签（OAuth 链）。WorkBuddy 分两档：
          已导入桌面端 OAuth 凭证的（提供商管理 → 提供商 → 导入OAuth）每天 08:05 <b>自动代领</b>
          签到 + 成长任务 + 连登兑换；未导入的只做状态同步（上游不允许 API 密钥代领，403 实证）。
          OAuth 与转发用的 API 密钥互不影响（实验实证多会话共存，桌面端不受干扰）。成长任务的
          完成情况点本表「任务」查看（未完成的需在官方客户端真实使用后才能领）。
        </li>
        <li>
          <b>凭证口径（两家不同）</b>：
          <b>MiniMax Code 是真互斥</b> —— refresh token 一次性，且「同一账号同时只有一个有效会话」，
          桌面客户端登录会把本服务顶下线，反之亦然；<b>建议给本服务用专用账号</b>。
          <b>Qoder CN 不互斥</b> —— 支持多会话并存，本服务与桌面客户端可同时用同一账号（实测 2026-10-16），
          <b>无需</b>专用账号。任一凭证失效时到「提供商管理 → 提供商」重新导入。
        </li>
        <li>
          <b>Qoder 零内容断流自动重试</b>：Qoder 网关在大上下文时偶发「返回 200 但零字节即断开」，
          本服务会自动重发一次（最多 1 次，对客户端无感 —— 重试发生在响应提交之前）。
          请求日志里记 <span className="code-chip">retry_count</span> 与 <span className="code-chip">retried</span>。
        </li>
        <li>
          <b>提供商归属的已知限制</b>：请求表不记录「这条走的是哪家」，提供商归属按
          <b>模型 id → 目录</b>推断。因此同名的模型 id 分属两家时归属可能不准；
          请求日志的「提供商」列也是用同一推断口径。
        </li>
      </ul>

      {/* [v1.4.5] 任务面板抽屉（自提供商管理的提供商行迁来）。 */}
      {viewingGrowth ? (
        <Drawer
          title={`成长任务 · ${viewingGrowth.name}`}
          subtitle="完成态与奖励（上游实时只读；未完成的需在官方客户端真实使用后才能领）"
          onClose={() => setViewingGrowth(null)}
        >
          <div className="drawer-body">
            {growthRes.initial && growthRes.loading ? (
              <div className="empty-note">正在读取任务面板…</div>
            ) : growthRes.error || !growthRes.data?.ok ? (
              <div className="empty-note">{growthRes.error?.message ?? growthRes.data?.message ?? '任务面板没取到，稍后重试。'}</div>
            ) : (
              <div style={{ maxHeight: 'min(68vh, 640px)', overflow: 'auto' }}>
                <table className="tbl" style={{ minWidth: 480 }}>
                  <caption className="sr-only">成长任务完成情况</caption>
                  <thead>
                    <tr>
                      <th scope="col">任务</th>
                      <th scope="col" style={{ width: 56 }}>进度</th>
                      <th scope="col" className="r" style={{ width: 84 }}>奖励</th>
                      <th scope="col" style={{ width: 72 }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {growthRes.data.tasks.map((t) => (
                      <tr key={t.code}>
                        <td style={{ maxWidth: 104 }}>
                          <Tooltip content={t.desc ? `${t.title ?? t.code} —— ${t.desc}` : (t.title ?? t.code)}>
                            <span
                              className="td-strong"
                              style={{ display: 'inline-block', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}
                            >
                              {t.title ?? t.code}
                            </span>
                          </Tooltip>
                        </td>
                        <td className="td-mono">{t.progress ? `${t.progress.current}/${t.progress.target}` : '—'}</td>
                        <td className="r td-mono">{t.rewardCredit ? `${t.rewardCredit} 积分` : '—'}</td>
                        <td>
                          {t.status === 'claimed' ? <Pill tone="live">已领取</Pill>
                            : t.status === 'in_progress' ? <Pill tone="amber">进行中</Pill>
                            : t.locked ? <Pill tone="ghost">未解锁</Pill>
                            : <Pill tone="ghost">待完成</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="footer-note">
              每天 08:05 自动代领一轮（签到 + 已完成的任务 + 连登兑换）；这里的数据来自上游任务面板，实时只读。
            </div>
          </div>
        </Drawer>
      ) : null}
    </Panel>
  );
}
