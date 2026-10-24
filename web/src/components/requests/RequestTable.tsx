import type { RequestLogRow } from '../../types/api';
import { providerColor } from '../../lib/providerColor';
import {
  Activity, ChevronRight, Clock, Coins, Cpu, Gauge, Gem, Globe, KeyRound, Timer,
} from 'lucide-react';
import { formatClock, formatDuration, formatInt, formatCredits, formatSpeed, noteLabels, outputSpeed, statusTone } from '../../lib/format';
import { ToolIcon } from './ToolIcon';
import { Tooltip } from '../ui/Tooltip';

const TONE_COLOR = {
  live: 'var(--text-tertiary)',
  warn: 'var(--warn-amber)',
  fatal: 'var(--danger-red)',
  muted: 'var(--text-faint)',
} as const;

/* 状态彩点：点携带语义色、数字保持中性 —— 比裸数字可扫读，又不像全彩数字那样满屏绿。 */
const TONE_DOT = {
  live: 'var(--signal-live)',
  warn: 'var(--warn-amber)',
  fatal: 'var(--danger-red)',
  muted: 'var(--text-faint)',
} as const;

function uaHeadAlreadyNames(ua: string | null, tool: string): boolean {
  if (!ua) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const head = norm((ua.trim().split(/[\s/]/)[0] ?? ''));
  if (!head) return false;
  return tool
    .split(/[\s.\-_/]+/)
    .map(norm)
    .filter((w) => w.length >= 3)
    .some((w) => head.includes(w));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleDateString('zh-CN');
}

/**
 * 请求日志表 —— [v0.4.10 参考图重构] 8 列（+行首箭头）。
 *
 * ## 列的合并与拆分（2026-10-10 用户要求，参考 Vercel 风格请求日志）
 *   · 时间 → 上下两行：上年月日、下时间（原来是只有时分秒的单行）
 *   · 新增「令牌」列：这把请求用的是哪把密钥（keyHint，掩码）
 *   · 模型 + 提供商 → 合成一列上下展示：上模型名、下提供商量色药丸
 *   · tokens → 上下：上 in/out、下缓存命中量（原来是一行 + 后缀）
 *   · 标记列删除：note 信息并入状态列的悬停提示 —— 行的彩色底与状态点已携带
 *     视觉信号，独立列是冗余的（致命行的 note 仍在状态格 tooltip 里可读）。
 *   · 表头每列配小图标（lucide 12px），行 hover 加左侧品牌竖条。
 */
export function RequestTable({
  rows,
  activeId,
  onOpen,
  resolveClientName,
  modelTagOf,
  providerOf,
}: {
  rows: RequestLogRow[];
  activeId: number | null;
  onOpen: (row: RequestLogRow) => void;
  resolveClientName: (row: RequestLogRow) => string;
  /** 按模型 ID 查计价标签（夜间折扣/限时免费等），由 RequestsPage 从模型目录建查表。 */
  modelTagOf: (modelId: string) => string | null;
  /**
   * [v1.6.33] 逐行解析**提供商**：优先读事实列 `providerId`（本请求实际路由到哪家），
   * 迁移前的老行才回落到「模型目录反解」，再不行由调用方回落到密钥归属名。
   *
   * ⚠️ 不能只按模型目录反解：同名模型（M3.1-Flash 同时在 MiniMax Code 与 Code2 的
   * 目录里）反解只能取到一家，另一家的流量会被显示成错的（用户实测报障）。
   */
  providerOf: (row: { providerId?: string | null; model: string }) => string | null;
}) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <caption className="sr-only">请求日志，共 {rows.length} 条当前筛选结果</caption>
        <thead>
          <tr>
            <th aria-hidden="true"></th>
            <th scope="col"><Clock size={12} />请求时间</th>
            <th scope="col"><KeyRound size={12} />令牌</th>
            <th scope="col"><Cpu size={12} />模型 / 提供商</th>
            <th scope="col"><Globe size={12} />User Agent</th>
            <th scope="col" className="r"><Activity size={12} />状态</th>
            <th scope="col" className="r"><Timer size={12} />耗时</th>
            {/* [v1.6.8] 输出速度：输出 tokens ÷ 生成时长（总耗时 − 首字）。 */}
            <th scope="col" className="r"><Gauge size={12} />输出速度</th>
            <th scope="col" className="r"><Coins size={12} />Tokens</th>
            <th scope="col" className="r"><Gem size={12} />积分</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = statusTone(r.status, r.note);
            const notes = noteLabels(r.note);
            const uaName = r.modelDisplay || r.model;
            /* [v1.7.2] 我方开销需要两段都测到才算得出（只知其一就把另一半当 0 会低估）；
               缺一段 → null → 显示 `--`（未知），不是 0。 */
            const selfMs = r.authMs !== null && r.prepMs !== null ? r.authMs + r.prepMs : null;
            return (
              <tr
                key={r.id}
                onClick={() => onOpen(r)}
                className={activeId === r.id ? 'row-on' : undefined}
                style={{
                  cursor: 'pointer',
                  background:
                    activeId === r.id
                      ? 'var(--brand-tint)'
                      : tone === 'fatal'
                        ? 'color-mix(in srgb, var(--danger-red) 5%, transparent)'
                        : undefined,
                }}
              >
                <td className="row-x-td">
                  <button
                    type="button"
                    className="row-open"
                    aria-label={`打开 ${formatDate(r.ts)} ${formatClock(r.ts)} 的请求详情`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(r);
                    }}
                  >
                    <ChevronRight size={14} className="row-x" aria-hidden="true" />
                  </button>
                </td>

                {/* 时间：上年月日、下时间 —— 参考图的双行结构 */}
                <td>
                  <div className="cell-date">{formatDate(r.ts)}</div>
                  <div className="td-mono" style={{ color: 'var(--text-ghost)' }}>{formatClock(r.ts)}</div>
                </td>

                {/* 令牌：这把请求用的是哪把密钥（掩码；全量只在创建时显示一次）。
                    不加 tooltip —— 列里显示的就是掩码，悬停再给一遍同样的字符串
                    没有任何新信息，只是多一次浮层。 */}
                <td className="td-mono" style={{ color: 'var(--text-tertiary)' }}>
                  {r.keyHint}
                </td>

                {/* 模型 / 提供商：上模型名、下 [提供商药丸 ←→ 计价标签]（参考图的模型药丸样式）。
                    计价标签（夜间折扣等）与用量页「按模型消耗明细」同源 —— 「这条为什么便宜」
                    的答案在行级就要能看到，不该要去另一页对模型名。 */}
                <td>
                  <div className="td-strong">{uaName}</div>
                  <div className="model-meta">
                    {/* [v0.5.13] 提供商不能显示成密钥绑定名 —— 绑定 WorkBuddy 的密钥请求
                        MiniMax 模型时实际走 MiniMax Code，旧显示会把人引去查错家。
                        [v1.6.33] 改为**优先读事实列** `requests.providerId`（实际路由到哪家）。
                        旧实现只按模型目录反解，同名模型（M3.1-Flash 同时在 Code / Code2）
                        永远只能显示一家，Code2 的流量被显示成 Code（用户实测报障）。
                        目录里已无该模型（老行/已删）才回落到目录反解，再不行才用密钥名。 */}
                    <Tooltip
                      content={`提供商：${providerOf(r) ?? resolveClientName(r)}（按本请求实际路由记录）`}
                    >
                      <span className="prov-pill">
                        {/* [v5] 身份色点：同一家提供商在「提供商管理」表里也是这个颜色。
                            这里按**名字**哈希（providerOf 返回名字不是 id）——
                            两处 key 不同源，所以只保证「同一页面内一致」，
                            不保证跨页逐字节相同。要严格一致需要 RequestLogRow
                            带上 providerId（后端字段），那是另一件事。 */}
                        <i
                          className="prov-dot"
                          style={{ background: providerColor(providerOf(r) ?? resolveClientName(r)) }}
                          aria-hidden="true"
                        />
                        {providerOf(r) ?? resolveClientName(r)}
                      </span>
                    </Tooltip>
                    {modelTagOf(r.model) ? <span className="mu-tag">{modelTagOf(r.model)}</span> : null}
                  </div>
                </td>

                {/* UA：图标只在第一行（原文行），第二行（判定结果）纯文字。 */}
                <td className="td-ua">
                  {r.ua ? (
                    <Tooltip content={r.ua}>
                      <span style={{ display: 'block' }}>
                        <span className="ua-raw">
                          <ToolIcon tool={r.tool} size={14} style={{ marginRight: 5, verticalAlign: -2 }} />
                          {r.ua}
                        </span>
                        {r.tool && !uaHeadAlreadyNames(r.ua, r.tool) ? (
                          <div className="ua-tool">{r.tool}</div>
                        ) : r.tool ? null : (
                          <div className="ua-tool">
                            <span style={{ color: 'var(--text-ghost)' }}>未识别</span>
                          </div>
                        )}
                      </span>
                    </Tooltip>
                  ) : (
                    <>
                      <span className="ua-raw" style={{ color: 'var(--text-ghost)' }}>未采集</span>
                      {r.tool ? (
                        <div className="ua-tool">{r.tool}</div>
                      ) : (
                        <div className="ua-tool">
                          <span style={{ color: 'var(--text-ghost)' }}>未识别</span>
                        </div>
                      )}
                    </>
                  )}
                </td>

                {/* 状态：彩点 + 数字；note 并入悬停提示（标记列已删除） */}
                <td className="r td-mono" style={{ color: TONE_COLOR[tone] }}>
                  {notes.length > 0 ? (
                    <Tooltip content={notes.join(' · ')}>
                      <span>
                        <span className="dotc" style={{ background: TONE_DOT[tone] }} aria-hidden="true" />
                        {r.status}
                      </span>
                    </Tooltip>
                  ) : (
                    <>
                      <span className="dotc" style={{ background: TONE_DOT[tone] }} aria-hidden="true" />
                      {r.status}
                    </>
                  )}
                </td>

                {/* [v1.6.8] 耗时改两行（首字 / 耗时），与「请求详情」的三段口径一致；
                    首字为 NULL（失败行 / 未收到任何 chunk）时显示「无首字」。
                    [v1.7.2] 第二行「耗时」后面追一个「我方」—— 表已有 10 列，再开一列
                    会挤压「模型 / 提供商」；而「我方开销」与总耗时是同一件事的两面，
                    放一起扫读最快。null = 未知（老行/失败行），显示 `--` 而不是 0。 */}
                <td className="r td-mono">
                  <div>
                    <Tooltip content={'首字耗时 —— 从鉴权完成到收到第一个内容块的等待\n（含本网关的路由/凭证处理，以及上游排队与思考时间；不含鉴权本身；失败行没有首字）'}>
                      <span className="cell-sub">
                        {r.firstByteMs === null ? '无首字' : `首字 ${formatDuration(r.firstByteMs)}`}
                      </span>
                    </Tooltip>
                  </div>
                  <div>
                    <Tooltip content={'总耗时 —— 从鉴权完成到流结束（不含客户端上传 body 的时间）'}> 
                      <span>耗时 {formatDuration(r.ms)}</span>
                    </Tooltip>
                  </div>
                  <div>
                    <Tooltip
                      content={
                        r.authMs === null || r.prepMs === null
                          ? '我方开销 —— 本行没测到（迁移前的老行或失败行），显示 -- 而不是 0'
                          : `我方开销 = 鉴权 ${formatDuration(r.authMs)} + 准备 ${formatDuration(r.prepMs)}\n（准备段含路由解析与凭证获取；WorkBuddy token 刷新也在这一段）`
                      }
                    >
                      <span className={selfMs !== null && selfMs >= 50 ? 'cell-sub timing-warn' : 'cell-sub'}>
                        {selfMs === null ? '我方 --' : `我方 ${formatDuration(selfMs)}`}
                      </span>
                    </Tooltip>
                  </div>
                </td>

                {/* [v1.6.8] 输出速度 = 输出 tokens ÷ 生成时长（总耗时 − 首字）。
                    上游不回报生成时长，此值由本服务按两端观测推算；
                    取不到（失败行 / 首字即结束）显示 --，绝不显示 0。 */}
                <td className="r td-mono">
                  <Tooltip
                    content={
                      '输出速度 = 输出 tokens ÷ 生成时长（总耗时 − 首字）\n'
                      + '上游不回报生成时长，此值由本服务按两端观测推算；\n'
                      + '失败行或首字即结束的请求没有生成过程，显示 --'
                    }
                  >
                    <span>{formatSpeed(outputSpeed(r.completionTokens, r.ms, r.firstByteMs))}</span>
                  </Tooltip>
                </td>

                {/* tokens：上 in/out、下缓存命中。两行各有 tooltip。 */}
                <td className="r td-mono">
                  <div>
                    <Tooltip content={`输入 ${formatInt(r.promptTokens)} tokens / 输出 ${formatInt(r.completionTokens)} tokens`}>
                      <span>{formatInt(r.promptTokens)}/{formatInt(r.completionTokens)}</span>
                    </Tooltip>
                  </div>
                  {r.cachedTokens > 0 ? (
                    <div>
                      <Tooltip content={`输入中命中缓存 ${formatInt(r.cachedTokens)} tokens\n上游按缓存价计费（已体现在积分里）`}>
                        <span className="cell-cached">+{formatInt(r.cachedTokens)}</span>
                      </Tooltip>
                    </div>
                  ) : null}
                </td>

                {/* [v0.5.8] credits 可空：null = 上游未回报该次费用（未知）。
                    formatCredits 渲染成 `--`（不是 0），并说明为什么 —— 否则用户会
                    把「不知道」读成「没花钱」。 */}
                <td className="r td-mono">
                  {r.credits === null ? (
                    <Tooltip content={'上游未回报该次费用（未知）\n本服务不估算 —— 账户级真实消耗见概览「积分账本」'}>
                      <span>{formatCredits(r.credits)}</span>
                    </Tooltip>
                  ) : (
                    formatCredits(r.credits)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
// @zbiti-ai:f:175:5e2ea0d3
