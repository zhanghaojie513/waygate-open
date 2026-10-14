/* eslint-disable */
// @ts-nocheck
/* ==========================================================================
   Waygate — 页面行为 v4 (page)     —— 自 prototype/v4/page.js 移植
   ==========================================================================

   移植说明（唯一改动）：
     原型是 IIFE，在 DOMContentLoaded 自启；这里导出 initPage() / 返回 destroy，
     由 React 在 useEffect 里挂载/卸载。**内部算法逐行保留**。

   只管内容层，不碰场景（场景归 scene）：
     ① 滚动揭示        IntersectionObserver，一次触发即解绑
     ② 顶栏玻璃态      只在滚离首屏后加底
     ③ 章节轨高亮      以视口 42% 处为判读线
     ④ 数字滚动 / 打字  respect prefers-reduced-motion
   ========================================================================== */
export function initPage() {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var alive = true;
  var timers = [];
  var observers = [];

  /* 0 · 演示数字接线 -------------------------------------------------------
     原型从 window.RelayDemo 读数字并与页面兜底值对账。
     React 版里数字由 LandingPage 直接渲染（同一批数字的唯一出处在前端数据层），
     不挂 window.RelayDemo —— 因此本函数会**原样保留**但直接返回，不产生副作用。
     （保留而非删除：原型逻辑与 `data-demo` 字段名仍留在 DOM 上，便于将来复用。） */
  var DEMO_LABEL = {
    totalTokens: '本窗口 tokens',
    cacheHitRate: '缓存命中率',
    requestsToday: '今日请求',
    successRate: '今日成功率'
  };

  function seedDemoNumbers() {
    var D = window.RelayDemo;
    if (!D || !D.summary) return;
    var mismatch = [];
    [].forEach.call(document.querySelectorAll('[data-demo]'), function (el) {
      var key = el.getAttribute('data-demo');
      var v = D.summary[key];
      if (typeof v !== 'number') return;
      var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
      var shown = el.textContent.trim().replace(/,/g, '');
      if (shown !== '' && Math.abs(parseFloat(shown) - v) > Math.pow(10, -dec) / 2) {
        mismatch.push((DEMO_LABEL[key] || key) + '：页面上写的 ' + shown + '，数据层是 ' + v);
      }
      el.setAttribute('data-count', v);
      el.textContent = group(v, dec);
    });
    if (mismatch.length && window.console) {
      console.warn('[page] 首页演示数字与 demo-data 不一致（已按数据层显示）：\n  · ' + mismatch.join('\n  · '));
    }
  }

  function rafThrottle(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }

  /* ① 滚动揭示 */
  function initReveal() {
    var items = [].slice.call(document.querySelectorAll('.reveal'));
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('in'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    observers.push(io);

    items.forEach(function (el) { io.observe(el); });
  }

  /* ② 顶栏玻璃态 */
  var nav = document.querySelector('.nav');
  function syncNav() {
    if (!nav) return;
    nav.classList.toggle('stuck', window.pageYOffset > 28);
  }

  /* ③ 章节轨 */
  var railLinks = [].slice.call(document.querySelectorAll('.rail a'));
  var railTargets = railLinks.map(function (a) {
    return document.querySelector(a.getAttribute('href'));
  });

  function syncRail() {
    if (!railLinks.length) return;
    var line = window.pageYOffset + window.innerHeight * 0.42;
    var active = 0;
    for (var i = 0; i < railTargets.length; i += 1) {
      var el = railTargets[i];
      if (el && el.offsetTop <= line) active = i;
    }
    for (var j = 0; j < railLinks.length; j += 1) {
      railLinks[j].classList.toggle('on', j === active);
    }
  }

  /* ④a 数字滚动 */
  function group(n, dec) {
    var parts = n.toFixed(dec).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function countUp(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    if (isNaN(target)) return;
    var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
    var dur = 1500;
    var t0 = 0;

    function step(ts) {
      if (!alive) return;
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = group(target * e, dec);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = group(target, dec);
    }
    requestAnimationFrame(step);
  }

  function initCounters() {
    var nums = [].slice.call(document.querySelectorAll('[data-count]'));
    if (!nums.length) return;

    if (reduce || !('IntersectionObserver' in window)) {
      nums.forEach(function (el) {
        var t = parseFloat(el.getAttribute('data-count'));
        var d = parseInt(el.getAttribute('data-dec') || '0', 10);
        if (!isNaN(t)) el.textContent = group(t, d);
      });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        countUp(e.target);
        io.unobserve(e.target);
      });
    }, { threshold: 0.6 });
    observers.push(io);

    nums.forEach(function (el) { io.observe(el); });
  }

  /* ④b 打字机 */
  function initTyping() {
    var nodes = [].slice.call(document.querySelectorAll('[data-type]'));
    if (!nodes.length || reduce || !('IntersectionObserver' in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        io.unobserve(el);
        var text = el.getAttribute('data-type');
        var i = 0;
        el.textContent = '';
        el.classList.add('typing');
        (function tick() {
          if (!alive) return;
          if (i > text.length) { el.classList.remove('typing'); return; }
          el.textContent = text.slice(0, i);
          i += 1;
          timers.push(window.setTimeout(tick, 34));
        })();
      });
    }, { threshold: 0.8 });
    observers.push(io);

    nodes.forEach(function (el) { io.observe(el); });
  }

  /* 启动 */
  var onScroll = rafThrottle(function () { syncNav(); syncRail(); });
  var onResize = rafThrottle(function () { syncRail(); });
  var onLoad = function () { syncNav(); syncRail(); };

  seedDemoNumbers();
  initReveal();
  initCounters();
  initTyping();
  syncNav();
  syncRail();

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('load', onLoad);

  return function destroy() {
    alive = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('load', onLoad);
    observers.forEach(function (io) { io.disconnect(); });
    timers.forEach(function (t) { clearTimeout(t); });
    observers = [];
    timers = [];
  };
}
// @zbiti-ai:f:220:1bf29b58
