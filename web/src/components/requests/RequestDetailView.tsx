import { ChevronDown, ChevronUp, ListTree } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import type { RequestDetail, RequestLogRow } from '../../types/api';
import { formatDateTime, formatDuration, formatInt, formatCredits, noteLabel, noteLabels, upstreamHint, statusTone } from '../../lib/format';

const TONE_COLOR = {
  live: 'var(--signal-live)',
  warn: 'var(--warn-amber)',
  fatal: 'var(--danger-red)',
  muted: 'var(--text-faint)',
} as const;

/** 识别规则的人话名（`clients.service.ts` 的 RULE_LABELS 是**同一个**映射，
 *  那边给客户端列表用，这边给单条请求用 —— 两处必须逐字一致）。 */
const RULE_LABEL: Record<number, string> = {
  1: '显式声明',
  2: '密钥归属',
  3: 'User-Agent',
  4: '未识别',
};

/**
 * 请求详情面板：耗时三段、tokens、积分、上游响应、错误码提示。
 * reasoning_content 折叠展示（默认收起，避免长思考链淹没正文）。
 * 复用原型「429 / 401 切换」的思路，但这里允许切换的是任意行。
 */
export function RequestDetailView({
  row,
  reasoningOpen,
  onToggleReasoning,
  resolveClientName,
  modelTagOf,
  providerOf,
}: {
  row: RequestDetail;
  reasoningOpen: boolean;
  onToggleReasoning: () => void;
  /** 快照名 → 当前显示名（§9.2）。与日志表同一份解析，避免「同一行两个名字」。 */
  resolveClientName: (row: RequestLogRow) => string;
  /** [v1.6.32] 逐行提供商：优先事实列 `providerId`，回落目录反解。 */
  providerOf: (row: { providerId?: string | null; model: string }) => string | null;
  /** 按模型 ID 查计价标签（夜间折扣/限时免费等），与日志表同源 —— 详情里也要能看到
   *  「这条为什么便宜」，不该要回表格里对。 */
  modelTagOf: (modelId: string) => string | null;
}) {
  const upstream = row.ms - row.queuedMs;
  const hint = upstreamHint(row);
  const tone = statusTone(row.status, row.note);
  const reasoning = row.assistantPreview ?? '';

  /*
   * 「排队」这一段只在**真的排过队**时才有意义。
   *
   * `queued_ms` 在本版恒为 0 —— 并发闸是「超限直接 429、不排队」
   * （schema.sql 该列注释 + proxy-log.ts 写入侧硬编码 0）。原来无条件显示
   * 「排队 0ms」，读起来是「排队很快」，实际是「这个功能不存在」：
   * 它不骗数值，却占着一个位置让人以为有信息。所以非零才显示，
   * 否则如实说明不排队（排在 429 那一档）。
   */
  const queued = row.queuedMs > 0;

  return (
    <div className="drawer-body">
      <div className="detail-row">
        <span className="k">时间</span>
        <span className="v">{formatDateTime(row.ts)}</span>
      </div>
      <div className="detail-row">
        <span className="k">提供商</span>
        <span className="v">
          {/* [v0.5.13] 不能显示成密钥绑定名（那只是路由偏好）。
              [v1.6.32] 优先读**事实列** `providerId`（本请求实际路由到哪家）——
              按模型目录反解在同名模型上必然歧义（M3.1-Flash 同时在 Code / Code2）。
              老行（迁移前没有该列）才回落到目录反解，再不行用密钥归属名。 */}
          {providerOf(row) ?? resolveClientName(row)}
          {/* 这一栏是「哪把密钥进来的」，与下一栏的「工具」是两个问题 —— 显式标出规则，
              用户才不会把两者当成同一件事。 */}
          <span className="code-chip" style={{ marginLeft: 8 }}>
            {RULE_LABEL[row.clientRule] ?? `规则 ${row.clientRule}`}
          </span>
        </span>
      </div>
      {/* [2026-10-08] 「工具」= 从 UA 解析出的客户端软件名，回答「这条是哪个工具发的」。
          `tool === null` 时**不编造**，如实说认不出来并给出原文 —— 原文才是可行动的信息
          （能据此决定往关键词表里加什么）。 */}
      <div className="detail-row">
        <span className="k">工具</span>
        <span className="v">
          {row.tool ? (
            row.tool
          ) : (
            <>
              <span style={{ color: 'var(--text-faint)' }}>未识别</span>
              {row.ua ? <span className="code-chip" style={{ marginLeft: 8 }}>{row.ua}</span> : null}
            </>
          )}
        </span>
      </div>
      {row.tool && row.ua ? (
        <div className="detail-row">
          <span className="k">User-Agent</span>
                <Tooltip content={row.ua}>
                  <span className="v">{row.ua}</span>
                </Tooltip>
        </div>
      ) : null}
      {row.remoteIp ? (
        <div className="detail-row">
          <span className="k">来源 IP</span>
          <span className="v">{row.remoteIp}</span>
        </div>
      ) : null}
      <div className="detail-row">
        <span className="k">密钥</span>
        <span className="v">{row.keyHint}</span>
      </div>
      {/* 模型名 + 模型 ID + 计价标签：名字是给人认的、ID 是给 API 调用的（配 base_url 时要填的就是它），
          两者并存才不用去目录里对。ID 用 code-chip 区分，避免和名字连成一串读不出边界。 */}
      <div className="detail-row">
        <span className="k">模型</span>
        <span className="v">
          {row.modelDisplay || row.model}
          {row.modelDisplay && row.modelDisplay !== row.model ? (
            <span className="code-chip" style={{ marginLeft: 8 }}>{row.model}</span>
          ) : null}
          {modelTagOf(row.model) ? <span className="mu-tag">{modelTagOf(row.model)}</span> : null}
        </span>
      </div>
      <div className="detail-row">
        <span className="k">状态</span>
        <span className="v" style={{ color: TONE_COLOR[tone] }}>
          {row.status}{' '}
          {/* [A1] note 的全部标记逐条展示（表格里只露前两个 +N） */}
          {noteLabels(row.note).length > 0 ? (
            noteLabels(row.note).map((label, i) => (
              <span key={i} className="code-chip" style={{ marginRight: 4 }}>
                {label}
              </span>
            ))
          ) : (
            <span className="code-chip">-</span>
          )}
        </span>
      </div>
      <div className="detail-row">
        <span className="k">耗时</span>
        <span className="v">
          {queued ? `排队 ${formatDuration(row.queuedMs)} · ` : '不排队（并发超限直接 429） · '}
          上游 {formatDuration(upstream)} ·{' '}
          {row.firstByteMs === null ? '无首字' : `首字 ${formatDuration(row.firstByteMs)}`}
        </span>
      </div>
      <div className="detail-row">
        <span className="k">tokens</span>
        <span className="v">
          {formatInt(row.promptTokens)} in / {formatInt(row.completionTokens)} out
          {/* [v0.2.0 A2] 输出里含思考 tokens（上游计费口径），拆开展示才可解释
              「这条为什么这么贵/这么慢」。旧行与未回报思考数的请求为 0，不显示后缀。 */}
          {row.reasoningTokens > 0 ? (
            <>
              {' '}
              <Tooltip content="输出中属于思考（reasoning）的部分，已计入 out">
                <span className="code-chip">思考 {formatInt(row.reasoningTokens)}</span>
              </Tooltip>
            </>
          ) : null}
          {/* [2026-10-08] 命中缓存的输入 tokens：这是「这条为什么便宜」的答案。
              [v0.5.8] 折扣系数不再由本服务设定（上游 credit 已含折扣）—— 本 chip 只陈述
              「命中多少」，不承诺任何计价系数（旧文案里的 quota.cacheDiscount 已删除）。
              为 0 时不显示 —— 0 是「没命中」，不是「未提供」，不需要占位。 */}
          {row.cachedTokens > 0 ? (
            <>
              {' '}
                <Tooltip content="输入中命中缓存的部分（上游按缓存价计费，已体现在实扣积分里）—— 这是这条便宜的来源">
                  <span className="code-chip">缓存 {formatInt(row.cachedTokens)}</span>
                </Tooltip>
            </>
          ) : null}
        </span>
      </div>
      <div className="detail-row">
        <span className="k">消耗积分</span>
        <span className="v">{formatCredits(row.credits)}</span>
      </div>
      <div className="detail-row">
        <span className="k">流式 / 重试</span>
        <span className="v">{row.stream ? 'SSE' : '非流式'} · 重试 {row.retryCount} 次</span>
      </div>
      <div className="detail-row">
        <span className="k">请求 ID</span>
        <span className="v">req_{row.id.toString(16)}</span>
      </div>

      {hint ? (
        <div className="dnote" style={{ marginTop: 14 }}>{hint}</div>
      ) : null}

      <div className="drawer-sec">
        <h4>上游响应</h4>
        <div className={`upstream${tone === 'fatal' ? ' fatal' : ''}`}>
          {row.assistantPreview
            ? `HTTP ${row.status}\nnote: ${row.note}\nupstream: ${row.modelDisplay}`
            : `HTTP ${row.status}\nnote: ${row.note}\n上游未返回内容（${noteLabel(row.note)}）`}
        </div>
      </div>

      {reasoning ? (
        <div className="drawer-sec">
          <h4>应答预览</h4>
          <div className="reason-box">
            <button type="button" onClick={onToggleReasoning} aria-expanded={reasoningOpen}>
              <ListTree size={14} />
              <span style={{ flex: 1 }}>
                {reasoningOpen ? '收起推理内容（reasoning_content）' : '展开推理内容（reasoning_content）'}
              </span>
              {reasoningOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {reasoningOpen ? <div className="rz-body">{reasoning}</div> : null}
          </div>
        </div>
      ) : null}

      <div className="drawer-sec">
        <h4>请求消息</h4>
        {row.messages.length === 0 ? (
          <div className="empty-note">该请求未记录消息体（logs.recordRequestBody 关闭）。</div>
        ) : (
          <div className="msg-list">
            {row.messages.map((m, i) => (
              <div className="msg" key={`${m.role}-${i}`}>
                <div className="role">{m.role}</div>
                <div className="content">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
// @zbiti-ai:f:222:36cad573
