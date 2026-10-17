import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import { useResource } from '../../hooks/useResource';
import type { ClientKeyRow } from '../../types/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { errorDetail } from '../ui/StateBlock';
import { KeyPolicyFields, parsePolicyDraft, policyDraftFromRow, type KeyPolicyDraft } from './KeyPolicyFields';

/**
 * 修改密钥 —— **只改「叫什么」和「绑哪家」**。
 *
 * 为什么不能改权限范围（scope）：scope 是这把密钥的**授权面**，改它等于提权。
 * 服务端 `PATCH /api/keys/:id` 也不收 scope —— 要换范围，删了重建（明文只出一次，
 * 本来就该重新分发）。这里如实呈现这条边界，不给一个点了必然 400 的选项。
 *
 * 为什么「绑定客户端」可改、可解绑：绑定只影响**归因**（请求算到哪家名下），
 * 不改变权限。解绑（选「不绑定」）是合法操作，服务端用字段存在性区分
 * 「解绑」与「没传这个字段」。
 */
export function EditKeyModal({
  row,
  onClose,
  onSaved,
}: {
  row: ClientKeyRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row.name);
  /* [v0.4.20] 多选 + 优先级（有序数组，第 1 项最高）。空数组 = 不绑定。 */
  const [clientPicks, setClientPicks] = useState<string[]>(row.clients ?? (row.client ? [row.client] : []));
  /* [v0.4.35] 访问策略草稿：从现值预填（旧数据无这些字段时视同不限）。 */
  const [policy, setPolicy] = useState<KeyPolicyDraft>(() =>
    policyDraftFromRow({
      ipWhitelist: row.ipWhitelist ?? [],
      maxIps: row.maxIps ?? null,
      tokenQuota: row.tokenQuota ?? null,
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const providers = useResource(() => api.providers(), [], { cacheKey: 'providers' });

  /* 候选 = 已登记的提供商。当前绑定若不在候选里（该提供商已删），补一个占位项，
     避免它从列表消失、被静默解绑。
     [2026-10-17] value 改为提供商 **id**（唯一）——之前用名字，删除重建同名会错绑。
     旧数据里的名字值按原样显示（后端 resolveRoute 双匹配兜底）。 */
  const providerOptions = (() => {
    const opts = (providers.data?.items ?? [])
      .map((p) => ({ value: p.id, label: p.active ? `${p.name}（已启用）` : p.name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
    for (const picked of clientPicks) {
      if (!opts.some((o) => o.value === picked)) {
        /* 旧数据里的名字值 / 已删除的 id 都显示原值（诚实——用户看得到
           "这是个孤儿绑定"，不会被同名新提供商骗过去）。 */
        opts.push({ value: picked, label: `${picked}（已删除，当前不在列表）` });
      }
    }
    return opts;
  })();

  const toggleProvider = (name: string) =>
    setClientPicks((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  const moveProvider = (idx: number, dir: -1 | 1) =>
    setClientPicks((prev) => {
      const next = [...prev];
      const t = idx + dir;
      if (t < 0 || t >= next.length) return prev;
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });

  const trimmed = name.trim();
  const nameChanged = trimmed !== row.name;
  const origClients = row.clients ?? (row.client ? [row.client] : []);
  const clientsChanged = JSON.stringify(clientPicks) !== JSON.stringify(origClients);
  /* [v0.4.35] 策略草稿解析成可比较的形状（解析失败不算「有变更」—— 提交时再报错）。 */
  const parsedPolicy = parsePolicyDraft(policy);
  const policyChanged =
    !('error' in parsedPolicy) &&
    (JSON.stringify(parsedPolicy.ipWhitelist) !== JSON.stringify(row.ipWhitelist ?? []) ||
      parsedPolicy.maxIps !== (row.maxIps ?? null) ||
      parsedPolicy.tokenQuota !== (row.tokenQuota ?? null));
  const canSubmit = Boolean(trimmed) && (nameChanged || clientsChanged || policyChanged) && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if ('error' in parsedPolicy) {
      setError(new ApiError(parsedPolicy.error, 400, 0));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch: {
        name?: string;
        clients?: string[];
        ipWhitelist?: string[];
        maxIps?: number | null;
        tokenQuota?: number | null;
      } = {};
      if (nameChanged) patch.name = trimmed;
      if (clientsChanged) patch.clients = clientPicks;
      if (policyChanged) {
        patch.ipWhitelist = parsedPolicy.ipWhitelist;
        patch.maxIps = parsedPolicy.maxIps;
        patch.tokenQuota = parsedPolicy.tokenQuota;
      }
      await api.patchKey(row.id, patch);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="修改密钥"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="edit-key-form" className="btn btn-primary btn-sm" disabled={!canSubmit}>
            {busy ? <Loader2 size={14} /> : null}
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <p className="ov-sub">
        改的是「叫什么」和「绑哪家」，不动作废 —— 这把密钥的明文和哈希都不受影响，已接入的客户端无需更换。
      </p>
      <form id="edit-key-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="ov-field">
          <label htmlFor="ek-name">密钥名称</label>
          <input
            id="ek-name"
            className="field-input text"
            style={{ width: '100%' }}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <div className="ov-hint">当前：{row.name} · {row.hint}</div>
        </div>

        <div className="ov-field">
          <label>绑定提供商（可多选，可排序）</label>
          {providers.loading ? (
            <div className="ov-hint">正在读取提供商…</div>
          ) : providerOptions.length === 0 ? (
            <div className="ov-hint">还没有登记任何提供商 —— 先去「提供商管理」页登记。</div>
          ) : (
            <>
              <div className="pick-list">
                {providerOptions.map((p) => {
                  const picked = clientPicks.includes(p.value);
                  return (
                    <label className={`pick-row${picked ? ' on' : ''}`} key={p.value}>
                      <input type="checkbox" checked={picked} onChange={() => toggleProvider(p.value)} />
                      <span className="pick-name">{p.label}</span>
                    </label>
                  );
                })}
              </div>
              <div className="picked-head">
                <span>已选 {clientPicks.length} 个</span>
                {clientPicks.length > 1 ? <span className="picked-tip">用 ↑↓ 调整优先级</span> : null}
              </div>
              {clientPicks.length > 0 ? (
                <div className="picked-list">
                  {clientPicks.map((name, i) => (
                    <div className="picked-item" key={name}>
                      <span className="picked-rank">{i + 1}</span>
                      <span className="picked-name">{name}</span>
                      <span className="picked-actions">
                        <button type="button" className="pick-mv" disabled={i === 0} onClick={() => moveProvider(i, -1)} aria-label="上移">↑</button>
                        <button type="button" className="pick-mv" disabled={i === clientPicks.length - 1} onClick={() => moveProvider(i, 1)} aria-label="下移">↓</button>
                        <button type="button" className="pick-rm" onClick={() => toggleProvider(name)} aria-label="移除">×</button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="ov-hint">
                全部取消即解绑。绑定只影响用量归因（第 1 位是首选），不改变权限范围。
              </div>
            </>
          )}
        </div>

        {/* [v0.4.35] 访问控制可改（与授权面不同：这些是「谁/能用多少」的运营旋钮，
            收紧或放开都不改变密钥本身）。当前用量展示给「改多少」提供参照。 */}
        <KeyPolicyFields draft={policy} onChange={setPolicy} />
        {(row.maxIps !== null || row.tokenQuota !== null) && (
          <div className="ov-hint">
            当前累计：{row.maxIps !== null ? `${row.usedIps ?? 0} / ${row.maxIps} 个来源 IP` : ''}
            {row.maxIps !== null && row.tokenQuota !== null ? ' · ' : ''}
            {row.tokenQuota !== null ? `${(row.usedTokens ?? 0).toLocaleString()} / ${row.tokenQuota.toLocaleString()} tokens` : ''}
          </div>
        )}

        {/* [v0.4.37] 压成一行 —— 带标签的整块 + KeyPolicyFields 展开后弹窗会顶出视口。
            信息没少：还是「为什么不可改 + 怎么换」。 */}
        <div className="ov-hint">
          权限范围（<b>不可改</b>）：它是授权面，要换范围删除后重建 —— 明文只显示一次，本就该重新分发。
        </div>

        {error ? <Banner tone="error">{errorDetail(error)}</Banner> : null}
      </form>
    </Modal>
  );
}
