import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { Modal } from '../ui/Modal';
import { api } from '../../services/api';
import { ApiError } from '../../services/http';
import { errorDetail } from '../ui/StateBlock';
import { CopyCommand } from '../ui/CopyCommand';
import { useToast } from '../ui/Toast';

/**
 * 「导入客户端」—— 新增提供商旁的授权式入口（v1.6.11）。
 *
 * ## 与「新增提供商」的分工
 *   · **新增提供商**：手填名称/地址/凭证（WorkBuddy 的 `ck_` 密钥走这条）。
 *   · **导入客户端**（本弹窗）：**选一个客户端 → 跳官方授权页 → 回来自动导入**。
 *     适用于凭证在客户端登录态里、用户拿不到的两家（MiniMax Code / Qoder CN）。
 *
 * ## 流程（用户口径：选完点导入 → 提示即将跳授权页 → 确定跳转）
 *   ① 选客户端（三选一）+ 起个名字
 *   ② 点「导入」→ **确认弹窗**提示「即将跳转至授权页」
 *   ③ 确定 → 先建行（无凭证）→ 申请授权 → 开新标签页 → 原地轮询
 *   ④ `done` → 凭证已落盘；`error` → 停下并说明原因
 *
 * 三家授权机制各不相同（WorkBuddy 业务码 / MiniMax PKCE 设备码 / Qoder PKCE + 404 判等待），
 * 全部由服务端按协议分派（见 server/src/api/device-import.service.ts）。
 *
 * ⚠️ **前端从不接触令牌**：只拿 authUrl 与状态；私有状态（device_code / verifier）留在服务端。
 */

/** 可选客户端（= 三种协议）。 */
const CLIENT_CHOICES = [
  { protocol: 'openai' as const, label: 'WorkBuddy', desc: 'OpenAI 方言', needsAuth: true },
  { protocol: 'anthropic' as const, label: 'MiniMax Code', desc: 'Anthropic 方言', needsAuth: true },
  { protocol: 'qoder' as const, label: 'Qoder CN', desc: 'COSY 协议', needsAuth: true },
];

/** 各协议的默认上游地址（与服务端 seeds 一致，避免用户手填错）。 */
const DEFAULT_BASE_URL: Record<string, string> = {
  openai: 'https://copilot.tencent.com',
  anthropic: 'https://agent.minimax.cn',
  qoder: 'https://gateway.qoder.com.cn',
};

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 5 * 60 * 1000;

type Phase = 'pick' | 'confirm' | 'waiting' | 'done';

export function ImportClientModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('pick');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic' | 'qoder'>('anthropic');
  const [name, setName] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [userCode, setUserCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  /** 已建好的提供商 id（确认后先建行再授权，故要记住以便关闭时清理）。 */
  const providerId = useRef<string | null>(null);
  const stopped = useRef(false);
  const choice = CLIENT_CHOICES.find((c) => c.protocol === protocol)!;

  /* 卸载：停轮询 + 通知服务端释放授权会话。 */
  useEffect(() => {
    return () => {
      stopped.current = true;
      const id = providerId.current;
      if (id) void api.providerImportDeviceCancel(id).catch(() => undefined);
    };
  }, []);

  /** ② 确认后：建行 → 申请授权 → 开新页 → 轮询。 */
  const confirmAndStart = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      /* 先建行（无凭证）—— 授权成功后才有 id 可落凭证。 */
      const created = await api.createProvider({
        name: name.trim() || choice.label,
        baseUrl: DEFAULT_BASE_URL[protocol] ?? DEFAULT_BASE_URL.openai!,
        credential: '',
        protocol,
      });
      providerId.current = created.item.id;

      const r = await api.providerImportDeviceStart(created.item.id);
      if (!r.ok || !r.authUrl) {
        setErr(new ApiError(r.message ?? '申请授权失败', 0, 0));
        setPhase('confirm');
        setBusy(false);
        return;
      }
      setAuthUrl(r.authUrl);
      setUserCode(r.userCode ?? '');
      window.open(r.authUrl, '_blank', 'noopener');
      setPhase('waiting');
      setBusy(false);

      /* ③ 原地轮询：用户在浏览器点完，这里自动完成。 */
      const deadline = Date.now() + POLL_MAX_MS;
      while (!stopped.current && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        if (stopped.current) return;
        const p = await api.providerImportDevicePoll(created.item.id);
        if (stopped.current) return;
        if (p.status === 'done') {
          setPhase('done');
          toast.push({ tone: 'success', message: `${created.item.name} 凭证已导入。` });
          onImported();
          return;
        }
        if (p.status === 'error') {
          setErr(new ApiError(p.message ?? '授权失败', 0, 0));
          setPhase('confirm');
          return;
        }
      }
      if (!stopped.current) {
        setErr(new ApiError('授权超时（5 分钟）—— 请重新发起导入。', 0, 0));
        setPhase('confirm');
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
      setPhase('confirm');
      setBusy(false);
    }
  }, [choice.label, name, onImported, protocol, toast]);

  /* ── 完成 ── */
  if (phase === 'done') {
    return (
      <Modal
        title="凭证已导入"
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary btn-sm" onClick={onClose}>完成</button>}
      >
        <Banner tone="success">
          <span>{name.trim() || choice.label} 的凭证已通过官方授权导入。</span>
        </Banner>
        <p className="ov-sub" style={{ marginTop: 12 }}>
          回到列表点<b>试通</b>确认可用，再按需启用（启用后它才参与出站路由）。
        </p>
      </Modal>
    );
  }

  /* ── 等待授权 ── */
  if (phase === 'waiting') {
    return (
      <Modal title="等待你完成授权" onClose={onClose}>
        <div className="cred-guide">
          <div className="cred-guide-note">
            已为你打开 <b>{choice.label}</b> 的授权页 —— <b>请在浏览器里完成授权</b>，
            本窗口会自动检测结果，无需回到终端。
          </div>
          {userCode ? (
            <div className="cred-guide-note">
              若页面要求输入短码：<span className="code-chip">{userCode}</span>
            </div>
          ) : null}
          <CopyCommand command={authUrl} />
          <div className="cred-guide-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader2 size={14} />
            正在等待授权完成…（最多 5 分钟；没弹出浏览器就点上面的链接）
          </div>
          {err ? <Banner tone="error">{errorDetail(err)}</Banner> : null}
        </div>
      </Modal>
    );
  }

  const isConfirm = phase === 'confirm';
  return (
    <Modal
      title="导入客户端"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => {
              if (!isConfirm) { setPhase('confirm'); return; }
              void confirmAndStart();
            }}
          >
            {busy ? <Loader2 size={14} /> : <ExternalLink size={14} />}
            {busy ? '正在申请授权…' : isConfirm ? '确定，前往授权页' : '导入'}
          </button>
        </>
      }
    >
      {!isConfirm ? (
        <>
          <p className="ov-sub">
            选一个客户端，用它的**官方授权**拿到凭证（凭证在客户端登录态里，用户拿不到、无需手填）。
          </p>
          <div className="ov-field">
            <label>客户端类型</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {CLIENT_CHOICES.map((c) => (
                <label
                  key={c.protocol}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name="import-client"
                    checked={protocol === c.protocol}
                    onChange={() => setProtocol(c.protocol)}
                  />
                  <span>
                    <b>{c.label}</b>
                    <span className="ov-hint" style={{ marginLeft: 8 }}>{c.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="ov-field">
            <label htmlFor="imp-name">名称（可留空）</label>
            <input
              id="imp-name"
              className="field-input text"
              style={{ width: '100%' }}
              value={name}
              placeholder={choice.label}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </>
      ) : (
        <>
          <Banner tone="warn">
            <span>
              即将跳转至 <b>{choice.label}</b> 的授权页面（<b>新标签页</b>）。
              请在页面里登录并完成授权，授权完成后本窗口会自动检测。
            </span>
          </Banner>
          <div className="cred-guide-note" style={{ marginTop: 12 }}>
            授权只用于取本工具的凭证；令牌保存在<b>本机服务端</b>（0600），不会回传到浏览器。
          </div>
          {protocol === 'anthropic' ? (
            <div className="cred-guide-note" style={{ marginTop: 8 }}>
              ⚠️ MiniMax 的凭证是<b>同账号单会话</b>：请用<b>专用账号</b>，
              否则会与日常客户端互相顶下线。
            </div>
          ) : null}
          {err ? <Banner tone="error">{errorDetail(err)}</Banner> : null}
        </>
      )}
    </Modal>
  );
}
