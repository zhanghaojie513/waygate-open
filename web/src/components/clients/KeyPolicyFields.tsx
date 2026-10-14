/**
 * [v0.4.35] 密钥访问策略表单（新建 / 编辑弹窗共用）。
 * [v0.4.37] 改为**可折叠**：三个旋钮 + 说明加起来 ~200px，编辑弹窗被顶出视口。
 *   收起时只占一行并显示摘要（已设什么/未限制）；已设限额的密钥（编辑场景）
 *   默认展开 —— 要改的东西必须一眼可见，不能藏在折叠里。
 *
 * 三个旋钮（全部可留空 = 不限制，与旧行为一致）：
 *   · IP 白名单 —— 多行输入，每行一个条目（IPv4 / IPv6 / IPv4 CIDR）；
 *   · 最大 IP 数 —— 这把密钥历史上最多允许几个不同来源 IP（防转传播）；
 *   · Token 配额 —— 累计 tokens 上限（软校验：最后一笔可超出）。
 *
 * 校验与服务端 `keys.parsing.ts` / `common/ip-policy.ts` 同规则，前端先挡一道，
 * 用户不必先吃一次 400 才知道哪条写错。
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

export interface KeyPolicyDraft {
  /** 多行文本，每行一个白名单条目（原样保留用户输入，提交时才解析）。 */
  ipText: string;
  /** 最大 IP 数（字符串态，空 = 不限）。 */
  maxIps: string;
  /** Token 配额（字符串态，空 = 不限）。 */
  tokenQuota: string;
}

export const EMPTY_POLICY: KeyPolicyDraft = { ipText: '', maxIps: '', tokenQuota: '' };

export function policyDraftFromRow(row: {
  ipWhitelist: string[];
  maxIps: number | null;
  tokenQuota: number | null;
}): KeyPolicyDraft {
  return {
    ipText: row.ipWhitelist.join('\n'),
    maxIps: row.maxIps === null ? '' : String(row.maxIps),
    tokenQuota: row.tokenQuota === null ? '' : String(row.tokenQuota),
  };
}

/** 草稿里是否设了任何限制（决定折叠态摘要与编辑弹窗的默认展开）。 */
export function policyDraftHasAny(d: KeyPolicyDraft): boolean {
  return d.ipText.trim() !== '' || d.maxIps.trim() !== '' || d.tokenQuota.trim() !== '';
}

/** 与服务端 normalizeIpEntry 同规则的本地校验；不合法返回错误文案。 */
function ipEntryError(entry: string): string | null {
  const s = entry.trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash > 0) {
    const base = s.slice(0, slash);
    const prefix = s.slice(slash + 1);
    if (!/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) return `「${s}」的掩码位数只能是 0-32`;
    if (!isIpv4(base)) return `「${s}」CIDR 只支持 IPv4 网段`;
    return null;
  }
  if (isIpv4(s) || (s.includes(':') && /^[0-9a-fA-F:]+$/.test(s))) return null;
  return `「${s}」不是合法的 IP 地址（支持 IPv4、IPv6、IPv4 CIDR）`;
}

function isIpv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export interface ParsedPolicy {
  ipWhitelist: string[];
  maxIps: number | null;
  tokenQuota: number | null;
}

/** 解析草稿；任何一项不合法返回 { error }（错误直接可展示）。 */
export function parsePolicyDraft(d: KeyPolicyDraft): ParsedPolicy | { error: string } {
  const ipWhitelist = d.ipText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const entry of ipWhitelist) {
    const err = ipEntryError(entry);
    if (err) return { error: `IP 白名单：${err}` };
  }
  let maxIps: number | null = null;
  if (d.maxIps.trim() !== '') {
    maxIps = Number(d.maxIps);
    if (!Number.isInteger(maxIps) || maxIps < 1) return { error: '最大 IP 数必须是正整数（留空 = 不限）。' };
  }
  let tokenQuota: number | null = null;
  if (d.tokenQuota.trim() !== '') {
    tokenQuota = Number(d.tokenQuota);
    if (!Number.isInteger(tokenQuota) || tokenQuota < 1) return { error: 'Token 配额必须是正整数（留空 = 不限）。' };
  }
  return { ipWhitelist, maxIps, tokenQuota };
}

/** 折叠态的一行摘要：设了什么，一目了然。 */
function summaryOf(d: KeyPolicyDraft): string {
  const parts: string[] = [];
  const wl = d.ipText.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s !== '').length;
  if (wl > 0) parts.push(`白名单 ${wl} 条`);
  if (d.maxIps.trim() !== '') parts.push(`最大 ${d.maxIps.trim()} IP`);
  if (d.tokenQuota.trim() !== '') parts.push(`配额 ${Number(d.tokenQuota).toLocaleString()} tok`);
  return parts.length > 0 ? parts.join(' · ') : '未限制';
}

export function KeyPolicyFields({
  draft,
  onChange,
  defaultOpen = false,
}: {
  draft: KeyPolicyDraft;
  onChange: (next: KeyPolicyDraft) => void;
  /** 编辑已设限额的密钥时传 true —— 要改的东西不能藏在折叠里。 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || policyDraftHasAny(draft));
  return (
    <div className="ov-field">
      <button
        type="button"
        className="policy-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={14} aria-hidden />
        <span>访问控制{open ? '' : '（可选，留空 = 不限）'}</span>
        {!open ? <span className="policy-sum">{summaryOf(draft)}</span> : null}
      </button>
      {open ? (
        <>
          <textarea
            className="field-input text"
            style={{ width: '100%', minHeight: 48, resize: 'vertical', fontFamily: 'var(--font-mono)', marginTop: 8 }}
            value={draft.ipText}
            placeholder={'IP 白名单，每行一个：\n203.0.113.7\n10.0.0.0/8'}
            onChange={(e) => onChange({ ...draft, ipText: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="ov-hint">最大 IP 数（留空 = 不限）</span>
              <input
                className="field-input text"
                style={{ width: '100%' }}
                type="number"
                min={1}
                value={draft.maxIps}
                placeholder="如 3"
                onChange={(e) => onChange({ ...draft, maxIps: e.target.value })}
              />
            </label>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="ov-hint">Token 配额（留空 = 不限）</span>
              <input
                className="field-input text"
                style={{ width: '100%' }}
                type="number"
                min={1}
                value={draft.tokenQuota}
                placeholder="如 1000000"
                onChange={(e) => onChange({ ...draft, tokenQuota: e.target.value })}
              />
            </label>
          </div>
          <div className="ov-hint" style={{ marginTop: 6 }}>
            白名单只放行名单内来源；最大 IP 数挡密钥转播后的<b>新增</b>来源；配额按累计 tokens 软校验（最后一笔可超出）。
          </div>
        </>
      ) : null}
    </div>
  );
}
