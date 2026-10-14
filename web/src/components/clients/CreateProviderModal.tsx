import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { errorDetail } from '../ui/StateBlock';

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

/** anthropic 凭证：oauth refresh token（mmort_）或 M Plan 平台 key。 */
const MMORT_RE = /^mmort_[\x21-\x7e]{16,}$/;
const PLAIN_KEY_RE = /^[\x21-\x7e]{24,}$/;

/** 新增提供商：名称 + 地址 + 协议 + 密钥。建完**不自动激活**（先试通再切）。 */
export function CreateProviderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const credOk =
    protocol === 'anthropic'
      ? MMORT_RE.test(credential.trim()) || PLAIN_KEY_RE.test(credential.trim())
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
  const canSubmit = Boolean(name.trim() && baseUrl.trim() && credOk) && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProvider({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        credential: credential.trim(),
        protocol,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setBusy(false);
    }
  };

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
            {busy ? '创建中…' : '创建提供商'}
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
                ? 'Anthropic 方言（/mavis/api/v1/llm/v1/messages）：MiniMax Code 客户端订阅或 M Plan。模型目录用内置清单（M3 / M3.1-Flash / M2.7）。'
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
            placeholder={protocol === 'anthropic' ? 'https://agent.minimax.cn' : 'https://api.example.com（只允许公网 http/https）'}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="ov-field">
          <label htmlFor="pv-key">{protocol === 'openai' ? '访问密钥' : protocol === 'qoder' ? '凭证（身份 JSON）' : '凭证（refresh token 或 API key）'}</label>
          <input
            id="pv-key"
            className="field-input text"
            style={{ width: '100%' }}
            type={protocol === 'qoder' ? 'text' : 'password'}
            value={credential}
            placeholder={
              protocol === 'anthropic'
                ? '客户端订阅贴 mmort_…（客户端数据目录 auth.json 的 refreshToken）；M Plan 贴平台 key'
                : protocol === 'qoder'
                  ? '{"token":"dt-…","refreshToken":"drt-…","uid":"…","name":"…","userType":"personal_standard"}（推荐 tools/qoder-import-credential.mjs 一键导入）'
                  : KEY_HINT
            }
            onChange={(e) => setCredential(e.target.value)}
          />
          {protocol === 'anthropic' ? (
            <div className="ov-hint" style={{ marginTop: 6 }}>
              refresh token 位置：客户端登录后 <span className="code-chip">~/.minimax/auth/prod/cn/mcode-public/auth.json</span>。
              建议用<b>专用账号</b>（与桌面客户端分开）——令牌会轮换，两边共用会互相顶下线。
            </div>
          ) : protocol === 'qoder' ? (
            <div className="ov-hint" style={{ marginTop: 6 }}>
              推荐在部署机跑 <span className="code-chip">node tools/qoder-import-credential.mjs &lt;提供商id&gt;</span> 从本机 Qoder
              客户端登录态直接导入（本服务<b>不自动刷新</b>令牌 —— 避免轮换顶掉桌面客户端登录；dt- 过期后重跑一次）。
            </div>
          ) : null}
        </div>
        {error ? <Banner tone="error">{errorDetail(error)}</Banner> : null}
      </form>
    </Modal>
  );
}
