import type { RequestLogRow } from '../../types/api';
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
  providerOfModel,
}: {
  rows: RequestLogRow[];
  activeId: number | null;
  onOpen: (row: RequestLogRow) => void;
  resolveClientName: (row: RequestLogRow) => string;
  /** 按模型 ID 查计价标签（夜间折扣/限时免费等），由 RequestsPage 从模型目录建查表。 */
  modelTagOf: (modelId: string) => string | null;
  /**
   * [v0.5.13] 按模型 ID 解析**提供商**（模型目录归属）。
   * 密钥绑定名只是路由偏好，不能冒充提供商；requests 无 provider_id，
   * 目录归属是当前最诚实的口径 —— 查不到（模型已不在目录）回落到密钥归属客户端名。
   */
  providerOfModel: (modelId: string) => string | null;
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

                {/* 令牌：这把请求用的是哪把密钥（掩码；全量只在创建时显示一次） */}
                <td className="td-mono" style={{ color: 'var(--text-tertiary)' }}>
                  <Tooltip content={`密钥 ${r.keyHint}`} placement="below">
                    <span>{r.keyHint}</span>
                  </Tooltip>
                </td>

                {/* 模型 / 提供商：上模型名、下 [提供商药丸 ←→ 计价标签]（参考图的模型药丸样式）。
                    计价标签（夜间折扣等）与用量页「按模型消耗明细」同源 —— 「这条为什么便宜」
                    的答案在行级就要能看到，不该要去另一页对模型名。 */}
                <td>
                  <div className="td-strong">{uaName}</div>
                  <div className="model-meta">
                    {/* [v0.5.13] 提供商按**模型目录归属**解析 —— 绑定 WorkBuddy 的密钥请求
                        MiniMax 模型时实际走 MiniMax Code，旧显示（密钥归属名）把人引去查错家。
                        目录里已无该模型（如已删）才回落到密钥归属名。 */}
                    <Tooltip content={`提供商：${providerOfModel(r.model) ?? resolveClientName(r)}（按模型目录归属解析）`}>
                      <span className="prov-pill">
                        {providerOfModel(r.model) ?? resolveClientName(r)}
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
                    首字为 NULL（失败行 / 未收到任何 chunk）时显示「无首字」。 */}
                <td className="r td-mono">
                  <div>
                    <Tooltip content={'首字耗时 —— 从发出请求到收到第一个内容块的等待\n（含上游排队与思考时间；失败行没有首字）'}>
                      <span className="cell-sub">
                        {r.firstByteMs === null ? '无首字' : `首字 ${formatDuration(r.firstByteMs)}`}
                      </span>
                    </Tooltip>
                  </div>
                  <div>
                    <Tooltip content={'总耗时 —— 从发出请求到流结束'}>
                      <span>耗时 {formatDuration(r.ms)}</span>
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
