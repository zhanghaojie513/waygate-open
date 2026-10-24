import { useEffect, useMemo, useState } from 'react';
import { CalendarX, CircleCheck, CircleMinus, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { api } from '../services/api';
import { ApiError } from '../services/http';
import { useResource } from '../hooks/useResource';
import type { ClientKeyRow } from '../types/api';
import { Topbar } from '../components/ui/Topbar';
import { Banner } from '../components/ui/Banner';
import { Pill } from '../components/ui/Pill';
import { Panel, KpiRow, KpiTile } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { Modal } from '../components/ui/Modal';
import { KeyTable } from '../components/clients/KeyTable';
import { KeysSkeleton } from '../components/ui/PageSkeleton';
import { CreateKeyModal } from '../components/clients/CreateKeyModal';
import { EditKeyModal } from '../components/clients/EditKeyModal';
import { formatInt } from '../lib/format';
import { keyState } from '../lib/console';

function selectedClientId(): string | null {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('clientId') || null;
}

export function ApiKeysPage() {
  const keys = useResource(() => api.keys(), [], { cacheKey: 'keys' });
  const clients = useResource(() => api.clients('30d'), [], { cacheKey: 'clients:30d' });
  /* [2026-10-17] 绑定列解析：密钥的 clients 值是提供商 id（新）/名字（旧），需要 id→名字映射。 */
  const providers = useResource(() => api.providers(), [], { cacheKey: 'providers' });
  const providerNameById = new Map((providers.data?.items ?? []).map((p) => [p.id, p.name]));
  const [clientId, setClientId] = useState(selectedClientId);
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientKeyRow | null>(null);
  const [deleting, setDeleting] = useState<ClientKeyRow | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  useEffect(() => {
    const sync = () => setClientId(selectedClientId());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const clientByKey = useMemo(() => {
    const mapping = new Map<string, { clientId: string; name: string }>();
    for (const c of clients.data?.items ?? []) {
      const client = { clientId: c.clientId, name: c.client };
      // Rule-2 client IDs are key IDs; other clients expose their bound key IDs.
      mapping.set(c.clientId, client);
      for (const keyId of c.boundKeyIds) mapping.set(keyId, client);
    }
    return mapping;
  }, [clients.data]);

  const selectedClient = clients.data?.items.find((c) => c.clientId === clientId);
  const allRows = keys.data ?? [];
  const rows = clientId
    ? allRows.filter((k) => k.id === clientId || selectedClient?.boundKeyIds.includes(k.id))
    : allRows;
  const filterLoading = Boolean(clientId && clients.initial && clients.loading);
  const summary = { total: rows.length, live: 0, off: 0, exp: 0 };
  for (const k of rows) summary[keyState(k.enabled, k.expiresAt)] += 1;
  const count = (value: number) => keys.data && !filterLoading ? formatInt(value) : '--';

  const reload = () => {
    keys.reload();
    clients.reload();
  };

  const toggleKey = async (row: ClientKeyRow) => {
    if (pendingId) return;
    setPendingId(row.id);
    setActionError(null);
    try {
      await api.patchKey(row.id, { enabled: !row.enabled });
      keys.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setPendingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || pendingId) return;
    const target = deleting;
    setPendingId(target.id);
    setActionError(null);
    try {
      await api.deleteKey(target.id);
      setDeleting(null);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
      setDeleting(null);
    } finally {
      setPendingId(null);
    }
  };

  const clearFilter = () => {
    window.location.hash = '#/keys';
    setClientId(null);
  };

  return (
    <div className="view on">
      <Topbar
        title="API 密钥"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={14} />
            新建API Key
          </button>
        }
      />
      <div className="view-body stack">
        {/* [v0.6.5] 首次加载：整页骨架（统计条 + 密钥表）—— 此前用文字卡「正在读取密钥…」，
            且顶部统计条显示一排 0。现在与最终布局同形状，出数据后原位替换。 */}
        {keys.initial && keys.loading ? (
          <KeysSkeleton />
        ) : (
          <>
        {actionError ? (
          <Banner tone="error">{errorDetail(actionError)}</Banner>
        ) : null}

        {/* [v7.0-d] 三行卡片：标签 → 数字 → 口径。
            第三行说明这一格**按什么规则**算出来的 —— 尤其是「过期」：
            keyState 里过期优先于启停判断（expiresAt 已过就算过期，不看 enabled），
            所以这三格是互斥的，不能相加当总数用。
            口径写在标签同行右端 —— 必须写**短**，超过约 150px 会被截成「…」。 */}
        {/* [v5] 读数行 → 卡片，与概览/用量/请求日志三页统一。
            四格互斥（过期优先于启停判断），不能相加当总数用 —— 所以首卡
            「密钥总数」独立成组，后三格各自标注自己的判定规则。 */}
        <KpiRow count={4}>
          <KpiTile
            lead
            label="密钥总数"
            value={count(summary.total)}
            icon={<KeyRound size={14} />}
            sub={clientId ? `客户端筛选下 ${count(summary.total)} 把` : '全部密钥'}
          />
          <KpiTile
            label="启用"
            value={<span className="live">{count(summary.live)}</span>}
            icon={<CircleCheck size={14} />}
            sub="未过期且启用"
          />
          <KpiTile
            label="停用"
            value={count(summary.off)}
            icon={<CircleMinus size={14} />}
            sub="已停用且未过期"
          />
          <KpiTile
            label="过期"
            value={summary.exp > 0 ? <span className="warn">{count(summary.exp)}</span> : count(summary.exp)}
            icon={<CalendarX size={14} />}
            sub="expiresAt 已过"
          />
        </KpiRow>

        {clientId ? (
          <div className="note">
            <span>
              关联客户端：{selectedClient ? (
                <a href={`#/clients?clientId=${encodeURIComponent(selectedClient.clientId)}`}>{selectedClient.client}</a>
              ) : '未绑定'}
            </span>
            <button type="button" className="btn btn-quiet btn-sm" onClick={clearFilter}>
              <X size={14} />
              清除筛选
            </button>
          </div>
        ) : null}

        {clients.error ? (
          <StateBlock
            kind="error"
            title="客户端关联数据没取到"
            detail={errorDetail(clients.error)}
            onRetry={clients.reload}
          />
        ) : null}

        <Panel title="密钥列表" aside={<Pill>{count(rows.length)} 个 · 明文仅在创建时显示一次</Pill>}>
          {/* 首次加载由外层 KeysSkeleton 接管（v0.6.5），这里只处理错误/空/筛选态。 */}
          {keys.error ? (
            <StateBlock kind="error" title="密钥数据没取到" detail={errorDetail(keys.error)} onRetry={keys.reload} />
          ) : filterLoading ? (
            <StateBlock kind="loading" title="正在读取客户端关联…" />
          ) : rows.length === 0 ? (
            clientId ? (
              <StateBlock kind="empty" title="没有关联的密钥">
                <button type="button" className="btn btn-quiet btn-sm" onClick={clearFilter}>
                  <X size={14} />
                  清除筛选
                </button>
              </StateBlock>
            ) : (
              <StateBlock
                kind="empty"
                title="还没有任何密钥"
                detail="没有密钥时 /v1/* 会拒绝所有请求。"
              >
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                  <KeyRound size={14} />
                  创建第一把密钥
                </button>
              </StateBlock>
            )
          ) : (
            <KeyTable
              rows={rows}
              clientByKey={clientByKey}
              providerNameById={providerNameById}
              pendingId={pendingId}
              onToggle={(row) => void toggleKey(row)}
              onEdit={setEditing}
              onDelete={setDeleting}
            />
          )}
          <div className="footer-note">
            完整密钥只在创建时显示一次，服务端只保存哈希；停用后立即失效，可随时重新启用。改名与改绑定不会动作废 —— 已接入的客户端不受影响。
            <br />
            上面「启用 / 停用 / 过期」三格互斥、相加等于总数：<b>过期优先于启停判断</b>（expiresAt 已过即归过期，不再看启用状态），所以一把同时「启用」又「过期」的密钥只会计进「过期」。
          </div>
        </Panel>
          </>
        )}
      </div>

      {creating ? <CreateKeyModal onClose={() => setCreating(false)} onCreated={reload} /> : null}

      {editing ? <EditKeyModal row={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}

      {deleting ? (
        <Modal
          title="删除这把密钥？"
          onClose={() => { if (!pendingId) setDeleting(null); }}
          footer={
            <>
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(pendingId)} onClick={() => setDeleting(null)}>
                取消（保留）
              </button>
              <button type="button" className="btn btn-danger btn-sm" disabled={Boolean(pendingId)} onClick={() => void confirmDelete()}>
                {pendingId ? <Loader2 size={14} className="spin" /> : null}
                {pendingId ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <div className="ov-lose">
            <b>会失去什么：</b>
            密钥「{deleting.name}」（{deleting.hint}）立即失效，任何还在用它的客户端会立刻收到 401，
            需要重新建密钥并逐个替换。此操作不可撤销。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
