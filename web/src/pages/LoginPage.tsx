import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Banner } from '../components/ui/Banner';
import { BrandMark } from '../components/BrandMark';
import { lazy, Suspense } from 'react';
/* [v8] BlurText 动态引入：LoginPage 本身是静态 import（会话门禁，匿名首屏），
   若静态引 BlurText 会把 motion（~50KB gzip）拖进 index 主包。
   lazy 后 motion 随独立小 chunk 并行加载；fallback 就是纯文本标题 ——
   与最终内容一致，无布局跳变，只是入场动效晚几十毫秒开始。 */
const BlurText = lazy(() => import('../landing/bits/BlurText.jsx'));
import { ApiError } from '../services/http';
import { api } from '../services/api';
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
  /** [v1.6.25] 服务端确认「仍在用内置默认口令」时为 true —— 只有这种情况才预填。 */
  const [usingDefault, setUsingDefault] = useState(false);

  /* [v1.6.25] 预填内置默认口令：本机启动形态（CLI 在回环绑定时注入 `waygate`）下，
     用户不该为了登录去终端里翻那串口令。服务端只在「确实是内置默认值」且
     「请求来自回环」时返回明文，其它情况一律 null。
     失败静默忽略 —— 不预填而已，不能让登录页报错。 */
  useEffect(() => {
    let alive = true;
    void api.bootstrapHint().then((hint) => {
      if (!alive || !hint.defaultInUse || !hint.password) return;
      setPassword(hint.password);
      setUsingDefault(true);
    });
    return () => {
      alive = false;
    };
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

  /* [v5] 布局从「居中卡片 + 全屏棱镜背景」改为「左装置 / 右表单」的分屏门厅。
     为什么：全屏背景上的居中卡片，装置只露出边缘，读作壁纸；
     分屏让装置完整地占左半边 —— 登录页是"门"，门厅里该看得见那件装置。
     装置用 inline variant（不挂相机引擎，纯 CSS 自转 + 掠光）。 */
  return (
    <div className="gate landing">
      {/* 左：玻璃装置作**背景层**，说明文字浮在其上。
          [v7] 从"容器里的装置"改为"铺满左栏的背景"。
          此前装置是 .gate-scene 里的一个方盒，九片玻璃的横向展开（外圈半径
          固定 218–228px）比盒子宽 —— 无论怎么调宽度都有一边被切。
          背景化之后：装置 absolute 铺满整栏、中心对齐、边缘用 mask 渐隐，
          「被切」在视觉上不再成立（边缘本来就是要淡出的），
          说明文字也不再需要给装置让位。 */}
      <div className="gate-scene">
        <div className="gate-scene-bg" aria-hidden="true">
          <ScenePrism variant="inline" />
        </div>
        <p className="gate-note">
          <b>只有一道门。</b>管理口令在服务端校验，前端不保存明文。忘记时可在服务器本地重置。
        </p>
      </div>

      {/* 右：表单 */}
      <div className="gate-form">
        <div className="form-in">
          <div className="login-brand">
            <BrandMark size={28} />
            <span className="b-name">途关</span>
            <span className="b-en">Waygate</span>
          </div>

          {/* [v8] 标题入场用 reactbits 的 BlurText（motion 系，逐词模糊浮现）。
              登录页是「门」—— 全页唯一的动效时刻给标题，克制。 */}
            <h1><Suspense fallback="进入控制台"><BlurText text="进入控制台" delay={150} stepDuration={0.5} /></Suspense></h1>
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
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (usingDefault) setUsingDefault(false);
                  }}
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
              {busy ? '正在验证…' : '进入'}
            </button>
          </form>

          <p className="login-hint">
            {usingDefault ? (
              <>
                本机默认口令：<code>{password}</code>
                <br />
                首次启动可直接登录，建议登录后到「设置 → 管理口令」改掉。
              </>
            ) : mockHint ? (
              `当前为 Mock 模式（npm run dev:mock），口令固定为 ${mockHint}。`
            ) : (
              '口令首次启动时若未配置 RELAY_ADMIN_PASSWORD_HASH，会打印到服务端 stdout 一次。'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
