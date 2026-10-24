import { CalendarCheck, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import { RowMenu } from '../ui/RowMenu';
import { Chip } from '../ui/Pill';
import { providerColor } from '../../lib/providerColor';
import type { ProviderItem, ProviderUsageRow } from '../../types/api';

import { formatCredits, formatInt, formatRelative } from '../../lib/format';
import { Tooltip } from '../ui/Tooltip';

/**
 * 提供商表 —— **一行一家**，行内直接给这家订阅的用量（2026-10-09）。
 *
 * ## 为什么没有"客户端子行"
 * 本项目的形态是**反代客户端订阅**：**客户端 ≡ 提供商**，一家订阅就是一个客户端。
 * 曾经把客户端做成缩进子行，结果是**同一串数字出现两次**（提供商行是它的合计，
 * 子行是它自己）——名字也只差大小写。用户判定为累赘并已去掉。
 * 只有当"一家提供商下挂着多个客户端"时子行才有信息量，而本形态不产生那种数据。
 *
 * ## 用量数字从哪来
 * `requests` 表**没有** provider 维度 —— 逐条请求归属不了某一家（日志里也不显示）。
 * 数字来自 `api.clients(窗口)` 的 **`byProvider`**：服务端把窗口内请求按
 * 「模型 id → 生效目录的 provider」归因聚合（与请求日志「提供商」列、概览 byClient 同源）。
 * 多生效下每家各报各的，**不再需要**「只有一家启用才可归属」的保守门槛（v0.6.0 修）。
 * 目录外的模型的请求归到 `providerId=null` 桶，不显示在任何一行上（不冒充）。
 *
 * ## 末列的操作只有「改配置」
 * 改：`配置` / `模型列表` / `启用或停用` / `删除`。
 * 查（API Keys / 请求日志）都不在这一行：侧栏有自己的导航入口，
 * 这行再放等于重复导航（2026-10-09 / 2026-10-10 两次用户要求去掉）。
 *
 * [v1.6.4] 「修改」→「配置」：对 MiniMax / Qoder 它改不了凭证（凭证是客户端登录态里的
 *   令牌，用户无从手填），叫「修改」会让人以为能在那里改密钥 —— 与抽屉里的实际内容对不上。
 */
export function ProviderTable({
  rows,
  byProvider,
  busyId,
  onEdit,
  onModels,
  onSignin,
  onGrowthRun,
  onOauthImport,
  onActivate,
  onDeactivate,
  onDelete,
}: {
  rows: ProviderItem[];
  /** [v0.6.0] 按提供商聚合的用量（服务端归因，窗口同上）——本表三列用量直接用。 */
  byProvider?: ProviderUsageRow[];
  /** 活提供商的模型目录（非活的行没有清单，见下方「模型列表」的禁用理由）。 */
  busyId: string | null;
  onEdit: (row: ProviderItem) => void;
  onModels: (row: ProviderItem) => void;
  /** [v0.5.6] 立即签到（仅 MiniMax oauth 提供商有按钮）。 */
  onSignin: (row: ProviderItem) => void;
  /** [v1.4.0] 手动跑一轮 WorkBuddy 领取（签到+任务+兑换）。 */
  onGrowthRun: (row: ProviderItem) => void;
  /** [v1.4.4] 打开任务面板（只读：完成态/进度/奖励）。 */
  /** [v1.4.0] 导入 WorkBuddy OAuth 凭证。 */
  onOauthImport: (row: ProviderItem) => void;
  onActivate: (row: ProviderItem) => void;
  /** [v0.5.1] 停用（多生效切换的另一侧）。 */
  onDeactivate: (row: ProviderItem) => void;
  onDelete: (row: ProviderItem) => void;
}) {
  /* 与服务端 localDate 同口径：Asia/Shanghai 日历日（YYYY-MM-DD）。 */
  const todayIso = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  /* [v0.6.0] 用量按**目录归属的提供商**取（服务端 byProvider，与请求日志「提供商」同源）——
     取代此前的「只有一家启用时可归属」保守门槛：多生效下也能精确归属。
     目录外的模型归到 providerId=null 桶，不在任何提供商行上显示（不冒充）。 */
  const usageByProvider = new Map((byProvider ?? []).map((b) => [b.providerId ?? '', b]));

  /* [2026-10-10] 「API Keys」跳转按钮已删（用户要求）—— 唯一消费者是它的 href，
     `sole`（唯一客户端时的过滤参数）随之退役。 */

  return (
    /* [task#60] 同 `.tbl` 族的横向滚动防护：多列 nowrap，窄容器下必须能横滚而不是被裁掉。 */
    <div className="tbl-scroll">
      <table className="tbl">
        <caption className="sr-only">提供商列表，共 {rows.length} 家提供商</caption>
        <thead>
          <tr>
            <th scope="col">提供商</th>
            {/* [2026-10-10 用户要求] 密钥独立成列 —— 它是要核对/登记的对象，
                不是可比较的量纲，但也不该和地址/模型数挤在名称副行里被埋掉。 */}
            <th scope="col">密钥</th>
            <th scope="col" className="r">请求次数</th>
            <th scope="col" className="r">消耗积分</th>
            <th scope="col" className="r">最后活跃</th>
            <th scope="col" className="r">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const busy = busyId === p.id;
            return (
              <tr className="prov-row" key={p.id}>
                <td className="td-strong">
                  {/* [v5] 提供商身份色点：与光谱七色同源，按 id 稳定映射。
                      和官网棱镜装置说的是同一件事 —— 那里「光被分成七色」，
                      这里「流量按来源分色」。同一家在任何页面都是同一个颜色。 */}
                  <i className="prov-dot" style={{ background: providerColor(p.id) }} aria-hidden="true" />
                  {p.name}
                  {p.active ? <Chip tone="ok">已启用</Chip> : <Chip tone="mute">未启用</Chip>}
                  {/* [v0.5.0] 协议徽标：一眼区分 WorkBuddy（OpenAI 方言）与 MiniMax（Anthropic 方言）。
                      [v0.6.0] Qoder CN（COSY 协议，免费档）。 */}
                  {p.protocol === 'custom' ? (
                    <Tooltip content="自定义 OpenAI 兼容端点：静态 API key 鉴权；模型清单拉 /v1/models 或手动补；无签到与积分账本（用量按 token，积分列 --）">
                      <span className="pill pill-ghost">自定义</span>
                    </Tooltip>
                  ) : p.protocol === 'anthropic' ? (
                    <Tooltip content="Anthropic Messages 方言（mavis 网关）：模型目录用内置清单，凭证为 refresh token 自动换新">
                      <span className="pill pill-ghost">Anthropic</span>
                    </Tooltip>
                  ) : p.protocol === 'qoder' ? (
                    <Tooltip content="Qoder CN 网关（COSY 协议）：免费档 billable:false 实扣 0；目录从网关 /model/list 拉取；凭证为客户端身份 JSON（不自动刷新）">
                      <span className="pill pill-ghost">Qoder</span>
                    </Tooltip>
                  ) : null}
                  {/* [2026-10-12 用户要求] 行内只留「N 个模型」，地址 / 启用数 / 积分账本
                      全部移入悬停提示 —— 第二行原来串了四段信息，扫读时被地址顶长。 */}
                  <div className="td-sub td-mono">
                    <Tooltip
                      content={
                        <>
                          <div className="client-model-tip">
                            <div className="client-model-tip-head">
                              <div className="client-model-tip-title">
                                <strong>{p.name}</strong>
                                <span>{p.baseUrl}</span>
                              </div>
                              <span className="client-model-tip-tag">{p.active ? '已启用' : '未启用'}</span>
                            </div>
                            <div className="client-model-tip-summary">
                              <div>
                                <span>模型总数</span>
                                <b>{formatInt(p.modelCount ?? 0)}</b>
                              </div>
                              <div>
                                <span>已启用</span>
                                <b>{formatInt(p.modelEnabled ?? 0)}</b>
                              </div>
                            </div>
                            {/* [2026-10-17 修正] 账本字段按协议分流（此前只读 credits —— 那是
                                MiniMax 专属，WB/Qoder 的账本在 wbCredits/qoderCredits 里，
                                导致这两家的行上「剩余积分+已用」永远不显示）。 */}
                            {(() => {
                              const led = p.credits?.available
                                ? { remaining: p.credits.remaining, consumed: p.credits.consumed }
                                : p.wbCredits
                                  ? { remaining: p.wbCredits.remaining, consumed: p.wbCredits.consumed }
                                  : p.qoderCredits
                                    ? { remaining: p.qoderCredits.remaining, consumed: p.qoderCredits.consumed }
                                    : null;
                              return led && (led.remaining !== null || led.consumed !== null) ? (
                                <div className="client-metric-tip-total">
                                  <span>剩余积分</span>
                                  <b>
                                    {formatCredits(led.remaining ?? 0)} <em>已用 {formatCredits(led.consumed ?? 0)}</em>
                                  </b>
                                </div>
                              ) : null;
                            })()}
                            {(p.credits?.stale || p.qoderCredits?.stale) ? (
                              <div className="client-model-tip-note">⚠ 积分数据偏旧（账本快照超时）</div>
                            ) : null}
                          </div>
                        </>
                      }
                    >
                      <span className="prov-model-count">{formatInt(p.modelCount ?? 0)} 个模型</span>
                    </Tooltip>
                  </div>
                </td>
                <td className="td-cred">
                  <Tooltip content="供应商访问密钥（掩码显示；全量只存在服务器上）">
                    <span className="cred-mask">{p.credentialMask}</span>
                  </Tooltip>
                  {/* [v5] 与上面那处一致：凭证状态用 Chip（健康语义），不用 up-badge。
                      up-badge 的底色是 brand-tint、字色是 brand-400 —— 浅色主题下
                      brand-400 是深朱砂，读起来像"警示"，而"凭证有效"是好消息。 */}
                  <Chip tone={p.configured ? 'ok' : 'warn'}>
                    {p.configured ? '凭证有效' : '未配置'}
                  </Chip>
                </td>
                <td className="r td-mono">{p.active ? formatInt(usageByProvider.get(p.id)?.requests ?? 0) : '—'}</td>
                {/* [2026-10-18] 不能 `?? 0`：MiniMax 系上游不回单次 credit，整桶未知时
                    服务端给 null。显示 `--` 而不是 0.00 —— 0 会被读成「免费」，与事实相反。
                    下面 requests 的 `?? 0` 是对的：次数是可数的，没有提供商就是 0 次。 */}
                <td className="r td-mono">{p.active ? formatCredits(usageByProvider.get(p.id)?.credits ?? null) : '—'}</td>
                <td className="r td-mono">
                  {p.active ? formatRelative(usageByProvider.get(p.id)?.lastSeenAt ?? null) : '—'}
                </td>
                <td className="r">
                  <span className="prov-row-actions">
                    {/* 「API Keys」不在这一行（2026-10-10 用户要求去掉）：
                        侧栏本来就有「API Keys」入口，这行再放一个是重复导航。
                        「请求日志」也不在这一行（2026-10-09 同理由去掉）。
                        [v1.6.15] 「重新导入授权」也移出这一行（用户口径）：它属于
                        凭证操作，放进「配置」抽屉里即可 —— 行内只留高频的
                        配置 / 模型列表 / 签到 / 启停 / 删除。 */}
                    <Tooltip content="改名称与上游地址；凭证可在抽屉内「重新导入授权」">
                      <button type="button" className="mini-pill" disabled={busy} onClick={() => onEdit(p)}>
                        <Wrench size={12} />
                        配置
                      </button>
                    </Tooltip>
                    <Tooltip content="查看这家自己的模型清单（启停只作用于该提供商分区）">
                      {/* 元素类型/属性恒定（不翻 disabled、不换 span 包裹）——理由见签到按钮注释。 */}
                      <button
                        type="button"
                        className="mini-pill"
                        aria-disabled={busy || !p.active}
                        /* 契约 §3.12：模型目录**属于活提供商**，非活的那家服务端没有清单 ——
                           给它一个能点的按钮，点开只会是空表或上一家的清单（那是编出来的数据）。 */
                        onClick={() => { if (!busy && p.active) onModels(p); }}
                      >
                        <RefreshCw size={12} />
                        模型列表
                      </button>
                    </Tooltip>
                    {/* [v0.5.6] 签到（仅 MiniMax Code 客户端订阅）：显示今日状态，一键补签。
                        [v1.3.0] 实证 WorkBuddy 上游不允许 ck_ 代领（403），不做其签到按钮 ——
                        它的签到状态在设置页「提供商健康」卡同步展示。 */}
                    {/* [v1.6.0] 签到按钮：MiniMax（oauth）与 Qoder（cosy，v1.6.0 起支持）共用同一套 signin_* 状态。
                        自动签到时刻**两家不同**，故按提供商取（不能写死一个）：MiniMax 08:05、
                        Qoder 10:05（官方活动每日 10:00 UTC+8 刷新，见 qoder-activity.service.ts 常量注释）。
                        文案里的时刻必须与服务端常量一致 —— 否则用户照提示等到 08:05 会白等。 */}
                    {/* [v0.5.1] 多生效：启用/停用切换（最后一个生效的不可停 —— 服务端把关）。 */}
                    {p.active ? (
                      <Tooltip content="退出出站路由（目录与凭证保留，可再启用）">
                        {/* 同签到按钮：不翻 disabled，避免 Tooltip 换分支重挂。 */}
                        <button
                          type="button"
                          className="mini-pill"
                          aria-disabled={busy}
                          onClick={() => { if (!busy) onDeactivate(p); }}
                        >
                          停用
                        </button>
                      </Tooltip>
                    ) : (
                      <button type="button" className="mini-pill" disabled={busy} onClick={() => onActivate(p)}>
                        启用
                      </button>
                    )}
                    {/* [v5] 低频操作收进「更多」：签到与删除。
                        高频三枚（配置 / 模型列表 / 启停）留在行内。
                        理由：五枚并排要 380px，操作列只有 300px —— 折行会让行高
                        由按钮数量决定（实测 46 / 76 / 108 三种行高并存），
                        表格失去横向基线。而 nowrap 会撑出横向滚动条，
                        为了点「删除」还得先滑一下 —— 低频操作不该占这个成本。 */}
                    <RowMenu disabled={busy}>
            {p.credKind === 'oauth_minimax' || p.protocol === 'qoder' ? (
              <Tooltip
                content={(() => {
                  const at = p.protocol === 'qoder' ? '10:05' : '08:05';
                  const base = p.signin?.checkedOn
                    ? `最近签到 ${p.signin.checkedOn}${p.signin.lastPoints ? ` · +${p.signin.lastPoints} 积分` : ''}（relay 每天 ${at} 自动签）`
                    : `今天还没签到 —— 点一下立即签（relay 每天 ${at} 也会自动签）`;
                  /* [v1.6.10] Qoder 补一行**官方标注**（用户口径）：上面的 10:05 是 relay
                     自己的代签时刻，与官方的 10:00 刷新不是一回事，光给前者会让人以为
                     "10:05 才有活动"；有效期 30 天更是结果里推不出来的信息。
                     MiniMax 无此标注，故只对 qoder 追加（两家共用这一个 Tooltip）。 */
                  return p.protocol === 'qoder' ? (
                    <>
                      {base}
                      <br />
                      Qoder 官方标注：每日 10:00（UTC+8）刷新，领取后 30 天有效。
                    </>
                  ) : base;
                })()}
              >
                {/* ⚠️ 这里**不能**翻 `disabled`：Tooltip 在被包裹元素 `disabled` 时
                    会改用一层 `<span class="tooltip-anchor">` 承载交互（原生 disabled
                    元素收不到 hover/focus），非禁用时则返回裸 trigger —— 于是
                    `disabled` 一变，Tooltip 的分支就变、两棵不同的树互换 = 整棵重挂。
                    点「已签到」时 busy 翻一次、刷新回来再翻一次，用户看到的就是"闪一下"。
                    改用 `aria-disabled`（Tooltip 不据它分支，树恒定）+ 守卫点击；
                    外观由 CSS 的 `.mini-pill[aria-disabled='true']` 表达。 */}
                {/* 禁用条件 = 忙碌 **或今天已签到** —— 已签到是终态，不该再发请求
                    （服务端幂等但没必要打这一枪）。用 `aria-disabled` 而非 `disabled`
                    的原因见上：Tooltip 对被包裹元素的 `disabled` 敏感，会换分支重挂。 */}
                <button
                  type="button"
                  className="mini-pill"
                  aria-disabled={busy || p.signin?.checkedOn === todayIso()}
                  onClick={() => {
                    if (busy || p.signin?.checkedOn === todayIso()) return;
                    onSignin(p);
                  }}
                >
                  <CalendarCheck size={12} />
                  {p.signin?.checkedOn === todayIso() ? '已签到' : '签到'}
                </button>
              </Tooltip>
            ) : null}
            {/* [v1.4.0] WorkBuddy 领取域（OAuth）：导入凭证 + 手动签到。
                [v1.4.4] 今日已跑过即禁用（服务端幂等但没必要白打 17 个任务接口）。
                [v1.4.5] 按钮改叫「签到」（用户口径）；任务面板移至设置页「提供商健康」。 */}
            {p.protocol === 'openai' ? (
              p.wbOAuth?.configured ? (
                <Tooltip
                  content={
                    p.wbSignin?.checkedOn === todayIso()
                      ? '今天已签到过（明天 08:05 自动跑；任务面板在设置 → 提供商健康）'
                      : '立即签到 + 顺带跑一轮成长任务与连登兑换（每天 08:05 也会自动跑）。转发不受影响。'
                  }
                >
                  <button
                    type='button'
                    className='mini-pill'
                    aria-disabled={busy || p.wbSignin?.checkedOn === todayIso()}
                    onClick={() => { if (!busy && p.wbSignin?.checkedOn !== todayIso()) onGrowthRun(p); }}
                  >
                    <CalendarCheck size={12} />
                    {p.wbSignin?.checkedOn === todayIso() ? '已签到' : '签到'}
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content={'导入桌面端 OAuth 凭证后可代领签到/任务（上游不允许 API 密钥代领）。粘贴 tools/wb-oauth-export.mjs 的输出；转发仍走 API 密钥。'}>
                  <button
                    type='button'
                    className='mini-pill'
                    aria-disabled={busy}
                    onClick={() => { if (!busy) onOauthImport(p); }}
                  >
                    <CalendarCheck size={12} />
                    导入OAuth
                  </button>
                </Tooltip>
              )
            ) : null}
            <Tooltip
              content={
                p.active
                  ? '不能删除已启用的提供商 —— 先停用它'
                  : rows.length <= 1
                  ? '至少保留一个提供商'
                  : '删除这个提供商（凭证文件一并删除）'
              }
            >
              <button
                type="button"
                className="mini-pill danger"
                aria-disabled={busy || p.active || rows.length <= 1}
                onClick={() => { if (!busy && !p.active && rows.length > 1) onDelete(p); }}
              >
                <Trash2 size={12} />
                删除
              </button>
            </Tooltip>
                    </RowMenu>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 「新增提供商」——放在表格卡片的右上角（与「密钥列表」的「新建API Key」同一位置规矩）。 */
export function AddProviderButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={onClick}>
      <Plus size={14} />
      新增提供商
    </button>
  );
}
