import { lazy, Suspense, useEffect, useState } from 'react';
import { resolvePath } from './router';
import { syncTheme } from './lib/theme';
import { useHashRoute } from './hooks/useHashRoute';
import { useSession } from './hooks/useSession';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { BootScreen } from './components/BootScreen';
import { MOCKS_ENABLED } from './services/http';

/* [未发版] 路由级代码分割：官网访客不下载 6 个控制台页，控制台用户不下载官网
   场景/文案，首屏 JS 从单个 448K chunk 拆开。页面组件全是具名导出，lazy 要的是
   default —— 用 .then 映射在调用侧适配，**不去改各页面文件的导出**：
   页面文件是并行开发的热区，为分割去动导出只会制造合并冲突。
   LoginPage 保持静态导入：它是会话门禁，匿名访客第一屏就是它，
   不该为一个登录框多等一次 chunk 往返；且它足够小。 */
const LandingPage = lazy(() => import('./landing/LandingPage').then((m) => ({ default: m.LandingPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const UsagePage = lazy(() => import('./pages/UsagePage').then((m) => ({ default: m.UsagePage })));
const ClientsPage = lazy(() => import('./pages/ClientsPage').then((m) => ({ default: m.ClientsPage })));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })));
const RequestsPage = lazy(() => import('./pages/RequestsPage').then((m) => ({ default: m.RequestsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

/**
 * 顶层分流（契约 §2）：**pathname** 决定渲染官网还是控制台。
 *   `/`                → 官网（公开门面）
 *   `/console`(+`#/x`) → 控制台（登录门禁 + 4 视图，语义原样保留）
 *   `/foo`             → 官网（未匹配不进控制台）
 * 旧地址 `/#/overview` 在 main.tsx 里、首帧之前就重写成 `/console#/overview`。
 */

/** 监听 pathname 变化（前进/后退、程序化改地址），让分流跟着走。 */
function usePathname(): string {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return path;
}

const CONSOLE_TITLE = 'Waygate — 控制台';

/** 页面 chunk 加载中的内容区占位：路由切换时侧栏/骨架常驻，只有这一块短暂等待。
    排版口径与 BootScreen 一致（12.5px / --text-ghost），不算新视觉语言。 */
function PageLoading() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        fontSize: 12.5,
        color: 'var(--text-ghost)',
      }}
    >
      加载中…
    </div>
  );
}

/** 控制台分支：原 App 的正文整体搬进来，只换挂载位置。 */
function ConsoleApp() {
  const { route, navigate } = useHashRoute();
  const session = useSession();

  useEffect(() => {
    document.title = CONSOLE_TITLE;
  }, []);

  // 首屏无 hash 时补一个，保证刷新后仍在同一页、侧栏高亮有依据
  useEffect(() => {
    if (!window.location.hash) window.location.hash = '#/overview';
  }, []);

  if (session.status === 'loading') return <BootScreen />;

  if (session.status === 'anon') {
    return <LoginPage session={session} mockHint={MOCKS_ENABLED ? 'relay-dev' : null} />;
  }

  return (
    <AppShell
      route={route}
      navigate={navigate}
      expiresAt={session.expiresAt}
      onLogout={() => void session.logout()}
    >
      {/* Suspense 必须放在 AppShell **内侧**：包在外侧会让切路由时整个壳
          （侧栏/顶栏/会话态）一起卸载重挂，等 chunk 的就不只是内容区了。 */}
      <Suspense fallback={<PageLoading />}>
        {route === 'overview' ? <OverviewPage navigate={navigate} /> : null}
        {route === 'usage' ? <UsagePage /> : null}
        {route === 'clients' ? <ClientsPage /> : null}
        {route === 'keys' ? <ApiKeysPage /> : null}
        {route === 'requests' ? <RequestsPage /> : null}
        {route === 'settings' ? <SettingsPage /> : null}
      </Suspense>
    </AppShell>
  );
}

/**
 * [v7.0] 原型已删除（2026-10-12 用户要求）：4 页原型 + 分支路由已按采纳结果
 * 落进生产页，原型代码完成使命。已采纳进生产的部分：
 * 指标卡排版/视觉、StatBar 独立成卡与口径右上角、设置页左侧导航；
 * 未采纳部分（byTool 区块、ConcurrencyStrip、语义色 OKLCH 重调、Banner 统一）
 * 留待后续按需重做。
 */

export function App() {
  const pathname = usePathname();
  const isConsole = resolvePath(pathname) === 'console';

  /* 主题按**路由**重算：官网恒深色、控制台按用户偏好。
     首帧由 index.html 的内联脚本先写好（防闪），这里负责"之后"的每一刻 ——
     官网 ⇄ 控制台来回切（含前进/后退）时，主题必须跟着切换。
     依赖 pathname：它与分流用的是同一个值，不会出现"页面切了主题没切"。 */
  useEffect(() => {
    syncTheme();
  }, [pathname]);

  /* 官网分支的 fallback 是 null 而不是空白屏组件：body 的深色底来自
     render-blocking 的 CSS（tokens.css 的 body 规则），JS 执行前就已上色，
     不会白闪；这里等 chunk 的几百毫秒里就是"页面底色已铺好"。 */
  return isConsole ? <ConsoleApp /> : <Suspense fallback={null}><LandingPage /></Suspense>;
}
// @zbiti-ai:f:76:7d51062b
