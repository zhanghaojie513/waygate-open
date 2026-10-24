import { useEffect } from 'react';
import { mountScene } from './scene';
import { SceneLayer } from './SceneLayer';
/* [2026-10-17 修复] scene.css 原本只被 LandingPage.tsx 导入——登录页引
   ScenePrism 时 DOM 挂了但样式没跟（.pl 背景为透明）。CSS 导入移到这里：
   ScenePrism 是「宿主」组件，谁引它谁就得到场景的完整样式（DOM+CSS+引擎）。 */
import './scene.css';

/**
 * 场景层宿主（Spec §4.2 约定的挂载点）。
 *
 * 为什么单独成一个组件，而不是把挂载塞进 LandingPage：
 *   · `scene.ts` 是**命令式**引擎（星尘 + 运镜），重写成声明式只会引入偏差 ——
 *     所以 DOM 仍旧由 `SceneLayer` 静态渲染，引擎只在 `useEffect` 里挂载。
 *   · 这样 `SceneLayer` 能保持"哑"组件（只画 DOM、不做逻辑），
 *     而"渲染什么"与"挂载什么"两件事各自只有一处。
 *   · StrictMode 会双跑 effect：`mountScene` 内部可重入且返回完整 cleanup
 *     （rAF / scroll·resize·pointer 监听 / 注入的星尘节点都会回收），
 *     所以这里只需把 cleanup 原样交还 React。
 *
 * [v5] 新增 `variant`：
 *   · `'inline'`（默认）—— 装置是 Hero 右栏里的一个盒子。**不挂载引擎**：
 *     滚动运镜整套已随全屏背景一起退役（见 scene.ts 头注释），
 *     而星尘在浅底上也不可见（白点在暖白上等于没有）。
 *     这里的组件因此退化成纯 DOM 渲染 —— 装置的自转/掠光全由 CSS 承担。
 *   · `'fixed'` —— 保留旧的全屏背景语义（挂载引擎）。当前无消费方，
 *     留作回退口：如果日后要恢复滚动运镜，把 variant 改回来即可。
 */
export function ScenePrism({ variant = 'inline' }: { variant?: 'inline' | 'fixed' }) {
  useEffect(() => {
    if (variant !== 'fixed') return;
    return mountScene(document);
  }, [variant]);

  return <SceneLayer />;
}
