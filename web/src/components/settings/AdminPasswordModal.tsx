import { useState } from 'react';
import { Check, Copy, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import type { AdminPasswordResetResult } from '../../types/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { errorDetail } from '../ui/StateBlock';

/**
 * 管理口令的两种变更方式（api-contract §3.1.3 / §3.1.4）。
 *
 * ## 方式一 · 重置为随机口令（既有）
 *
 * 管理口令是这套控制台的**唯一**入口凭证。重置它意味着：
 *   - 当前登录的会话还有效，但下次登录必须用新口令
 *   - 没有找回通道（产品决策：不做令牌自救），忘了就只能上服务器删库重来
 *
 * 所以这里刻意做成三步，每一步都在换取一次「停一下」的机会：
 *
 *   **步骤一 · 警告** —— 先把后果摆出来（旧口令立即失效、无处找回、
 *     新口令只显示一次），用户点「我明白，继续」才算过。
 *   **步骤二 · 二次确认** —— 复用产品既有的「输入确认二字」心智
 *     （见 DangerConfirmModal），与其它破坏性操作保持一致手感。
 *   **步骤三 · 展示新口令** —— 一次性展示 + 复制 + 「关闭后不再显示」。
 *
 * ## 方式二 · 手动输入新口令（本轮新增，用户需求「管理口令能手动输入吗」）
 *
 * 随机 16 位口令强，但难记 —— 用户希望能**自己设定一个方便记忆的口令**。
 * 入口做成 tab：「随机重置」与「手动设定」并列，不改变前者的既有手感。
 * 手动设定不展示任何明文（用户自己输入的，他本就知道），成功只给一句提示。
 *
 * ## 明文的生命周期（安全上最关键的部分）
 *
 * 口令明文只存在于**组件本地 state**，且：
 *   - 不写 localStorage / sessionStorage / cookie
 *   - 不进 URL、不进日志、不上报
 *   - **关闭弹层即随组件卸载销毁**，不做「再次查看」
 *
 * 「不做再次查看」不是偷懒 —— 服务端库里只有 scrypt 哈希，
 * 它**根本回不出第二份明文**。既然回不出来，界面就不该给一个
 * 会在真机上永远失败的「查看」按钮。诚实地告诉用户「就这一次」，
 * 比给一个假按钮好。
 */

/** 与后端 `ADMIN_PASSWORD_MIN_LENGTH` 保持同源（前端校验只为即时体验，非安全边界）。 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

export function AdminPasswordModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** 变更成功、且用户看完新口令并关闭后回调（用于刷新设置页）。 */
  onDone?: () => void;
}) {
  /** 顶层模式：随机重置（原三步流）或手动设定（本轮新增）。 */
  const [mode, setMode] = useState<'reset' | 'manual'>('reset');
  const [step, setStep] = useState<'warn' | 'confirm' | 'result'>('warn');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminPasswordResetResult | null>(null);
  const [copied, setCopied] = useState(false);

  /** 手动设定：用户输入的新口令与二次确认。只在这个组件的 state 里存在。 */
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  /** 手动设定成功后显示的一句提示（不含明文）。 */
  const [manualDone, setManualDone] = useState<string | null>(null);

  const confirmed = text === '确认';

  const run = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.resetAdminPassword();
      setResult(res);
      setStep('result');
    } catch (err) {
      setError(err instanceof ApiError ? errorDetail(err) : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板 API 在非安全上下文（http 自签场景）可能被拒。
      // 不弹错打断用户 —— 口令就在眼前，手动选中复制同样可行。
      setError('浏览器拒绝了剪贴板访问，请手动选中口令复制。');
    }
  };

  const finish = () => {
    // 卸载前把明文清掉（虽然 React 会回收，但显式清更稳）
    setResult(null);
    setNewPw('');
    setConfirmPw('');
    onDone?.();
    onClose();
  };

  /** 提交手动设定的口令。前端先做一遍与后端同源的校验，错误就地提示。 */
  const submitManual = async () => {
    if (busy) return;
    const trimmed = newPw.trim();
    if (trimmed.length === 0) {
      setError('管理口令不能为空或纯空白。');
      return;
    }
    if (trimmed.length < MIN_LENGTH) {
      setError(`管理口令至少 ${MIN_LENGTH} 个字符，当前 ${trimmed.length} 个。`);
      return;
    }
    if (newPw.length > MAX_LENGTH) {
      setError(`管理口令最多 ${MAX_LENGTH} 个字符，当前 ${newPw.length} 个。`);
      return;
    }
    if (newPw !== confirmPw) {
      setError('两次输入不一致，请重新确认。');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await api.setAdminPassword(newPw);
      // ★ 提交后立即清空本地明文 state —— 任务完成，不再持有
      setNewPw('');
      setConfirmPw('');
      setManualDone(
        res.persisted
          ? '已生效，下次登录用新口令。当前会话不受影响。'
          : '已生效（仅内存），下次登录用新口令 —— 但服务端数据库不可写，重启后会回到上一个口令。',
      );
    } catch (err) {
      setError(err instanceof ApiError ? errorDetail(err) : String(err));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 方式二：手动设定（成功提示） ---------------- */
  if (mode === 'manual' && manualDone) {
    return (
      <Modal
        title="管理口令已更新"
        onClose={finish}
        footer={
          <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
            知道了
          </button>
        }
      >
        <div className="pw-note">{manualDone}</div>
        <p className="ov-sub" style={{ marginTop: 12 }}>
          服务端只存了口令的 scrypt 哈希，<b>回不出明文</b>。请确保你已经记住了刚才输入的口令。
        </p>
      </Modal>
    );
  }

  /* ---------------- 方式二：手动设定（输入表单） ---------------- */
  if (mode === 'manual') {
    const tooShort = newPw.trim().length > 0 && newPw.trim().length < MIN_LENGTH;
    const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
    return (
      <Modal
        title="手动设定管理口令"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || tooShort || mismatch || newPw.trim().length === 0}
              onClick={() => void submitManual()}
            >
              {busy ? <Loader2 size={14} /> : <KeyRound size={14} />}
              {busy ? '保存中…' : '保存并生效'}
            </button>
          </>
        }
      >
        <p className="ov-sub">
          设定一个你自己方便记忆的管理口令（至少 {MIN_LENGTH} 个字符）。
          保存后<b>立即生效、无需重启</b>，当前会话不会被打断。
        </p>
        <div className="ov-field">
          <label htmlFor="pw-new">新管理口令</label>
          <input
            id="pw-new"
            type="password"
            className="field-input text"
            style={{ width: '100%' }}
            value={newPw}
            autoFocus
            autoComplete="new-password"
            placeholder={`至少 ${MIN_LENGTH} 个字符`}
            onChange={(e) => {
              setNewPw(e.target.value);
              setError(null);
            }}
          />
          {tooShort ? (
            <div className="ov-hint" style={{ color: 'var(--warn-amber)' }}>
              至少 {MIN_LENGTH} 个字符，当前 {newPw.trim().length} 个。
            </div>
          ) : null}
        </div>
        <div className="ov-field">
          <label htmlFor="pw-new-confirm">再次输入</label>
          <input
            id="pw-new-confirm"
            type="password"
            className="field-input text"
            style={{ width: '100%' }}
            value={confirmPw}
            autoComplete="new-password"
            placeholder="重复上面输入的口令"
            onChange={(e) => {
              setConfirmPw(e.target.value);
              setError(null);
            }}
          />
          {mismatch ? (
            <div className="ov-hint" style={{ color: 'var(--warn-amber)' }}>
              两次输入不一致。
            </div>
          ) : null}
        </div>
        <div className="ov-lose">
          <b>请记住它：</b>
          设定后旧口令立即失效，且本产品没有「忘记口令」的找回通道。
          口令明文不会保存在浏览器任何位置，也不会被回显。
        </div>
        {error ? (
          <Banner tone="error">
            <span style={{ display: 'block', marginTop: 14 }}>{error}</span>
          </Banner>
        ) : null}
      </Modal>
    );
  }

  /* ---------------- 步骤三：展示新口令 ---------------- */
  if (step === 'result' && result) {
    return (
      <Modal
        title="新管理口令"
        onClose={finish}
        footer={
          <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
            我已保存，关闭
          </button>
        }
      >
        <div className="pw-once">
          <div className="pw-once-head">
            <ShieldAlert size={16} />
            <b>这是唯一一次显示</b>
          </div>
          <div className="pw-once-body">
            关闭这个窗口后，服务端也回不出这份明文 —— 库里只存了它的 scrypt 哈希。
            请现在就复制并保存到你的密码管理器里。
          </div>
        </div>

        <div className="pw-plain">
          <code>{result.password}</code>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => void copy()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        {!result.persisted ? (
          <Banner tone="warn">
            <span style={{ display: 'block', marginTop: 14 }}>
              服务端数据库不可写，新口令<b>仅本次运行有效</b>：重启后会回到旧口令。
              请先修好数据目录权限，再重置一次。
            </span>
          </Banner>
        ) : (
          <div className="pw-note">
            已写入服务端数据库，<b>立即生效、无需重启</b>，并会随每日备份一起保存。
            下次登录请使用新口令。
          </div>
        )}

        {error ? (
          <Banner tone="error">
            <span style={{ display: 'block', marginTop: 14 }}>{error}</span>
          </Banner>
        ) : null}
      </Modal>
    );
  }

  /* ---------------- 步骤二：输入「确认」 ---------------- */
  if (step === 'confirm') {
    return (
      <Modal
        title="确认重置管理口令？"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
              取消（保持现状）
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={!confirmed || busy}
              onClick={() => void run()}
            >
              {busy ? <Loader2 size={14} /> : null}
              {busy ? '重置中…' : '确认重置'}
            </button>
          </>
        }
      >
        <p className="ov-sub">
          重置后，<b>当前口令立即失效</b>。你正在使用的这个会话不会被打断，但下次登录必须用新口令。
        </p>
        <div className="ov-lose">
          <b>会失去什么：</b>
          旧口令的所有副本（笔记、密码管理器里的旧条目）都会变成无效值。本产品没有「忘记口令」的找回通道。
        </div>
        <div className="ov-field">
          <label htmlFor="pw-confirm">
            输入 <b style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>确认</b> 以继续
          </label>
          <input
            id="pw-confirm"
            className="field-input text"
            style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
            value={text}
            autoFocus
            placeholder="确认"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="ov-hint">打错一个字就没法继续。重置入口凭证值得这一步。</div>
        </div>
        {error ? <Banner tone="error">{error}</Banner> : null}
      </Modal>
    );
  }

  /* ---------------- 步骤一：警告 ---------------- */
  return (
    <Modal
      title="重置管理口令"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setStep('confirm')}>
            <KeyRound size={14} />我明白，继续
          </button>
        </>
      }
    >
      {/*
        模式切换：默认「随机重置」（既有手感），可切到「手动设定」。
        复用产品既有的 `.seg-tabs` 分段控件（见 UsagePage），保持手感一致。
        抽成子组件是为了避开 TS 的控制流收窄：上面的 `mode === 'manual'`
        提前返回后，本函数作用域内 `mode` 已被收窄为 `'reset'`，
        直接在这里比较 `'manual'` 会被判为「不可能」。子组件拿到的是
        完整的联合类型，故无此问题。
      */}
      <ModeSwitch
        mode={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
      />

      <p className="ov-sub">
        服务端会生成一个新的 16 位随机口令。<b>新口令只显示一次</b>，请准备好记录工具。
      </p>
      <div className="pw-warn-list">
        <div>
          <span className="pw-dot" />
          <span>
            <b>当前口令立即失效</b> —— 但已登录的会话<b>不受影响</b>：会话由独立密钥
            （RELAY_SECRET）签名，与口令本身无关。包括其它浏览器标签页在内的登录态，
            都会保持有效直到各自过期。本版本未提供「改密强制所有会话下线」。
          </span>
        </div>
        <div>
          <span className="pw-dot" />
          <span>
            <b>没有找回通道</b> —— 忘记新口令后，只能上服务器删除数据结构后重新引导。
          </span>
        </div>
        <div>
          <span className="pw-dot" />
          <span>
            <b>立即生效、无需重启</b> —— 哈希写进数据库后立刻对后续登录起作用。
          </span>
        </div>
      </div>
      <div className="ov-hint" style={{ marginTop: 12 }}>
        想用自己的口令？切到上方「手动设定」—— 随机口令更安全，手动口令更好记，按需选择。
      </div>
    </Modal>
  );
}

/** 「随机重置 / 手动设定」分段切换控件（复用 `.seg-tabs` 视觉）。 */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: 'reset' | 'manual';
  onChange: (m: 'reset' | 'manual') => void;
}) {
  return (
    <span className="seg-tabs" role="group" aria-label="口令变更方式" style={{ marginBottom: 14 }}>
      <button
        type="button"
        className={mode === 'reset' ? 'on' : ''}
        aria-pressed={mode === 'reset'}
        onClick={() => onChange('reset')}
      >
        随机重置
      </button>
      <button
        type="button"
        className={mode === 'manual' ? 'on' : ''}
        aria-pressed={mode === 'manual'}
        onClick={() => onChange('manual')}
      >
        手动设定
      </button>
    </span>
  );
}
// @zbiti-ai:f:461:4df27a48
