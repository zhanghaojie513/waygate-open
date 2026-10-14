import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Banner } from '../components/ui/Banner';
import { BrandMark } from '../components/BrandMark';
import { ApiError } from '../services/http';
import type { Session } from '../hooks/useSession';

/**
 * 登录页 —— POST /api/auth/login。
 * 口令走表单提交；错误原样显示服务端 message（含 40101 / 40290 限流）。
 */
export function LoginPage({ session, mockHint }: { session: Session; mockHint: string | null }) {
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.login(password);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      {/* [v0.4.22] 登录页背景：复刻控制台的「光」语言（同品牌视觉），纯 CSS 零 JS。
          三层叠加：品牌柔光（紫罗兰主光 + 电光青副光 + 冷白高光）→ 细网格 → 径向暗角。
          控制台用的是场景装置（.scene 的三束 bloom），登录页没有那套 DOM，
          用 radial-gradient 在本层内联实现同源的照明签名（设计见 console-fx.css §②）。 */}
      <div className="login-bg" aria-hidden="true">
        <span className="lb-bloom lb-1" />
        <span className="lb-bloom lb-2" />
        <span className="lb-bloom lb-3" />
        <span className="lb-grid" />
        <span className="lb-vignette" />
      </div>

      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={30} />
          <span className="b-name">途关</span>
          <span className="b-en">Waygate</span>
        </div>

        <h1>登录控制台</h1>
        <p className="sub">
          这是自用工具，只有一个管理口令。口令校验在服务端完成，前端不保存明文。
        </p>

        <form className="login-form" onSubmit={submit}>
          <div className="login-field">
            <label htmlFor="pw">管理口令</label>
            <div className="login-input">
              <KeyRound size={15} color="var(--text-faint)" aria-hidden />
              <input
                id="pw"
                type={reveal ? 'text' : 'password'}
                value={password}
                autoFocus
                autoComplete="current-password"
                placeholder="输入管理口令"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="login-eye"
                aria-label={reveal ? '隐藏口令' : '显示口令'}
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error ? <Banner tone="error">{error.message}</Banner> : null}

          <button type="submit" className="btn btn-primary login-submit" disabled={busy || !password}>
            {busy ? <Loader2 size={16} /> : null}
            {busy ? '正在验证…' : '进入控制台'}
          </button>
        </form>

        <p className="login-hint">
          {mockHint
            ? `当前为 Mock 模式（npm run dev:mock），口令固定为 ${mockHint}。`
            : '口令首次启动时若未配置 RELAY_ADMIN_PASSWORD_HASH，会打印到服务端 stdout 一次。'}
        </p>
      </div>
    </div>
  );
}
