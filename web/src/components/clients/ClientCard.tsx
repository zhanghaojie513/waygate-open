import { AlertTriangle, Cable } from 'lucide-react';
import type { ClientRow } from '../../types/api';
import { Pill } from '../ui/Pill';
import { formatInt, formatCredits, formatRelative } from '../../lib/format';

/** 客户端卡的图标首字母：中文取首字，英文取两字母缩写。 */
function initials(name: string): string {
  // 判断是否全为 ASCII（英文名 → 缩写；中文名 → 取前两字）
  const isAscii = !/[^\u0020-\u007E]/.test(name);
  if (isAscii) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }
  return name.slice(0, 2);
}

function liveTone(lastSeenAt: string | null): 'live' | 'amber' | 'ghost' {
  if (!lastSeenAt) return 'ghost';
  const h = (Date.now() - new Date(lastSeenAt).getTime()) / 3_600_000;
  if (h < 1) return 'live';
  if (h < 24) return 'amber';
  return 'ghost';
}

export function ClientCard({ row, boundKeyHint }: { row: ClientRow; boundKeyHint: string | null }) {
  // 未识别客户端：整行横条，与普通卡明显区分（对应原型 .client-card.unid）
  if (!row.named) {
    return (
      <div className="card client-card unid">
        <div className="cc-ico" style={{ color: 'var(--warn-amber)' }}>
          <AlertTriangle size={16} />
        </div>
        <div className="nm">
          <b>{row.client}</b>
          <span>
            规则 4 · 兜底 · 最后出现 {formatRelative(row.lastSeenAt)} · 本窗口请求 {formatInt(row.requests)}
          </span>
        </div>
        <Pill tone="amber">待命名</Pill>
      </div>
    );
  }

  const tone = liveTone(row.lastSeenAt);
  const toneLabel = tone === 'live' ? '在线' : tone === 'amber' ? '待机' : '已停用';

  return (
    <div className="card client-card">
      <div className="cc-head">
        <div className="cc-ico" style={{ color: 'var(--brand-400)' }}>{initials(row.client)}</div>
        <div className="nm">
          <b>{row.client}</b>
          <span>
            {row.ruleLabel}
            {boundKeyHint ? ` · 密钥 ${boundKeyHint}` : ''}
          </span>
        </div>
        <Pill tone={tone === 'live' ? 'live' : tone === 'amber' ? 'amber' : 'ghost'}>{toneLabel}</Pill>
      </div>
      <div className="cc-rows">
        <div>
          <div className="k">本窗口请求</div>
          <div className="v">{formatInt(row.requests)}</div>
        </div>
        <div>
          <div className="k">本窗口积分</div>
          <div className="v">{formatCredits(row.credits)}</div>
        </div>
        <div>
          <div className="k">最常用模型</div>
          <div className="v code-chip">{row.models[0] ?? '—'}</div>
        </div>
        <div>
          <div className="k">最后活跃</div>
          <div className="v">{formatRelative(row.lastSeenAt)}</div>
        </div>
      </div>
    </div>
  );
}

export { Cable };
// @zbiti-ai:f:85:712fa675
