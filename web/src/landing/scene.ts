/* eslint-disable */
// @ts-nocheck
/* ==========================================================================
   Waygate — 场景引擎 v4 (scene)     —— 自 prototype/v4/scene.js 移植
   ==========================================================================

   移植说明（唯一改动）：
     原型是一个立即执行的 IIFE，在 DOMContentLoaded 时自启；
     这里改成导出 `mountScene(host)`，返回 cleanup，由 React 在 useEffect
     （挂载/卸载）里调用（Spec §4.2 的约定签名）。**内部算法逐行保留**，
     没有重写成 React —— 星尘与运镜是命令式的，重写成声明式只会引入偏差。

     三件副作用需要显式回收，否则切到 /console 再切回来会叠加：
       · scroll / resize / load / pointermove 监听
       · 还在追目标的 rAF
       · 注入到 .dust 里的星尘节点

   两件事，仅此两件：
     ① 生成星尘（固定种子）
     ② 把滚动位置映射成相机机位，带阻尼地写进 CSS 变量

   设计意图：机位**不是**按整页百分比硬编码的，而是从 DOM 里
   `[data-cam]` 区块的**实际位置**读出来的。这样加一段文案、改一张卡片，
   相机关键帧会自动跟着走。
   ========================================================================== */
export function mountScene(host) {
  'use strict';

  /* Spec §4.2 的签名是 mountScene(root)。场景 DOM 挂在页面根下，
     默认 host = document；传进来的是元素时，`[data-cam]` / `.dust` 的查询
     收窄到该子树内，便于将来把官网嵌进别的容器而不误伤全局。 */
  var scope = (host && typeof host.querySelectorAll === 'function') ? host : document;

  var root = document.documentElement;

  /* :root 变量写入去重。往 :root 写自定义属性会让整棵文档的样式失效重算，
     而阻尼动画每帧要写 8 个机位变量 + 视线/滚动变量，其中大部分帧里多数值格式化后
     并没有变化（如 rx/rz 长期为 0、收敛末段的 write(target) 与上一帧相同）。
     只在字符串值真正改变时才 setProperty。 */
  var written = {};
  function setVar(name, value) {
    if (written[name] === value) return;
    written[name] = value;
    root.style.setProperty(name, value);
  }
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var alive = true;

  /* ------------------------------------------------------------------ *
   * 0 · 机位参数与默认值
   * ------------------------------------------------------------------ */
  var KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'fog', 'dim'];
  var DEFAULTS = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, fog: 0.18, dim: 1 };
  var UNIT = { x: 'px', y: 'px', z: 'px', rx: 'deg', ry: 'deg', rz: 'deg' };
  var VARNAME = {
    x: '--cam-x', y: '--cam-y', z: '--cam-z',
    rx: '--cam-rx', ry: '--cam-ry', rz: '--cam-rz',
    fog: '--fog', dim: '--scene-dim'
  };

  /* ------------------------------------------------------------------ *
   * 1 · 星尘（固定种子 —— 每次刷新的星图必须完全一致）
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

  /* ------------------------------------------------------------------ *
   * 2 · 关键帧：从 DOM 读，不硬编码
   * ------------------------------------------------------------------ */
  var keys = [];

  function anchorOf(el) {
    var r = el.getBoundingClientRect();
    return r.top + window.pageYOffset + r.height / 2;
  }

  function readKeys() {
    var nodes = [].slice.call(scope.querySelectorAll('[data-cam]'));
    keys = nodes.map(function (el) {
      var cam = {};
      var raw = el.getAttribute('data-cam');
      if (raw) {
        try { cam = JSON.parse(raw); } catch (e) {
          console.warn('[scene] data-cam 不是合法 JSON，已忽略：', el, raw);
          cam = {};
        }
      }
      return { at: anchorOf(el), cam: cam };
    });
    keys.sort(function (a, b) { return a.at - b.at; });
  }

  /* ------------------------------------------------------------------ *
   * 3 · 插值
   * ------------------------------------------------------------------ */
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function sample(s) {
    if (!keys.length) return Object.assign({}, DEFAULTS);

    var i = 0;
    while (i < keys.length - 1 && s > keys[i + 1].at) i += 1;

    var a = keys[i];
    var b = keys[i + 1];

    var t;
    if (!b) t = 1;
    else if (s <= a.at) t = 0;
    else t = (s - a.at) / (b.at - a.at);
    t = Math.max(0, Math.min(1, t));
    var e = easeInOut(t);

    var out = {};
    for (var k = 0; k < KEYS.length; k += 1) {
      var key = KEYS[k];
      var av = a.cam[key] !== undefined ? a.cam[key] : DEFAULTS[key];
      var bv = (b && b.cam[key] !== undefined) ? b.cam[key] : av;
      out[key] = av + (bv - av) * e;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 4 · 阻尼 + 写入
   * ------------------------------------------------------------------ */
  var TAU = 0.16;
  var cur = null;
  var target = null;
  var lastTs = 0;
  var rafId = 0;

  function write(v) {
    for (var k = 0; k < KEYS.length; k += 1) {
      var key = KEYS[k];
      var u = UNIT[key] || '';
      setVar(VARNAME[key], v[key].toFixed(3) + u);
    }
  }

  function frame(ts) {
    var dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.12) : 0.016;
    lastTs = ts;

    if (!cur) cur = Object.assign({}, target);

    var k = reduceMotion ? 1 : 1 - Math.exp(-dt / TAU);
    var settled = true;

    for (var i = 0; i < KEYS.length; i += 1) {
      var key = KEYS[i];
      var d = target[key] - cur[key];
      cur[key] += d * k;
      var eps = Math.max(0.0015, Math.abs(target[key]) * 0.0012);
      if (Math.abs(d) > eps) settled = false;
    }

    write(cur);

    if (settled) {
      cur = Object.assign({}, target);
      write(target);
      rafId = 0;
      lastTs = 0;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function kick() {
    if (!rafId) {
      lastTs = 0;
      rafId = requestAnimationFrame(frame);
    }
  }

  function update() {
    if (!alive) return;
    var doc = document.documentElement;
    var max = Math.max(1, doc.scrollHeight - window.innerHeight);
    setVar('--scroll-p', (window.pageYOffset / max).toFixed(4));
    target = sample(window.pageYOffset + window.innerHeight / 2);
    kick();
  }

  /* ------------------------------------------------------------------ *
   * 5 · 视线：指针 → --look-x / --look-y
   * ------------------------------------------------------------------ */
  var look = { tx: 0, ty: 0, x: 0, y: 0 };
  var lookRaf = 0;
  var lookLast = 0;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function writeLook() {
    setVar('--look-x', look.x.toFixed(4));
    setVar('--look-y', look.y.toFixed(4));
  }

  function lookFrame(ts) {
    var dt = lookLast ? Math.min((ts - lookLast) / 1000, 0.12) : 0.016;
    lookLast = ts;
    var k = 1 - Math.exp(-dt / TAU);

    look.x += (look.tx - look.x) * k;
    look.y += (look.ty - look.y) * k;
    writeLook();

    if (Math.abs(look.tx - look.x) > 0.0008 || Math.abs(look.ty - look.y) > 0.0008) {
      lookRaf = requestAnimationFrame(lookFrame);
    } else {
      look.x = look.tx; look.y = look.ty;
      writeLook();
      lookRaf = 0; lookLast = 0;
    }
  }

  function onPointerMove(e) {
    if (document.hidden) return;
    look.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    look.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    if (!lookRaf) { lookLast = 0; lookRaf = requestAnimationFrame(lookFrame); }
  }

  function onPointerLeave() {
    look.tx = 0; look.ty = 0;
    if (!lookRaf) { lookLast = 0; lookRaf = requestAnimationFrame(lookFrame); }
  }

  function initLook() {
    if (reduceMotion || !finePointer) return;
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave);
  }

  /* ------------------------------------------------------------------ *
   * 6 · 启动 / 回收
   * ------------------------------------------------------------------ */
  var onScroll = null;
  var onResize = null;
  var onLoad = null;
  var fontsReady = null;

  function boot() {
    buildDust();
    readKeys();

    if (!keys.length) {
      /* 没有关键帧 = 本页不由滚动驱动相机。除了星尘，什么都不碰。 */
      root.setAttribute('data-scene-ready', 'static');
      return;
    }

    update();
    initLook();

    var ticking = false;
    onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        update();
      });
    };
    onResize = function () {
      if (!alive) return;
      readKeys();
      update();
    };
    onLoad = function () {
      if (!alive) return;
      readKeys();
      update();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('load', onLoad);

    if (document.fonts && document.fonts.ready) {
      fontsReady = document.fonts.ready.then(function () {
        if (!alive) return;
        readKeys();
        update();
      });
    }

    root.setAttribute('data-scene-ready', '1');
  }

  function destroy() {
    alive = false;
    if (onScroll) window.removeEventListener('scroll', onScroll);
    if (onResize) window.removeEventListener('resize', onResize);
    if (onLoad) window.removeEventListener('load', onLoad);
    window.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', onPointerLeave);
    if (rafId) cancelAnimationFrame(rafId);
    if (lookRaf) cancelAnimationFrame(lookRaf);
    rafId = 0; lookRaf = 0;
    /* 星尘节点随 .scene 一起被 React 卸载；这里再清一次幂等。 */
    [].slice.call(scope.querySelectorAll('.dust')).forEach(function (h) { h.innerHTML = ''; });
    /* 把写进 :root 的相机变量复位，避免切到控制台后残留 */
    Object.keys(VARNAME).forEach(function (k) { root.style.removeProperty(VARNAME[k]); });
    root.style.removeProperty('--scroll-p');
    root.style.removeProperty('--look-x');
    root.style.removeProperty('--look-y');
    written = {}; // 变量已移除：清空去重缓存，重新挂载时能重新写入
    root.removeAttribute('data-scene-ready');
  }

  boot();
  return destroy;
}
// @zbiti-ai:f:339:7b88b6e9
