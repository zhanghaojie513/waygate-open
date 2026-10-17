import { useState, type FormEvent } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import { useResource } from '../../hooks/useResource';
import type { CreatedKey, KeyScope } from '../../types/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { errorDetail } from '../ui/StateBlock';
import { EMPTY_POLICY, KeyPolicyFields, parsePolicyDraft, type KeyPolicyDraft } from './KeyPolicyFields';

/** 建密钥可选的权限范围（对应 KEY 页规则的四种 scope）。 */
type ScopeKind = 'all' | 'family' | 'tag' | 'models';
const SCOPE_KIND: Array<{ value: ScopeKind; label: string }> = [
  { value: 'all', label: '全部模型' },
  { value: 'family', label: '仅某系' },
  { value: 'tag', label: '仅某标签' },
  { value: 'models', label: '指定模型' },
];

const FAMILIES = ['kimi', 'deepseek', 'glm', 'minimax', 'hy4', 'hy3', 'space', 'step'];
const TAGS = ['限时免费', '限时折扣', '夜间折扣', '订阅优先'];

/**
 * 创建密钥 —— 明文只显示一次（AC-08）。
 * 成功后立刻切到「仅此一次」视图，关闭即不可再取回。
 */
export function CreateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ScopeKind>('all');
  const [family, setFamily] = useState(FAMILIES[0]);
  const [tag, setTag] = useState(TAGS[0]);
  /* [2026-10-08 修复] 「指定模型」此前提交的是一份**空白名单**，而服务端明确拒绝
     （`keys.parsing.ts`：`scope.type=models 时必须提供非空的 scope.value 字符串数组`）——
     也就是说这个选项**建不出密钥来**，点了只会吃一个 400。
     原来的提示写「指定模型清单在创建后按需补充」，但**并不存在**补充的接口
     （`PATCH /api/keys/:id` 只收 name/enabled）。两句话都是假的，合起来让这个选项
     看起来能用、实际永远失败。
     现在改成**创建时就真的选模型**（从模型目录里勾），于是四种 scope 都建得出来。 */
  const [models, setModels] = useState<string[]>([]);
  const catalog = useResource(() => api.catalog(), [], { cacheKey: 'catalog' });
  /**
   * 「绑定提供商」的候选 = **已登记的提供商**（`api.providers()`）。
   *
   * [2026-10-09 口径澄清] 本项目的形态是**反代客户端订阅**：
   * **提供商 ≡ 客户端**（WorkBuddy 就是那个客户端，目前只纳入了它）。
   * 所以这把密钥绑的是"哪个客户端订阅"，而不是某个 UA 工具名 ——
   * 候选因此取**提供商表**，不取 UA 解析出的工具名（那是"哪个工具发的"，另一个维度）。
   * **没有「自定义…」**（2026-10-09 用户要求）：反代场景下提供商只能来自登记表，
   * 手输等于绑到一个不存在的名字。要绑新的，先去「提供商管理」页登记它。
   */
  const providers = useResource(() => api.providers(), [], { cacheKey: 'providers' });
  /* [v0.4.20] 选中的提供商（有序，第 1 项优先级最高）。空数组 = 不绑定。 */
  const [clientPicks, setClientPicks] = useState<string[]>([]);
  /* [v0.4.35] 访问策略草稿（IP 白名单 / 最大 IP 数 / Token 配额）。 */
  const [policy, setPolicy] = useState<KeyPolicyDraft>(EMPTY_POLICY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  /* 可勾选的模型：只列**已启用**的 —— 下架的模型选了也只会得到 403，
     把不可用的东西摆在选项里等于给用户埋一个必然失败的选择。 */
  const selectableModels = (catalog.data?.models ?? []).filter((m) => m.enabled);

  const toggleModel = (id: string) =>
    setModels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const scope: KeyScope =
    kind === 'all'
      ? { type: 'all' }
      : kind === 'family'
        ? { type: 'family', value: family }
        : kind === 'tag'
          ? { type: 'tag', value: tag }
          : { type: 'models', value: models };

  /* 「指定模型」选了 0 个时不能提交 —— 与服务端的 400 对齐，在本地先挡住，
     用户不必先失败一次才知道。 */
  const missingModels = kind === 'models' && models.length === 0;

  /* 标出当前已启用的提供商；排序稳定，避免每次取数变化。
     [2026-10-17] value 改为提供商 **id**（唯一）——名字会在删除重建同名时错绑。 */
  const providerOptions = (providers.data?.items ?? [])
    .map((p) => ({ value: p.id, label: p.active ? `${p.name}（已启用）` : p.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));

  /* [v0.4.20] 多选 + 优先级：clientPicks 是有序数组，第 1 项优先级最高。
     勾选即追加到末尾；取消勾选即移除。顺序由上下箭头调整（比拖拽在弹层里更可靠、可键盘操作）。 */
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

  const canSubmit = Boolean(name.trim()) && !busy && !missingModels;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    /* [v0.4.35] 策略草稿先在本地解析（规则与服务端一致），错了不吃 400 直接展示。 */
    const parsed = parsePolicyDraft(policy);
    if ('error' in parsed) {
      setError(new ApiError(parsed.error, 400, 0));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createKey({
        name: name.trim(),
        scope,
        clients: clientPicks,
        client: clientPicks[0] ?? null,
        ipWhitelist: parsed.ipWhitelist,
        maxIps: parsed.maxIps,
        tokenQuota: parsed.tokenQuota,
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal
        title="密钥已创建"
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            我已保存，关闭
          </button>
        }
      >
        <div className="ov-lose">
          <b>会失去什么：</b>
          {created.warning}
        </div>
        <PlaintextKey value={created.key} />
        <div className="ov-hint">
          服务端只保存哈希。这串明文不会再出现，丢失只能删除重建。
          下游可用 <span className="code-chip">GET /v1/usage</span>（带这把密钥）自查配额余量与有效期 —— 纯只读，不产生调用。
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="新建密钥"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="create-key-form" className="btn btn-primary btn-sm" disabled={!canSubmit}>
            {busy ? <Loader2 size={14} /> : null}
            {busy ? '创建中…' : '创建密钥'}
          </button>
        </>
      }
    >
      <p className="ov-sub">
        给一个提供商或用途起名。绑定提供商名后，识别规则第 2 条「密钥归属」就能直接命中。
      </p>
      <form id="create-key-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="ov-field">
          <label htmlFor="ck-name">密钥名称</label>
          <input
            id="ck-name"
            className="field-input text"
            style={{ width: '100%' }}
            value={name}
            autoFocus
            placeholder="例如：Cursor · 笔记本"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="ov-field">
          <label>权限范围</label>
          <Select value={kind} options={SCOPE_KIND} onChange={setKind} width={180} />
          {kind === 'family' ? <Select value={family} options={FAMILIES.map((f) => ({ value: f, label: `${f} 系` }))} onChange={setFamily} width={180} /> : null}
          {kind === 'tag' ? <Select value={tag} options={TAGS.map((t) => ({ value: t, label: t }))} onChange={setTag} width={180} /> : null}
          {kind === 'models' ? (
            /* 模型清单**必须在创建时选**（服务端不接受空名单，且没有后续补充的接口）。
               已启用的才列 —— 下架的选了也只会 403。 */
            <div className="scope-models">
              {catalog.loading ? (
                <div className="ov-hint">正在读取模型清单…</div>
              ) : selectableModels.length === 0 ? (
                <div className="ov-hint">模型清单为空。先去「提供商」面板执行一次「获取模型」。</div>
              ) : (
                <>
                  <div className="ov-hint">
                    已选 {models.length} 个{missingModels ? ' —— 至少选一个才能创建' : ''}
                  </div>
                  <div className="scope-models-list">
                    {selectableModels.map((m) => (
                      <label className="scope-model" key={m.id}>
                        <input
                          type="checkbox"
                          checked={models.includes(m.id)}
                          onChange={() => toggleModel(m.id)}
                        />
                        <span className="code-chip">{m.id}</span>
                        <i>{m.displayName}</i>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="ov-field">
          <label>绑定提供商（可多选，可排序）</label>
          {/* [v0.4.20] 单选 → 多选 + 优先级。参考图：勾选后进入下方"已选"列表，
              用上下箭头调顺序（第 1 位优先级最高）。为后续按优先级路由到不同上游预留。
              本项目是反代客户端订阅：绑定名会覆盖密钥名进入显示名回落链（client-name.ts），
              归因用第 1 位（服务端 `client` 列 = clients[0]）。 */}
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
                勾选后这个 Key 的请求会归到对应提供商名下；第 1 位是首选（用量归因与后续路由都优先用它）。
              </div>
            </>
          )}
        </div>

        {/* [v0.4.35] 访问控制三旋钮 —— 全部留空 = 不限制（与旧行为一致）。 */}
        <KeyPolicyFields draft={policy} onChange={setPolicy} />

        {error ? <Banner tone="error">{errorDetail(error)}</Banner> : null}
      </form>
    </Modal>
  );
}

/** 明文密钥展示 + 复制。复制失败时降级为提示（无 clipboard 权限的浏览器）。 */
export function PlaintextKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="ov-field">
      <label>完整密钥（只此一次）</label>
      <div className="key-plain">
        <span style={{ flex: 1 }}>{value}</span>
        <button type="button" className="copy" aria-label={copied ? '已复制完整密钥' : '复制完整密钥'} onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}
