import { useEffect } from 'react';
import { mountScene } from './scene';
import { SceneLayer } from './SceneLayer';

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
 * 场景挂在页面根下，故 host 传 `document`（即 §4.2 的 `mountScene(root)`）。
 */
export function ScenePrism() {
  useEffect(() => mountScene(document), []);
  return <SceneLayer />;
}
// @zbiti-ai:f:22:3e2cfcbe
