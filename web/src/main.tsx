import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { redirectLegacyHash, watchLegacyHash } from './router';

/* [注意] 样式加载顺序是契约的一部分：
   令牌 → **主题（浅色下重定义令牌取值）** → 控制台 → 字体
   → 官网（scene/ui/landing 逐层叠加）→ scope 收尾。
   `theme.css` 必须紧跟 tokens.css：它只改令牌取值，必须早于一切消费令牌的规则 ——
   同特异度下后被加载的会赢，晚放会被组件规则盖住（与 tokens.css 自身的理由同）。
   官网四份 CSS（scene/ui/landing/scope）已移到 `landing/LandingPage.tsx` 顶部 import，
   随官网懒加载 chunk 输出独立 CSS（性能：控制台首屏不再下载/解析官网样式）。
   懒 chunk 的 CSS 总在入口 CSS 之后插入，所以"官网在后、scope 最后"的顺序不变。 */
import './styles/vendor/tokens.css';
import './styles/theme.css';
import './styles/vendor/motion.css';
import './styles/vendor/console-fx.css';
import './styles/app.css';
import './styles/vendor/fonts.css';

/* 首帧主题（抗闪）：index.html 的内联脚本已在渲染前写好了 `data-theme`，
   这里**不重写**，只把模块内的订阅状态与 DOM 对齐 —— 若路径判定与内联脚本
   有出入（例如旧书签 `/#/x` 刚被 redirectLegacyHash 改写成 `/console#/x`），
   这一步会把主题纠正到位，且因为发生在首帧渲染之前，同样不闪。 */
import { syncTheme } from './lib/theme';

/* 旧书签 `/#/overview` → `/console#/overview`。
   冷启动在首帧渲染前用 replaceState 完成（否则会先画一帧官网再跳走）；
   同文档改 hash 的情况由 watchLegacyHash 走真实跳转。 */
redirectLegacyHash();
watchLegacyHash();
/* 必须在 redirectLegacyHash 之后：重写路径会改变"是不是控制台"的判定。 */
syncTheme();

/* ---------------------------------------------------------------------------
   favicon：运行时用**绝对路径**注入（v0.4.23 修「favicon 不显示」）
   ---------------------------------------------------------------------------
   为什么不在 index.html 里写 `<link href="/icon.svg">`：vite 的 `base:'./'`
   会把 HTML 里的绝对路径也改写成相对路径（`./icon.svg`），于是在 /console
   这类子路径下浏览器请求 `/console/icon.svg`，而 nginx 的 SPA fallback 会把它
   兜成 index.html（text/html）—— 浏览器拿到 HTML 当图标，**静默失败**
   （这正是 favicon 长期不显示的根因）。运行时插入绕开 vite 的 HTML 改写，
   路径恒为根级 `/icon.svg`。
   为什么删得掉 HTML 里的 link：favicon 不要求出现在初始 HTML，浏览器会在
   文档加载后重新扫描 `<link rel=icon>`。
   `?v=` 版本串对抗 favicon 的顽固缓存（改图标内容时同步改它）。
   --------------------------------------------------------------------------- */
for (const rel of ['icon', 'apple-touch-icon']) {
  const link = document.createElement('link');
  link.rel = rel;
  link.type = 'image/svg+xml';
  link.href = '/icon.svg?v=1';
  document.head.appendChild(link);
}

const root = document.getElementById('root');
if (!root) throw new Error('#root 未找到 —— index.html 被改坏了');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// @zbiti-ai:f:33:7025b5a9
