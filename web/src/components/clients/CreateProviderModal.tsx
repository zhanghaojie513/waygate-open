import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { errorDetail } from '../ui/StateBlock';
import { CopyCommand } from '../ui/CopyCommand';

/** 凭证的最小形状校验（与服务端 credential.service 同源，先在本地挡明显手滑）。 */
const KEY_RE = /^ck_[\x21-\x7e]{16,}$/;
const KEY_HINT = '应以 ck_ 开头，后接至少 16 位可见字符（不能含空格或换行）';

/* [v0.5.0] 协议决定一切下游差异：路径方言、凭证形态、目录来源。 */
type Protocol = 'openai' | 'anthropic' | 'qoder';
const PROTOCOL_OPTIONS = [
  { value: 'openai' as Protocol, label: 'WorkBuddy（OpenAI 方言）' },
  { value: 'anthropic' as Protocol, label: 'MiniMax Code（Anthropic 方言）' },
  { value: 'qoder' as Protocol, label: 'Qoder CN（COSY 协议，免费档）' },
];

/** 两家的凭证都来自本机客户端登录态 —— 用户手上没有，只能建完再导入。 */
const NEEDS_IMPORT: readonly Protocol[] = ['anthropic', 'qoder'];

/**
 * 新增提供商：名称 + 地址 + 协议（+ WorkBuddy 的密钥）。
 * 建完**不自动激活**（先试通再切）。
 *
 * [v1.6.10] 为什么 anthropic / qoder 不再要手填凭证 —— 与「配置」抽屉同一理由
 * （v1.6.4 改的是抽屉，这里当时漏了）：
 * 这两家的凭证是**客户端登录态里的东西**（MiniMax = `mmort_` refresh token；
 * Qoder = 一整段身份 JSON），用户无从获取、也手敲不出来。
 * 原先强制必填，等于这两家在界面上**根本建不出来**；
 * 而导入脚本 `qoder-import-credential.mjs <provider_id>` 又要求 provider 先存在 —— 死锁。
 *
 * 现在分两步：先建行（无凭证），拿到 id 后**立刻自动导入**。
 * 导入结果就地展示（分离部署时给可复制的推送命令），不必再去抽屉里找。
 */
export function CreateProviderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  /** 需要导入的两家：建完 provider 后的导入结果（null = 尚未建）。 */
  const [importState, setImportState] = useState<
    { providerName: string; kind: 'ok' | 'unavailable' | 'error'; text: string; command?: string } | null
  >(null);

  const needsImport = NEEDS_IMPORT.includes(protocol);
  const credOk = protocol === 'anthropic'
    ? /^mmort_[\x21-\x7e]{16,}$/.test(credential.trim()) || /^[\x21-\x7e]{24,}$/.test(credential.trim())
    : protocol === 'qoder'
      ? (() => {
          try {
            const j = JSON.parse(credential.trim()) as Record<string, unknown>;
            return ['token', 'refreshToken', 'uid', 'name', 'userType'].every(
              (f) => typeof j[f] === 'string' && (j[f] as string).trim() !== '',
            );
          } catch {
            return false;
          }
        })()
      : KEY_RE.test(credential.trim());
  /* 需要导入的两家：凭证不是提交前提（靠建完自动导入），故只看名称与地址。 */
  const canSubmit = Boolean(name.trim() && baseUrl.trim() && (needsImport || credOk)) && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { item } = await api.createProvider({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        credential: needsImport ? '' : credential.trim(),
        protocol,
      });
      if (!needsImport) {
        onCreated();
        return;
      }
      /* 行已建出、id 到手 —— 立刻从本机客户端登录态导入（关掉死锁的那一步）。 */
      const r = await api.providerImportLocal(item.id);
      setImportState({
        providerName: item.name,
        kind: r.ok ? 'ok' : r.outcome === 'unavailable' ? 'unavailable' : 'error',
        text: r.message + (r.detail ? `\n${r.detail}` : ''),
        command: r.outcome === 'unavailable'
          ? `node tools/import-credential-push.mjs ${location.origin} ${protocol === 'qoder' ? 'qoder' : 'minimax'} --provider ${item.id}`
          : undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setBusy(false);
    }
  };

  /* ── 第二步：导入结果（两家凭证来自客户端登录态的场景） ── */
  if (importState) {
    const done = importState.kind === 'ok';
    return (
      <Modal
        title={done ? '凭证已导入' : '已创建，凭证待导入'}
        onClose={onCreated}
        footer={
          <button type="button" className="btn btn-primary btn-sm" onClick={onCreated}>
            完成
          </button>
        }
      >
        <Banner tone={importState.kind === 'ok' ? 'success' : importState.kind === 'unavailable' ? 'warn' : 'error'}>
          <span>
            {importState.text}
            {importState.command ? (
              <>
                <br />
                在<b>装了客户端的那台机器</b>的仓库目录下跑：
                <CopyCommand command={importState.command} />
              </>
            ) : null}
          </span>
        </Banner>
        <p className="ov-sub" style={{ marginTop: 12 }}>
          {done ? (
            <>
              「{importState.providerName}」的凭证已从本机客户端登录态导入。回到列表点<b>试通</b>确认可用，
              再按需启用（启用后它才参与出站路由）。
            </>
          ) : (
            <>
              「{importState.providerName}」已建好，但凭证还没进这条路。导入完成后回到列表点<b>试通</b>；
              期间这一行显示「未配置」，不影响其它提供商。
            </>
          )}
        </p>
      </Modal>
    );
  }

  /* ── 第一步：基本信息 ── */
  return (
    <Modal
      title="新增提供商"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="create-provider-form" className="btn btn-primary btn-sm" disabled={!canSubmit}>
            {busy ? <Loader2 size={14} /> : null}
            {busy ? '创建中…' : needsImport ? '创建并导入凭证' : '创建提供商'}
          </button>
        </>
      }
    >
      <p className="ov-sub">
        登记一个上游订阅。建好后先「试通」，确认可用再按需启用。
      </p>
      <form id="create-provider-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="ov-field">
          <label htmlFor="pv-name">名称</label>
          <input
            id="pv-name"
            className="field-input text"
            style={{ width: '100%' }}
            value={name}
            autoFocus
            placeholder="例如：MiniMax · 专用号"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="ov-field">
          <label>上游类型</label>
          <Select value={protocol} options={PROTOCOL_OPTIONS} onChange={setProtocol} width={260} />
          <div className="ov-hint" style={{ marginTop: 6 }}>
            {protocol === 'openai'
              ? 'OpenAI 方言（/v2/chat/completions）：WorkBuddy 客户端订阅。模型目录从上游拉取并逐项实测。'
              : protocol === 'anthropic'
                ? 'Anthropic 方言（/mavis/api/v1/llm/v1/messages）：MiniMax Code 客户端订阅。模型目录用内置清单（M3 / M3.1-Flash / M2.7）。'
                : 'Qoder CN 网关（COSY 协议）：免费档（billable:false 实扣 0）。模型目录从网关 /model/list 拉取（含 Qwen3.8-Flash 等 14 个模型）。'}
          </div>
        </div>
        <div className="ov-field">
          <label htmlFor="pv-url">基地址</label>
          <input
            id="pv-url"
            className="field-input text"
            style={{ width: '100%' }}
            value={baseUrl}
            placeholder={protocol === 'anthropic' ? 'https://agent.minimax.cn' : protocol === 'qoder' ? 'https://gateway.qoder.com.cn' : 'https://api.example.com（只允许公网 http/https）'}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="ov-field">
          <label htmlFor="pv-key">{protocol === 'openai' ? '访问密钥' : '凭证'}</label>
          {needsImport ? (
            /* 这两家的凭证用户拿不到（客户端登录态里），手填无从谈起 ——
               给「建完自动导入」的说明，而不是一个填不出内容的输入框。 */
            <>
              <div className="cred-guide-note">
                {protocol === 'anthropic' ? (
                  <>
                    凭证是客户端登录态里的 <span className="code-chip">mmort_…</span> refresh token
                    （客户端数据目录 <span className="code-chip">auth.json</span> 的
                    <span className="code-chip">refreshToken</span>）。
                  </>
                ) : (
                  <>
                    凭证是一段<b>身份 JSON</b>，来自本机 Qoder 客户端登录态。
                  </>
                )}
                {' '}点「创建并导入凭证」后会<b>自动从本机客户端读取</b>，无需手填。
              </div>
              <div className="cred-guide-note" style={{ marginTop: 8 }}>
                请用<b>专用账号</b>（与桌面客户端共用会互相顶下线）。若本服务不在装了客户端的那台机器上，
                创建后会给出可复制的导入命令。
              </div>
            </>
          ) : (
            <>
              <input
                id="pv-key"
                className="field-input text"
                style={{ width: '100%' }}
                type="password"
                value={credential}
                placeholder={KEY_HINT}
                onChange={(e) => setCredential(e.target.value)}
                aria-label="提供商访问密钥"
              />
              <div className="ov-hint" style={{ marginTop: 6 }}>
                从官方后台复制 <span className="code-chip">ck_</span> 开头的订阅密钥。
              </div>
            </>
          )}
        </div>
        {error ? <Banner tone="error">{errorDetail(error)}</Banner> : null}
      </form>
    </Modal>
  );
}
