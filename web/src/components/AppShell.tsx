import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * 控制台外壳：场景层 + 左侧栏（导航）+ 主区。
 * 场景（三束柔光 / 调暗 / 噪点）、侧栏发光竖条、顶栏玻璃面、按视图的相机
 * —— 全部由 vendor CSS 承担，这里只搭骨架。
 * `data-view` 取当前路由，`console-fx.css` 的 `.app[data-view=…]` 据此给相机值。
 */
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';
import { ROUTES } from '../hooks/useHashRoute';
import type { Route } from '../hooks/useHashRoute';
import { formatRelative } from '../lib/format';
import { rememberConsoleRoute } from '../lib/consoleRoute';
import { LogOut, LayoutGrid, ChartColumn, Cable, KeyRound, ScrollText, SlidersHorizontal, Menu } from 'lucide-react';
import { Tooltip } from './ui/Tooltip';

const NAV: Array<{ route: Route; label: string; icon: ReactNode }> = [
  { route: 'overview', label: '概览', icon: <LayoutGrid size={18} /> },
  { route: 'usage', label: '积分与用量', icon: <ChartColumn size={18} /> },
  { route: 'clients', label: '提供商管理', icon: <Cable size={18} /> },
  { route: 'keys', label: 'API 密钥', icon: <KeyRound size={18} /> },
  { route: 'requests', label: '请求日志', icon: <ScrollText size={18} /> },
  { route: 'settings', label: '设置', icon: <SlidersHorizontal size={18} /> },
];

export function AppShell({
  route,
  navigate,
  expiresAt,
  onLogout,
  children,
}: {
  route: Route;
  navigate: (r: Route) => void;
  expiresAt: string | null;
  onLogout: () => void;
  children: ReactNode;
}) {
  /* 记住最后停留的视图：从官网点「打开控制台」时带回同一个视图（AC-10）。
     `useHashRoute` 的语义不变，记录动作只在这里发生。 */
  useEffect(() => {
    rememberConsoleRoute(route);
  }, [route]);

  /* [v1.5.2] 版本 chip 读**后端** /healthz（与官网同源）——构建期 `__APP_VERSION__`
     只反映 web 包构建时的 package.json；若某次发版只换了 server dist（或反之），
     两者会不一致，用户看到的版本号就不是线上真实运行的版本。后端版本是唯一真相；
     拉取失败（离线/首屏未达）回落构建期值，不阻塞渲染。 */
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/healthz', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const h = (await res.json()) as { version?: unknown };
        if (alive && typeof h.version === 'string' && h.version) setRuntimeVersion(h.version);
      } catch {
        /* 离线：保持构建期版本 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* 窄屏抽屉（≤720px）：侧栏在此宽度下移到文档流之外、收成可开合的抽屉。
     状态只在窄屏有意义 —— 宽屏下 CSS **忽略** `data-nav-open`，侧栏照旧常驻，
     所以 DOM 与改造前完全一致，宽屏视觉不受影响。 */
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navPreviousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (navOpen) {
      navPreviousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const first = sidebarRef.current?.querySelector<HTMLElement>('a[href], button:not([disabled])');
      first?.focus({ preventScroll: true });
      return;
    }
    if (navPreviousFocus.current?.isConnected) navPreviousFocus.current.focus({ preventScroll: true });
    navPreviousFocus.current = null;
  }, [navOpen]);

  /* Esc 关闭抽屉：抽屉盖住整块主区，键盘用户必须有一条不依赖鼠标的退路。 */
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNavOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = sidebarRef.current
        ? Array.from(sidebarRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
        : [];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  /* 视口回宽后抽屉自动收起，避免在窄→宽→窄来回后「莫名弹出」。 */
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 720) setNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /* 点导航即跳转并收起抽屉（否则抽屉会盖住刚跳到的页面）。 */
  const go = (r: Route) => {
    setNavOpen(false);
    navigate(r);
  };

  return (
    <div className="app" data-view={route} data-nav-open={navOpen ? 'true' : 'false'}>
      {/* 场景层（v4「照明」）：三束无方向柔光 + 调暗 + 噪点。
          几何（面/棱/环）已去掉，只留光的签名 —— 满铺式工作界面里放不下物体。
          位置/颜色在 console-fx.css §②，调暗与相机由 .app[data-view] 驱动。 */}
      <div className="scene" aria-hidden="true">
        <div className="lights">
          <div className="bloom l1" />
          <div className="bloom l2" />
          <div className="bloom l3" />
        </div>
        <div className="dimmer" />
        <div className="noise" />
      </div>

      {/* 窄屏导航开关：仅在 ≤720px 出现（宽屏 `display:none`）。
          图标用项目统一的 lucide-react，不用表情符号。 */}
      <button
        ref={navToggleRef}
        type="button"
        className="nav-toggle"
        aria-label="打开导航菜单"
        aria-controls="console-sidebar"
        aria-expanded={navOpen}
        onClick={() => setNavOpen((v) => !v)}
      >
        <Menu size={20} />
      </button>

      <aside ref={sidebarRef} className="sidebar" id="console-sidebar" aria-label="控制台导航">
        {/* 品牌 → 官网（契约 §2.5：控制台品牌 logo 回到 `/`）。
            版本号 chip：[v1.5.2] 读后端 /healthz（唯一真相，与官网同源）；
            拉取失败回落 vite define 的 `__APP_VERSION__`（构建期 package.json 版本）。 */}
        <a className="sb-brand" href="/">
          <BrandMark size={26} />
          <span>途关</span>
          <span className="brand-en">Waygate</span>
          <span className="brand-ver">v{runtimeVersion ?? __APP_VERSION__}</span>
        </a>

        <div className="sb-group">工作台</div>
        {NAV.filter((n) => ROUTES.includes(n.route)).map((n) => (
          <button
            key={n.route}
            type="button"
            className={`sb-item${route === n.route ? ' active' : ''}`}
            onClick={() => go(n.route)}
            aria-current={route === n.route ? 'page' : undefined}
          >
            {n.icon}
            {n.label}
          </button>
        ))}

        <div className="sb-spacer" />
        {/* 外壳外观开关：主题属于「这一个应用怎么显示」，不属于任何一页的设置 ——
            放侧栏页脚（随外壳常驻）才不会变成"只有某一页能切"。
            与账号卡分两行：账号卡只有约 216px 宽，再塞一枚 32px 按钮会把
            「会话有效 · …到期」压成省略号（那是真实信息，不能拿去换一个图标）。 */}
        <div className="sb-tools">
          <span className="sb-tools-lb">外观</span>
          <ThemeToggle />
        </div>
        {/* 账号区 = 侧栏页脚：身份是**真实数据**，不编人名。本产品是自托管单管理员，
            没有「人名」这回事 —— 原型 console-views.js 里那个演示人名是假数据，照抄就是假数据上屏。
            退出登录并进这张卡（原来是卡外一个漂着的裸按钮，还带绕开设计系统的内联样式）。 */}
        <div className="sb-account">
          <div className="avatar">管</div>
          <div className="meta">
            <b>管理员</b>
            <i>{expiresAt ? `会话有效 · ${formatRelative(expiresAt)}到期` : '本机管理员'}</i>
          </div>
          <Tooltip content="退出登录">
            <button
              type="button"
              className="sb-logout"
              onClick={onLogout}
              aria-label="退出登录"
            >
              <LogOut size={16} />
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* 抽屉背板：只在窄屏抽屉打开时可见，点它收起。宽屏 `display:none`。 */}
      <div className="nav-backdrop" aria-hidden="true" onClick={() => setNavOpen(false)} />

      <main className="main">{children}</main>
    </div>
  );
}
// @zbiti-ai:f:149:6f4d7b6e
