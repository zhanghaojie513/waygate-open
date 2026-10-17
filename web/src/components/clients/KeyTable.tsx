import { formatDateTime, formatInt, formatRelative, formatScope } from '../../lib/format';
import { KEY_STATE_LABEL, keyState } from '../../lib/console';
import { Tag } from '../ui/Pill';
import type { ClientKeyRow } from '../../types/api';
import { Power, PowerOff, Trash2, Wrench } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

const TAG_TONE = { live: 'live', off: 'off', exp: 'exp' } as const;

/**
 * 密钥列表 —— **7 列**（不是 9 列）。
 *
 * 为什么合并：9 列在 1280px 视口下溢出容器，把「操作」（停用/删除）挤进横向滚动 ——
 * 主要操作必须横滚才能点到是不可接受的。合并两处**同源冗余**：
 *   · 密钥掩码并入「名称」下方（它只是名字的标识，独立成列没有信息增量）
 *   · 到期时间并入「状态」下方（两者是同一件事的两个侧面：能不能用、为什么不能用）
 * 结果 7 列，在 1280px 内完整可见，无需横滚。
 */
export function KeyTable({
  rows,
  clientByKey,
  providerNameById,
  pendingId,
  onToggle,
  onEdit,
  onDelete,
}: {
  rows: ClientKeyRow[];
  clientByKey?: Map<string, { clientId: string; name: string }>;
  /** 提供商 id → 显示名（绑定列解析 id 用；旧数据存名字则原样显示）。 */
  providerNameById?: Map<string, string>;
  pendingId: string | null;
  onToggle: (row: ClientKeyRow) => void;
  onEdit: (row: ClientKeyRow) => void;
  onDelete: (row: ClientKeyRow) => void;
}) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <caption className="sr-only">API Key 列表，共 {rows.length} 把密钥</caption>
      <thead>
        <tr>
          <th scope="col">名称 / 密钥</th>
          <th scope="col">绑定提供商</th>
          <th scope="col">权限范围</th>
          <th scope="col" className="r">近24h请求</th>
          <th scope="col" className="r">最后使用</th>
          <th scope="col">状态 / 到期</th>
          <th scope="col" className="r" style={{ width: 184 }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => {
          const st = keyState(k.enabled, k.expiresAt);
          const busy = pendingId === k.id;
          const client = clientByKey?.get(k.id);
          /* [v0.5.14 用户反馈] 绑定是**有序列表**（clients[0] 优先级最高），但列里只放
             第 1 个（多个时带「优先」标记），其余进 tooltip —— 多个名字会把列顶得太长。
             tooltip 始终给全量优先级顺序，信息不丢。 */
          const bindings = k.clients ?? [];
          return (
            <tr key={k.id}>
              <td>
                <div className="td-strong">{k.name}</div>
                <div className="td-sub td-mono">{k.hint}</div>
              </td>
              <td>
                {bindings.length > 0 ? (
                  <Tooltip content={`绑定提供商（路由优先级从高到低）：\n${bindings.map((b) => providerNameById?.get(b) ?? b).join('\n')}`}>
                    <span className="key-bindings">
                      {(() => {
                        /* [2026-10-17] 绑定值可能是提供商 id（新）或名字（旧数据）——
                           id 解析回名字显示，名字原样（后端 resolveRoute 双匹配兜底）。 */
                        const raw = bindings[0];
                        const name = providerNameById?.get(raw) ?? raw;
                        const entity = client?.name === name ? client : undefined;
                        return (
                          <>
                            {entity ? (
                              <a href={`#/clients?clientId=${encodeURIComponent(entity.clientId)}`}>{name}</a>
                            ) : (
                              name
                            )}
                            {bindings.length > 1 ? <i className="kb-rank">优先</i> : null}
                          </>
                        );
                      })()}
                    </span>
                  </Tooltip>
                ) : client ? (
                  /* 老数据：clients 列表为空但快照名还在 —— 按原逻辑显示（不丢信息）。 */
                  <a href={`#/clients?clientId=${encodeURIComponent(client.clientId)}`}>{client.name}</a>
                ) : (
                  <span className="td-sub">未绑定</span>
                )}
              </td>
              <td>{formatScope(k.scope)}</td>
              <td className="r td-mono">{formatInt(k.requests24h)}</td>
              <td className="r td-mono">{formatRelative(k.lastSeenAt)}</td>
              <td>
                {/* [v0.4.13 用户反馈] 状态与到期改**同一行** —— 两行占高太多、扫读时对不齐。 */}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                  <Tag tone={TAG_TONE[st]}>{KEY_STATE_LABEL[st]}</Tag>
                  <span className="td-sub td-mono">
                    {k.expiresAt ? `至 ${formatDateTime(k.expiresAt)}` : '永不过期'}
                  </span>
                </span>
                {/* [v0.4.35] 设了限额的密钥在此露出累计用量 —— 「还剩多少」是运营这把密钥
                    最常问的问题，不该要点进编辑弹窗才能看到。未设限额不占位。 */}
                {k.maxIps !== null || k.tokenQuota !== null ? (
                  <div className="td-sub td-mono" style={{ marginTop: 2 }}>
                    {k.maxIps !== null ? `IP ${k.usedIps ?? 0}/${k.maxIps}` : null}
                    {k.maxIps !== null && k.tokenQuota !== null ? ' · ' : null}
                    {k.tokenQuota !== null ? `${formatInt(k.usedTokens ?? 0)}/${formatInt(k.tokenQuota)} tok` : null}
                    {k.ipWhitelist && k.ipWhitelist.length > 0 ? ` · 白名单 ${k.ipWhitelist.length} 条` : null}
                  </div>
                ) : null}
              </td>
              <td className="r">
                <span style={{ display: 'inline-flex', gap: 8, justifyContent: 'flex-start' }}>
                  <Tooltip content="改名 / 改绑定 / 访问控制（不动权限范围，密钥与哈希不受影响）">
                    {busy ? (
                      <span tabIndex={0}>
                        <button type="button" className="mini-pill" disabled={busy} onClick={() => onEdit(k)}>
                          <Wrench size={12} />
                          修改
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="mini-pill" onClick={() => onEdit(k)}>
                        <Wrench size={12} />
                        修改
                      </button>
                    )}
                  </Tooltip>
                  <Tooltip content={st === 'exp' ? '已过期，需重新创建' : k.enabled ? '停用后立即失效' : '重新启用'}>
                    {busy || st === 'exp' ? (
                      <span tabIndex={0}>
                        <button
                          type="button"
                          className="mini-pill"
                          disabled
                          onClick={() => onToggle(k)}
                        >
                          {k.enabled ? <PowerOff size={12} /> : <Power size={12} />}
                          {k.enabled ? '停用' : '启用'}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="mini-pill" onClick={() => onToggle(k)}>
                        {k.enabled ? <PowerOff size={12} /> : <Power size={12} />}
                        {k.enabled ? '停用' : '启用'}
                      </button>
                    )}
                  </Tooltip>
                  <button
                    type="button"
                    className="mini-pill danger"
                    disabled={busy}
                    onClick={() => onDelete(k)}
                  >
                    <Trash2 size={12} />
                    删除
                  </button>
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
