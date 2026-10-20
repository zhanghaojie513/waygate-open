import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { Modal } from '../ui/Modal';
import { api } from '../../services/api';
import { ApiError } from '../../services/http';
import { errorDetail } from '../ui/StateBlock';

/**
 * 「新增自定义提供商」（v1.7.0）—— 任意 OpenAI 兼容端点（DeepSeek / 硅基流动 /
 * OpenRouter / 自建 vLLM…），鉴权就是静态 API key。
 *
 * ## 与「导入客户端」的关系
 * 那三家是**订阅制**：凭证在客户端登录态里，只能官方授权导入；这里是 **API-key 制**：
 * key 就在用户手上，手填是它的原生形态（不是 ck_ 那条被退役的死路）。
 *
 * ## URL 智能默认（与服务端 buildCustomChatUrl 同一条规则）
 * base 不带版本段 → 拼 `/v1/chat/completions`；以 `/v1`（或 `/vN`）结尾 → 只拼
 * `/chat/completions`。表单里**实时预览最终 URL** —— 用户看到的就是要请求的。
 * 少数非标布局用「高级」里的路径覆盖（根相对）。
 *
 * 建好后立即激活并拉一次模型清单；端点没有 /v1/models 时到「模型列表」抽屉里手动补。
 */

/** 与服务端 buildCustomChatUrl 完全同构（预览必须与真实请求一致，否则是骗人的预览）。 */
function previewChatUrl(baseUrl: string, chatPath: string): string | null {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    // 只为了早发现明显不是 URL 的输入；预览阶段不苛求（服务端会严格校验）
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  if (chatPath.trim().startsWith('/')) return `${base.replace(/\/v\d+$/i, '')}${chatPath.trim()}`;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function CustomProviderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** 成功后回调（父层刷新列表/目录）。 */
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [chatPath, setChatPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const preview = previewChatUrl(baseUrl, chatPath);
  const keyTrim = apiKey.trim();
  const canSubmit = Boolean(baseUrl.trim()) && keyTrim.length >= 8 && preview !== null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createProvider({
        name: name.trim() || '自定义提供商',
        baseUrl: baseUrl.trim(),
        credential: keyTrim,
        protocol: 'custom',
        chatPath: chatPath.trim() || null,
        activate: true,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新增自定义提供商"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 size={14} /> : <Plus size={14} />}
            {busy ? '正在创建…' : '添加并启用'}
          </button>
        </>
      }
    >
      <p className="ov-sub">
        任意 <b>OpenAI 兼容</b>端点（DeepSeek / 硅基流动 / OpenRouter / 自建 vLLM…）——
        API key 就在你手上，手填即可；创建后立即启用并拉取模型清单。
      </p>
      <div className="ov-field">
        <label htmlFor="cp-name">名称（可留空）</label>
        <input
          id="cp-name"
          className="field-input text"
          style={{ width: '100%' }}
          value={name}
          placeholder="如 DeepSeek"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="ov-field">
        <label htmlFor="cp-base">Base URL</label>
        <input
          id="cp-base"
          className="field-input text"
          style={{ width: '100%' }}
          value={baseUrl}
          placeholder="https://api.deepseek.com（带不带 /v1 都行）"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        {baseUrl.trim() ? (
          preview ? (
            <div className="ov-hint" style={{ marginTop: 6 }}>
              将请求：<b className="mono">{preview}</b>
            </div>
          ) : (
            <div className="ov-hint" style={{ marginTop: 6, color: 'var(--danger)' }}>
              这不像一个 http(s) 地址 —— 服务端也会拒绝它。
            </div>
          )
        ) : null}
      </div>
      <div className="ov-field">
        <label htmlFor="cp-key">API Key</label>
        <input
          id="cp-key"
          className="field-input text"
          style={{ width: '100%' }}
          type="password"
          value={apiKey}
          placeholder="sk-…（8 位以上；只存服务端，任何接口都读不回）"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <button
        type="button"
        className="btn btn-quiet btn-sm"
        style={{ padding: '2px 6px' }}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? '收起' : '高级'}（端点路径不是标准布局时用）
      </button>
      {showAdvanced ? (
        <div className="ov-field" style={{ marginTop: 8 }}>
          <label htmlFor="cp-path">API 路径（根相对，留空 = 智能默认）</label>
          <input
            id="cp-path"
            className="field-input text"
            style={{ width: '100%' }}
            value={chatPath}
            placeholder="/v1/chat/completions"
            onChange={(e) => setChatPath(e.target.value)}
          />
        </div>
      ) : null}

      <div className="cred-guide-note" style={{ marginTop: 12 }}>
        与订阅客户端不同：这里没有签到/积分账本；用量按 token 统计，单次积分列显示
        <b> -- </b>（标准端点不回报单次费用 ≠ 不扣费，以你端点侧的账单为准）。
      </div>
      {err ? <Banner tone="error">{errorDetail(err)}</Banner> : null}
    </Modal>
  );
}
