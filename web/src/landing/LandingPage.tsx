import { useEffect } from 'react';
/* 官网样式随本懒加载 chunk 输出（控制台首屏不加载）。
   顺序即层叠契约：scene → ui → landing 逐层叠加，scope.css 必须**最后**——
   它负责把官网与控制台全局样式隔离开。 */
import './scene.css';
import './ui.css';
import './landing.css';
import './scope.css';
import { useLandingStatus } from './data';
import { initPage } from './page';
import { Rail } from './Rail';
import { NavBar } from './sections/NavBar';
import { Hero } from './sections/Hero';
import { Strip } from './sections/Strip';
import { Ways } from './sections/Ways';
import { Quickstart } from './sections/Quickstart';
import { Clients } from './sections/Clients';
import { Status } from './sections/Status';
import { Cta } from './sections/Cta';
import { Footer } from './sections/Footer';

/**
 * 官网落地页（`/`）。DOM 结构与 `prototype/v4/index.html` 一一对应：
 *   .scene（固定场景）→ .progress（顶部进度）→ .shell（内容）
 *   → .nav / .hero / .strip / #ways / #quickstart / #clients / #status / #cta / .footer
 *   → .rail（右侧章节轨，在 .shell 之外）
 *
 * 两条纪律写在两个 effect 里：
 *   ① `html.relay-landing` 只在**官网路由**挂载 —— 它是滚动条样式与平滑锚点的开关；
 *      控制台不挂它，因此控制台页面**不会**出现官网的滚动条与锚点行为。
 *   ② 页面行为是**命令式引擎**（page.ts，逐行移植自原型），在 useEffect 里
 *      挂载、返回 cleanup。StrictMode 会双跑 effect，引擎必须可重入 + 完整回收。
 *      场景引擎（scene.ts）由 Hero 里的 `<ScenePrism />` 自己挂载（Spec §4.2 的约定），
 *      它的 effect 是子组件的，先于本组件执行 —— 所以场景仍然先于页面行为就位。
 */
const TITLE = 'Waygate — 把自己的订阅积分变成一个 base_url';
const DESC = 'Waygate — 在本地把你的 AI 订阅积分（WorkBuddy / MiniMax / Qoder）暴露成 OpenAI 兼容接口，一个 Key 走所有客户端。';

function syncMeta(desc: string): () => void {
  const prevTitle = document.title;
  document.title = TITLE;
  let meta = document.querySelector('meta[name="description"]');
  const created = !meta;
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'description');
    document.head.appendChild(meta);
  }
  const prevDesc = meta.getAttribute('content');
  meta.setAttribute('content', desc);

  return () => {
    document.title = prevTitle;
    if (created) meta?.remove();
    else if (prevDesc != null) meta.setAttribute('content', prevDesc);
  };
}

export function LandingPage() {
  const status = useLandingStatus();

  /* ① html 级开关 + 文档元信息（进入官网时生效，离开时原样还原） */
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('relay-landing');
    const restoreMeta = syncMeta(DESC);
    return () => {
      html.classList.remove('relay-landing');
      restoreMeta();
    };
  }, []);

  /* ② 页面行为引擎：挂载 / 回收成对。（场景引擎由 Hero 内的 <ScenePrism /> 挂载） */
  useEffect(() => initPage(), []);

  return (
    <div className="landing">
      {/* [v5] 原来这里挂一个全屏 <ScenePrism />。装置改为 Hero 右栏的局部盒子后
          由 <Hero> 自己渲染，这一处必须删掉 —— 否则同页两份装置：
          全局那份还会以 position:relative 占住文档流顶部 361px，把内容压到折叠线以下。 */}
      <div className="progress" aria-hidden="true">
        <i />
      </div>

      <div className="shell">
        <NavBar version={status.version} />
        <Hero status={status} />
        <Strip />
        <Ways />
        <Quickstart version={status.version} />
        <Clients />
        <Status status={status} />
        <Cta />
        <Footer status={status} />
      </div>

      <Rail />
    </div>
  );
}
// @zbiti-ai:f:92:dd50ff3a
