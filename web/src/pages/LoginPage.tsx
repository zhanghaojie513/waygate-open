import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Banner } from '../components/ui/Banner';
import { BrandMark } from '../components/BrandMark';
import { ApiError } from '../services/http';
import type { Session } from '../hooks/useSession';
import { ScenePrism } from '../landing/ScenePrism';

/**
 * 登录页 —— POST /api/auth/login。
 * 口令走表单提交；错误原样显示服务端 message（含 40101 / 40290 限流）。
 *
 * [2026-10-17 棱镜门厅] 背景从「控制台照明的静态缩略版」升级为官网同款
 * 折面棱镜装置（9 片彩色玻璃 + 3D 透视 + 自转 + 掠光 + 星尘）。
 * 登录页是用户见到的第一个界面——棱镜是品牌视觉的主角，进门前先看到它。
 *
 * 实现方式：根元素挂 `.login-wrap .landing` 两个类——`.landing` 让
 * scene.css 的 38 条棱镜规则自动生效（零 CSS 复制，同源设计一处维护），
 * theme.css 的浅色覆写（发光体退役 + 玻璃片染色）也跟随 `.landing` 生效。
 * ScenePrism 是官网的完整场景宿主（SceneLayer DOM + scene.ts 引擎）。
 *
 * 卡片保持上轮的玻璃面 + 光标聚光 + 周期掠光（见 app.css）。
 */
export function LoginPage({ session, mockHint }: { session: Session; mockHint: string | null }) {
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /* 光标聚光：pointermove 写 --mx/--my 到卡片（控制台 console-fx.js 同机制）。
     只在 hover 设备上跑——触屏没有「悬停」语义。 */
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const onMove = (e: PointerEvent) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    card.addEventListener('pointermove', onMove);
    return () => card.removeEventListener('pointermove', onMove);
  }, []);

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
    <div className="login-wrap landing">
      {/* 棱镜装置：官网同款（SceneLayer DOM + scene.ts 星尘引擎）。
          fixed 全屏、aria-hidden、pointer-events:none —— 纯背景不挡交互。
          登录页没有滚动运镜（单屏），scene.ts 的 scroll 绑定自然不动。 */}
      <ScenePrism />

      <div className="login-card" ref={cardRef}>
        {/* 光标聚光：独立 DOM 层（::before 顶光 + ::after 掠光已占用伪元素）。 */}
        <span className="login-glow" aria-hidden="true" />
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
