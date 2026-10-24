/* eslint-disable */
// @ts-nocheck
/* ==========================================================================
   Waygate — 场景引擎 (scene)  —— 精简版
   ==========================================================================

   [v5] 装置从「全屏固定背景 + 滚动运镜」改为「Hero 右栏的局部盒子」之后，
   这个文件里**唯一还需要存在的东西**是星尘生成（固定种子）。

   退役的整套功能（约 150 行）与退役理由：
     · readKeys / sample / write —— 读出 10 个 `[data-cam]` 区块的实际位置、
       插值成相机机位。装置不在全屏了，就没有「每一屏都要重新构图」这回事，
       `data-cam` 属性已从所有 section 移除。
     · writeLook / onPointerMove / initLook —— 鼠标驱动的视线视差。
       局部盒子里做视差会读成「装置在抖」，而不是「相机在动」。
     · frame / kick / update —— 上面两套的阻尼动画循环。
     · fog / dim 变量写入 —— 只被 .dimmer / .fog 消费，而浅底上这两层
       已经 display:none（往白里压暗/加雾，浅底无意义）。

   **保留 mountScene 签名**：ScenePrism 仍按 `mountScene(host)` 调用，
   传 'fixed' variant 时它仍会挂载（当前无消费方，留作回退口）。

   要恢复滚动运镜：从 git 历史取回本文件 v5 之前的版本，
   把 Hero 的 `ScenePrism variant` 改回 `'fixed'`，各 section 的
   `data-cam` 属性一起恢复。
   ========================================================================== */

export function mountScene(host) {
  'use strict';

  /* 默认 host = document；传元素时把查询收窄到子树内，便于把官网
     嵌进别的容器而不误伤全局（Spec §4.2 的约定）。 */
  var scope = (host && typeof host.querySelectorAll === 'function') ? host : document;

  /* ------------------------------------------------------------------ *
   * 星尘：固定种子 —— 每次刷新的星图必须完全一致
   * ------------------------------------------------------------------ */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var LAYERS = [
    { sel: '.dust.d3', count: 14, min: 0.9, max: 1.5, seed: 20261004 },
    { sel: '.dust.d2', count: 10, min: 1.3, max: 2.0, seed: 77110203 },
    { sel: '.dust.d1', count: 6,  min: 1.8, max: 2.8, seed: 31415926 }
  ];

  function buildDust() {
    LAYERS.forEach(function (layer) {
      var hosts = scope.querySelectorAll(layer.sel);
      for (var h = 0; h < hosts.length; h += 1) {
        /* 多实例是这一层的正常用法：重入时先清空，避免叠两遍。 */
        hosts[h].innerHTML = '';
        var rnd = mulberry32(layer.seed);
        var frag = document.createDocumentFragment();
        for (var i = 0; i < layer.count; i += 1) {
          var d = document.createElement('i');
          var size = layer.min + rnd() * (layer.max - layer.min);
          d.style.left = (rnd() * 100).toFixed(2) + '%';
          d.style.top = (rnd() * 100).toFixed(2) + '%';
          d.style.width = size.toFixed(2) + 'px';
          d.style.height = size.toFixed(2) + 'px';
          d.style.animationDelay = (rnd() * 3200).toFixed(0) + 'ms';
          frag.appendChild(d);
        }
        hosts[h].appendChild(frag);
      }
    });
  }

  buildDust();

  /* 没有监听器、没有 rAF，cleanup 只需收回注入的星尘节点，
     保持与旧版相同的「可重入 + 可卸载」契约（StrictMode 会双跑 effect）。 */
  return function destroy() {
    LAYERS.forEach(function (layer) {
      var hosts = scope.querySelectorAll(layer.sel);
      for (var h = 0; h < hosts.length; h += 1) hosts[h].innerHTML = '';
    });
  };
}
