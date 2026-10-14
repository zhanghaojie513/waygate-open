/**
 * 官网落地的**实测**校验器（CDP 驱动本机 Chromium，无新依赖）。
 *
 * 三种模式：
 *   compare  把 prototype/v4（视觉唯一准绳）与构建产物逐元素比对**计算样式**。
 *            比截图更硬：截图只能发现"看得出"的差异，计算样式能发现字重、
 *            背景色、透明链这种肉眼在深色底上根本看不出的偏差。
 *            比对时会用 Fetch 拦截把 `/healthz` 打桩成"在线"，
 *            否则官网会因为拿不到后端而进离线态（那是正确行为，但不可比）。
 *   assert   AC-01..AC-12 的行为断言 + 「按设计差异白名单」的**反证**
 *            （路由、场景约束、控制台无 --cam-*、色值等价、白名单可否证）。
 *   shot     截一张 1440×H 的图（大合成面会挂死，所以按 scrollY 分段截）。
 *
 * 用法（两个 URL 都要先在本地起静态服务）：
 *   node tools/verify-landing.mjs compare <protoUrl> <appUrl>
 *   node tools/verify-landing.mjs assert  <appUrl> <protoUrl>
 *   node tools/verify-landing.mjs shot    <url> <out.png> [motion] [scrollY] [height]
 *
 * ⚠️ 起 app 的静态服务时记得开 **SPA fallback**（无扩展名路径 → index.html），
 *    否则 `/console` `/foo` 会 404，AC-02 / 「未匹配 path → 官网」必假失败。
 *    `vite preview` 自带；自己拉的 http server 要手写。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(import.meta.dirname, '..');

/** 从改写后的控制台样式表里取出所有 `color-mix(in srgb, var(--T) P%, transparent)`。 */
function collectColorMixPairs() {
  const files = ['web/src/styles/app.css', 'web/src/styles/vendor/console-fx.css'];
  const seen = new Map();
  for (const rel of files) {
    const abs = resolve(REPO, rel);
    if (!existsSync(abs)) continue;
    const css = readFileSync(abs, 'utf8');
    for (const m of css.matchAll(/color-mix\(\s*in srgb\s*,\s*var\((--[a-z0-9-]+)\)\s*([0-9.]+)%\s*,\s*transparent\s*\)/g)) {
      seen.set(`${m[1]}|${m[2]}`, [m[1], parseFloat(m[2])]);
    }
  }
  return [...seen.values()];
}

const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/haiha/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const PROPS = [
  'display', 'position', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'letterSpacing', 'textTransform', 'color', 'backgroundColor', 'backgroundImage',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginBottom', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderRadius', 'width', 'height', 'opacity', 'transform', 'boxShadow',
  'gap', 'gridTemplateColumns', 'justifyContent', 'alignItems',
  'backdropFilter', 'mixBlendMode', 'filter', 'zIndex', 'overflowX', 'boxSizing',
  'flexDirection', 'flexWrap', 'textShadow', 'maskImage',
];

const SELECTORS = [
  '.nav', '.nav .brand', '.nav-links', '.nav-links a', '.pill-brand', '.nav .btn-sm',
  '.hero', '.hero .wrap', '.hero-badge', '.hero-badge .n', '.hero-h1', '.hero-sub',
  '.hero-acts .btn-primary', '.hero-acts .btn-ghost', '.trust',
  '.glass.access', '.access-h .eyebrow', '.access-url code', '.access-url .copy',
  '.access-note', '.kv', '.kv dt', '.kv dd',
  '.panel-wrap', '.winbar', '.winbar .wbtn', '.panel-code', '.cl', '.panel-code .k',
  '.panel-code .s', '.conn', '.conn .cname', '.conn .lat', '.panel-metrics .v',
  '.scroll-cue',
  '.strip', '.strip .wrap', '.strip .cap', '.logos', '.logos span', '.logos .cn',
  '#ways', '.split', '.split-l', '.split-l .eyebrow', '.split-l .idx',
  '.split-l .display-2', '.split-l p', '.linelist', '.linelist li', '.ll-ico',
  '.ll-tx b', '.ll-tx i',
  '#quickstart', '.sec-head', '.sec-head .display-2', '.sec-head .lead', '.steps',
  '.steps li', '.st-n', '.steps h3', '.cmd', '.term', '.term-bar', '.term-tag',
  '.term-body', '.tl', '.tl.out', '.tl.ok', '.tl .hl',
  '#clients', '.grid-3', '.cfg', '.cfg h3', '.cfg .sub', '.cfg .code',
  '.cfg .code .k', '.cfg .code .s', '.cfg .code .c', '.specbar', '.specbar .k',
  '.specbar .v',
  '#status', '#status .eyebrow', '.status-strip', '.status-strip .v',
  '.status-strip .v.live', '.status-strip .unit', '.status-strip .k',
  '#cta', '#cta .display-2', '.cmdbox', '.cmdbox .pr', '.note', '.acts',
  '.acts .btn-primary', '.acts .btn-ghost',
  '.footer', '.foot-top', '.foot-brand', '.foot-brand p', '.foot-brand .pill',
  '.foot-col', '.foot-col h5', '.foot-col a', '.foot-bar', '.foot-bar span',
  '.rail', '.rail a', '.rail a b', '.progress', '.progress i',
  '.num', '.grad-text', '.mk', '.landing', '.glass', '.glass-soft',
];

const probe = () => `(() => {
  const out = { meta: {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerHeight: window.innerHeight,
    docHeight: document.documentElement.scrollHeight,
    htmlClass: document.documentElement.className,
    landingOverflowX: document.querySelector('.landing') ? getComputedStyle(document.querySelector('.landing')).overflowX : null,
  }, items: {} };
  for (const sel of ${JSON.stringify(SELECTORS)}) {
    const el = document.querySelector(sel);
    if (!el) { out.items[sel] = null; continue; }
    const cs = getComputedStyle(el);
    const rec = {};
    for (const p of ${JSON.stringify(PROPS)}) rec[p] = cs[p];
    const r = el.getBoundingClientRect();
    rec.__rect = [Math.round(r.x), Math.round(r.y + window.pageYOffset), Math.round(r.width), Math.round(r.height)];
    out.items[sel] = rec;
  }
  return out;
})()`;

/* ---------- 数值宽容：同一份像素在两条渲染路径上会有 1/64px 级的舍入差 ---------- */
function nums(s) { return (s.match(/-?\d+(\.\d+)?/g) || []).map(Number); }
function sameValue(a, b) {
  if (a === b) return true;
  const px = /^-?\d+(\.\d+)?px$/;
  if (px.test(a) && px.test(b)) return Math.abs(parseFloat(a) - parseFloat(b)) <= 0.6;
  if (/^matrix/.test(a) && /^matrix/.test(b)) {
    const x = nums(a); const y = nums(b);
    return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= 0.02);
  }
  if (/^(rgba?|color)\(/.test(a) && /^(rgba?|color)\(/.test(b)) {
    const x = nums(a); const y = nums(b);
    if (x.length !== y.length) return false;
    /* 颜色通道：允许 1/255 的舍入（srgb 小数 ↔ 整数） */
    return x.every((v, i) => Math.abs(v - y[i]) <= (i < 3 ? 1.01 : 0.011));
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      const hs = this.handlers.get(m.method);
      if (hs) hs.forEach((h) => h(m.params));
    };
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id; this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r?.result?.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await delay(500);
    for (let i = 0; i < 40; i += 1) {
      if ((await this.eval('document.readyState')) === 'complete') break;
      await delay(150);
    }
    await this.eval('document.fonts && document.fonts.ready');
    await delay(700);
  }
}

/* Chrome 冷启动偶发失败（实测约 1/6：进程起来了，DevTools 端点却迟迟不注册，
   尤其在同时跑着别的东西的时候）。一次重试就能把这类环境抖动挡在门外 ——
   否则报出来的是一行跟根因无关的「端点未就绪」，白查半天。 */
async function launch(stubHealth, opts = {}) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await launchOnce(stubHealth, opts);
    } catch (err) {
      last = err;
      if (attempt < 2) await delay(800);
    }
  }
  throw last;
}

async function launchOnce(stubHealth, opts = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-verify-'));
  const port = 9600 + Math.floor(Math.random() * 300);
  const child = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,900', '--ignore-certificate-errors', 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
      }
    } catch { /* 还没起来 */ }
    if (!wsUrl) await delay(250);
  }
  if (!wsUrl) {
    child.kill('SIGKILL');   /* 别把半死的 Chrome 留给下一次尝试 */
    throw new Error(`Chrome DevTools 页面端点未就绪（15s 内未注册，端口 ${port}）—— CHROME_PATH=${CHROME}`);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  /* 冻住动效：既让比对确定（无动画中间帧），又顺带验证 AC-06 的静态构图。 */
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  /* 严重错误网：把 JS 异常与 error 级日志收集起来，最终断言为零。
     "连不上后端"（healthz / api / auth）是预期的离线态，不计入。 */
  const errors = [];
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    /* 只收 JS 层的问题：`source: 'network'` 的资源加载失败（连不上后端 / 404）
       是预期的离线态表现，不是代码缺陷；把它们算进来只会淹没真信号。 */
    if (e.level !== 'error' || e.source === 'network') return;
    errors.push(String(e.text || '').slice(0, 160));
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push(String(d.exception?.description || d.text || 'exception').slice(0, 160));
  });
  cdp.errors = errors;

  /* 网络记录：AC-04 要在「未登录访问官网」时确认没有发出任何需鉴权的 /api/*。 */
  const net = [];
  cdp.net = net;
  cdp.on('Network.requestWillBeSent', (p) => { if (p?.request?.url) net.push(p.request.url); });
  await cdp.send('Network.enable');

  if (stubHealth) {
    /* compare 模式的两处打桩，都是为了让比对**确定**：
       ① `/healthz` → 在线。官网的"离线态"是正确行为，但原型没有数据层，
          不打桩就永远在比两个不同状态。
       ② `fonts.googleapis.com` → 用我们**自托管**的那份 @font-face 顶掉外链。
          原型是就近加载 Google 字体；网络一抖就退回系统字体，整页高度会差十几像素
          （实测：同一份原型一次 4570px、一次 4554px），比对就开始报假差异。
          自托管的 430 个 woff2 就是当初从同一个 css2 查询串下载的，字节同源，
          把 URL 改指到本地预览服务即可得到与原链**等价且稳定**的字体环境。 */
    const origin = opts.appUrl ? new URL(opts.appUrl).origin : null;
    const localFonts = (() => {
      if (!origin) return null;
      const p = resolve(REPO, 'web/src/styles/vendor/fonts.css');
      if (!existsSync(p)) return null;
      return readFileSync(p, 'utf8').replace(/url\((['"]?)\/fonts\//g, (_m, q) => `url(${q}${origin}/fonts/`);
    })();
    const json = Buffer.from(JSON.stringify({ ok: true, version: '0.4.1' })).toString('base64');
    const FONT_DIR = resolve(REPO, 'web/dist/fonts');
    cdp.on('Fetch.requestPaused', (p) => {
      const url = p.request.url;
      const done = (payload) => cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, ...payload }).catch(() => undefined);
      const b64 = (b) => Buffer.from(b).toString('base64');
      if (url.includes('fonts.googleapis.com')) {
        if (!localFonts) return void done({ responseCode: 404, body: '' });
        return void done({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: b64(localFonts) });
      }
      if (url.includes('fonts.gstatic.com')) {
        return void done({ responseCode: 404, body: '' });   // 字体已改指本地，不该再出现
      }
      /* 原型页在 :8801，字体却指向 :4174 —— 跨源取字体需要 CORS，直接读盘返回更稳。
         （同时也会命中应用页自己的字体请求：同一批字节，顺带保证两边缓存状态一致。） */
      if (url.startsWith(`${origin}/fonts/`)) {
        const file = join(FONT_DIR, url.slice(`${origin}/fonts/`.length).split('?')[0]);
        if (!existsSync(file)) return void done({ responseCode: 404, body: '' });
        return void done({
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'font/woff2' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: b64(readFileSync(file)),
        });
      }
      return void done({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: json });
    });
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/healthz*', requestStage: 'Request' },
        { urlPattern: '*fonts.googleapis.com*', requestStage: 'Request' },
        { urlPattern: '*fonts.gstatic.com*', requestStage: 'Request' },
        ...(origin ? [{ urlPattern: `${origin}/fonts/*`, requestStage: 'Request' }] : []),
      ],
    });
  }
  return { cdp, child, ws };
}

async function collectAt(cdp, url, offsets) {
  const rows = [];
  await cdp.goto(url);
  for (const y of offsets) {
    await cdp.eval(`window.scrollTo(0, ${y})`);
    /* 先等两帧：`--scroll-p` / 相机机位都是 rAF 驱动的，而 headless 下 rAF 可能被降频，
       滚动处理偶尔会晚一拍 —— 直接量就会量到上一帧的旧值（实测千分之一概率的假差异）。
       双 rAF 保证至少一次完整布局，再给足 CSS 过渡（.scroll-cue 的 opacity 是
       写死的 200ms，reduced-motion 关不掉）的时间。 */
    await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await delay(900);
    rows.push({ y, data: await cdp.eval(probe()) });
  }
  return rows;
}

/* ---------- 按设计差异：原型是静态稿，构建产物是活的应用，两类差异无法消除 ----------
   只登记「有据可依」的两条，其余一律算真实偏差 —— 白名单越短，漏报越少。 */
const BY_DESIGN = [
  {
    re: /^\.landing :: 存在性 /,
    why: '官网根包裹层：原型把整页挂在 <body>，应用需要一个可加 .landing 前缀的元素（隔离控制台样式所必需）',
  },
  {
    re: /^\.hero-badge :: (width|rect\[w\]) ::/,
    why: '未登录时徽标叠加「（示例）」数据来源标记（诚实披露演示数据的代价）；连上后端后该标记消失、宽度即与原型一致',
  },
];

function byDesignReason(diff) {
  const body = diff.replace(/^\[y=\d+\] /, '');
  for (const b of BY_DESIGN) if (b.re.test(body)) return b.why;
  return null;
}

function compare(proto, app) {
  const real = [];
  const designed = [];
  const push = (d) => { const w = byDesignReason(d); (w ? designed : real).push(w ? `${d}  ⟵ ${w}` : d); };
  /* 页面级 meta：`landingOverflowX` 不是可比项（原型无 .landing 元素），
     它由 assert 模式的「粘性列可用」断言覆盖，这里不重复。 */
  for (let i = 0; i < proto.length; i += 1) {
    const y = proto[i].y;
    const a = proto[i].data;
    const b = app[i].data;
    for (const k of ['scrollWidth', 'clientWidth', 'docHeight']) {
      if (!sameValue(String(a.meta[k]), String(b.meta[k]))) push(`[y=${y}] meta.${k}: proto=${a.meta[k]} app=${b.meta[k]}`);
    }
    for (const sel of SELECTORS) {
      const ai = a.items[sel]; const bi = b.items[sel];
      if (!ai && !bi) continue;
      if (!ai || !bi) { push(`[y=${y}] ${sel} :: 存在性 proto=${!!ai} app=${!!bi}`); continue; }
      for (const p of PROPS) {
        if (!sameValue(ai[p], bi[p])) push(`[y=${y}] ${sel} :: ${p} :: proto(${ai[p]}) vs app(${bi[p]})`);
      }
      for (let n = 0; n < 4; n += 1) {
        if (Math.abs(ai.__rect[n] - bi.__rect[n]) > 1) {
          push(`[y=${y}] ${sel} :: rect[${['x', 'y', 'w', 'h'][n]}] :: proto(${ai.__rect[n]}) vs app(${bi.__rect[n]})`);
        }
      }
    }
  }
  return { real, designed };
}

/* 粘性判据用**自校准**扫描：在区块上下各外扩 200px 的范围内逐帧采样，
   统计「元素被吸在 top:124px」的滚动窗口有多宽。
   比「取一个 y 看它在不在视口里」可靠 —— 取点落在区块之外时元素本就该滚走。 */
function stickyScan(cdp) {
  return cdp.eval(`(() => {
    const el = document.querySelector('.split-l');
    const sec = document.querySelector('.split');
    if (!el || !sec) return { missing: true };
    const box = sec.getBoundingClientRect();
    const secTop = box.top + window.pageYOffset;
    const secH = box.height;
    const ys = [];
    for (let y = secTop - 200; y <= secTop + secH + 200; y += 40) ys.push(y);
    const samples = [];
    let i = 0;
    return new Promise((res) => {
      const step = () => {
        if (i >= ys.length) {
          const pinned = samples.filter((s) => Math.abs(s.top - 124) <= 3).map((s) => s.y);
          res({
            pos: getComputedStyle(el).position,
            secTop: Math.round(secTop), secH: Math.round(secH),
            pinnedSpan: pinned.length ? pinned[pinned.length - 1] - pinned[0] : 0,
            pinnedWindow: pinned.length,
            firstTop: Math.round(samples[0].top), lastTop: Math.round(samples[samples.length - 1].top),
          });
          return;
        }
        window.scrollTo(0, ys[i]);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          samples.push({ y: ys[i], top: el.getBoundingClientRect().top });
          i += 1; step();
        }));
      };
      step();
    });
  })()`);
}

async function assertMode(cdp, baseRaw, protoRaw) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  /* 基址去掉尾斜杠：否则 `base + '/console'` 变成 `//console`，
     会被路由判为未匹配而回落到官网 —— 那是测试脚手架自己造的假阳性。 */
  const base = baseRaw.replace(/\/+$/, '');

  await cdp.goto(base + '/');
  /* 目标不可达时 Chrome 会停在它自己的错误页上：`.landing` 根本不存在，
     下一句 getComputedStyle(null) 会抛一个跟根因毫无关系的 TypeError
     （实测踩过：预览服务没起来 → 只看到 "eval failed" + 一行 stack，白查十分钟）。
     先探一下页面到底渲染了没有，把根因直说出来。 */
  const up = await cdp.eval(`({
    title: document.title,
    root: (document.getElementById('root')?.childElementCount ?? -1),
  })`);
  if (up.root <= 0) {
    throw new Error(`目标不可达或未渲染：${base}/（title="${up.title}"，#root 子节点=${up.root}）—— 预览服务是否已启动？`);
  }
  const m = await cdp.eval('({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, hc:document.documentElement.className, ox:getComputedStyle(document.querySelector(".landing")).overflowX})');
  add('AC-05 无横向滚动', m.sw <= m.cw, `scrollWidth=${m.sw} clientWidth=${m.cw}`);
  add('AC-01 渲染官网', /landing/.test(m.hc), `html.class="${m.hc}"`);
  add('粘性列可用（.landing 不是滚动容器）', m.ox === 'visible', `.landing overflow-x=${m.ox}`);
  /* 粘性：自校准扫描，统计被吸住（top 恒为 124px）的滚动窗口宽度。 */
  const sticky = await stickyScan(cdp);
  const protoSticky = protoRaw ? await (async () => { await cdp.goto(protoRaw); return stickyScan(cdp); })() : null;
  const spanOk = !sticky.missing && sticky.pos === 'sticky' && sticky.pinnedSpan >= 200;
  const spanMatch = !protoSticky ? true : Math.abs(sticky.pinnedSpan - protoSticky.pinnedSpan) <= 60;
  add('AC-09b .split-l 粘性生效（存在 ≥200px 的吸附窗口）', spanOk,
    `app=${JSON.stringify(sticky)}` + (protoSticky ? ` proto.span=${protoSticky.pinnedSpan}` : ''));
  if (protoSticky) {
    add('AC-09b 粘性窗口与原型一致（±60px）', spanMatch,
      `app.span=${sticky.pinnedSpan} proto.span=${protoSticky.pinnedSpan} proto=${JSON.stringify(protoSticky)}`);
  }

  await cdp.goto(base + '/');
  const rig = await cdp.eval(`(() => {
    const el = document.querySelector('.rig'); if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const bad = ['opacity','filter','mixBlendMode','maskImage','clipPath','overflow'].filter((p) => {
      const v = cs[p];
      return v && v !== 'none' && v !== 'normal' && v !== 'visible' && v !== '1';
    });
    /* 三级链的判据是每一级都 preserve-3d（链条没被拍平），
       而不是「每一级都有 transform」：.stage 的旋转来自 CSS 动画 prism-turn，
       在 prefers-reduced-motion 下被正确地关掉（transform:none），这是保真行为。 */
    const g = (s) => { const e = document.querySelector(s); const k = getComputedStyle(e); return { ts: k.transformStyle, tf: k.transform }; };
    return { opacity: cs.opacity, bad, sceneReady: document.documentElement.getAttribute('data-scene-ready'),
      dust: document.querySelectorAll('.dust i').length, cams: document.querySelectorAll('[data-cam]').length,
      rig: g('.rig'), tilt: g('.tilt'), stage: g('.stage') };
  })()`);
  const chainOk = rig.rig && rig.tilt && rig.stage
    && [rig.rig.ts, rig.tilt.ts, rig.stage.ts].every((v) => v === 'preserve-3d');
  add('AC-07 .rig opacity===1', rig.opacity === '1', JSON.stringify({ opacity: rig.opacity, bad: rig.bad }));
  add('AC-07 .rig 无压平属性', rig.bad.length === 0, 'offenders=' + JSON.stringify(rig.bad));
  add('AC-07 三级变换链 preserve-3d（.rig→.tilt→.stage，连续未拍平）', chainOk,
    `transform-style=${JSON.stringify([rig.rig?.ts, rig.tilt?.ts, rig.stage?.ts])}`);
  add('场景就绪 + 相机/倾角有实际变换', rig.sceneReady === '1' && rig.dust === 30 && rig.cams === 8
    && rig.rig.tf !== 'none' && rig.tilt.tf !== 'none',
    `ready=${rig.sceneReady} dust=${rig.dust} cams=${rig.cams} rig=${String(rig.rig?.tf).slice(0, 20)} tilt=${String(rig.tilt?.tf).slice(0, 20)}`);

  /* 反向确认动画确实存在：恢复动效后 `.stage` 必须重新拿到 transform
     （否则 reduced-motion 那条 `animation:none` 只是掩盖了「动画本来就没生效」）。 */
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await delay(120);
  const stageLive = await cdp.eval(`getComputedStyle(document.querySelector('.stage')).transform`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  add('AC-06 关闭 reduced-motion 后 .stage 动画恢复（旋转真的存在）', stageLive !== 'none',
    `.stage transform=${String(stageLive).slice(0, 24)}`);

  await cdp.goto(base + '/');
  await cdp.eval(`document.querySelector('a[href="#ways"]').click()`);
  await delay(900);
  const anchor = await cdp.eval('({path:location.pathname, hash:location.hash, y:window.pageYOffset, landing:!!document.querySelector(".landing")})');
  add('AC-09 #ways 锚点生效', anchor.y > 100, JSON.stringify(anchor));
  add('AC-09 未触发控制台', anchor.landing && anchor.path === '/', JSON.stringify(anchor));

  /* AC-03：/#/overview → /console#/overview（先离开文档，确保是冷启动） */
  await cdp.goto(base + '/');
  await cdp.goto(base + '/#/overview');
  await delay(600);
  const legacy = await cdp.eval('({path:location.pathname, hash:location.hash})');
  add('AC-03 旧书签重定向', legacy.path === '/console' && legacy.hash === '#/overview', JSON.stringify(legacy));

  await cdp.goto(base + '/');
  await cdp.eval(`location.hash = '#/overview'`);
  await delay(1000);
  const sameDoc = await cdp.eval('({path:location.pathname, hash:location.hash})');
  add('AC-03b 同文档改 hash 也重定向', sameDoc.path === '/console' && sameDoc.hash === '#/overview', JSON.stringify(sameDoc));

  await cdp.goto(base + '/console');
  await delay(600);
  const consoleProbe = await cdp.eval(`(() => {
    const html = document.documentElement;
    /* ⚠️ 判据是**内联写值**，不是 getComputedStyle：tokens.css 用 @property
       注册了 --cam-*，未写值时 computed 会返回 initial-value（0px / 0deg），
       看上去像"被写了"。真正的约束是「控制台不得**写** --cam-*」。 */
    const inline = ['--cam-x','--cam-y','--cam-z','--cam-rx','--cam-ry','--cam-rz','--fog','--scene-dim','--scroll-p','--look-x','--look-y']
      .filter((k) => html.style.getPropertyValue(k) !== '');
    return {
      htmlClass: html.className,
      landing: !!document.querySelector('.landing'),
      login: !!document.querySelector('.login-card, .login-wrap, input[type="password"]'),
      scene: !!document.querySelector('.scene'),
      inlineCam: inline,
      sceneReady: html.getAttribute('data-scene-ready'),
      sidebar: !!document.querySelector('.sidebar'),
    };
  })()`);
  add('AC-02 未登录仅登录页', consoleProbe.login && !consoleProbe.landing, JSON.stringify(consoleProbe));
  add('控制台无 --cam-* 写入 + 无场景',
    consoleProbe.inlineCam.length === 0 && !consoleProbe.scene && !consoleProbe.sceneReady,
    JSON.stringify(consoleProbe));
  add('控制台未挂 relay-landing', !/relay-landing/.test(consoleProbe.htmlClass), `html.class="${consoleProbe.htmlClass}"`);

  await cdp.goto(base + '/foo');
  await delay(400);
  const foo = await cdp.eval('({landing:!!document.querySelector(".landing"), sidebar:!!document.querySelector(".sidebar")})');
  add('未匹配 path → 官网', foo.landing && !foo.sidebar, JSON.stringify(foo));

  await cdp.goto(base + '/');
  const font = await cdp.eval(`(() => {
    const el = document.querySelector('.hero-h1');
    const cs = getComputedStyle(el);
    const faces = [];
    for (const ss of document.styleSheets) {
      try { for (const r of ss.cssRules) if (r.constructor.name === 'CSSFontFaceRule') faces.push(r.style.getPropertyValue('src')); } catch {}
    }
    const local = faces.filter((s) => s.includes('/fonts/')).length;
    const remote = faces.filter((s) => /https?:\\/\\//.test(s)).length;
    return { family: cs.fontFamily, weight: cs.fontWeight, faces: faces.length, local, remote };
  })()`);
  add('字体自托管（无 CDN）', font.remote === 0 && font.local > 0, JSON.stringify(font));

  /* ---------- AC-10：`/` 与 `/console` 来回切，控制台视图状态不丢 ----------
     可观测的那一半是**读路径**：官网的「打开控制台」链接要带上 sessionStorage
     里记住的视图。先写入一个值再重载，看链接是否补上了 `#/xxx`。 */
  await cdp.goto(base + '/');
  await cdp.eval(`sessionStorage.setItem('relay.console.route', 'settings')`);
  await cdp.goto(base + '/');
  const hrefs = await cdp.eval(`(() => ({
    nav: document.querySelector('.nav a[href*="/console"]')?.getAttribute('href') ?? null,
    footerRequests: document.querySelector('.footer a[href*="/console"]')?.getAttribute('href') ?? null,
  }))()`);
  add('AC-10 官网「打开控制台」补上上次停留的视图', hrefs.nav === '/console#/settings', JSON.stringify(hrefs));
  add('AC-10 页脚显式目标不被 sessionStorage 覆盖', hrefs.footerRequests === '/console#/requests',
    `footer=${hrefs.footerRequests}`);

  /* ---------- AC-12：tokens-v2.css 退役后，控制台那几条被并入 app.css 的规则还在 ----------
     不靠"看着没坏"，直接取回构建后的 CSS 文本，断言规则与令牌化取值都在。 */
  const cssText = await cdp.eval(`fetch(document.querySelector('link[rel="stylesheet"]').href).then((r) => r.text())`);
  const cssHas = (re) => re.test(cssText);
  const ac12 = {
    cardLog: cssHas(/\.card\s*,\s*\.log\s*\{[^}]*background:\s*var\(--bg-surface-grad\)/),
    cardBorder: cssHas(/\.card\s*,\s*\.log\s*\{[^}]*border-color:\s*var\(--border-subtle\)/),
    brandEn: cssHas(/\.brand-en\s*\{[^}]*color:\s*var\(--text-faint\)/),
    topbar: cssHas(/\.topbar\s*\{[^}]*position:\s*sticky/),
    /* 并入时把 #7C5CFF / #35DCE8 改写成了令牌 —— 断言改写真的落进了产物。 */
    topbarTokenized: cssHas(/\.topbar h1:before\{[^}]*var\(--brand-450\)[^}]*var\(--brand-stop-2\)/),
  };
  add('AC-12 控制台并入规则齐全（.card/.log/.brand-en/.topbar）', Object.values(ac12).every(Boolean),
    JSON.stringify(ac12));

  /* ---------- AC-11 等价性：改写成 color-mix 后必须与原文 rgba **逐通道等价** ----------
     这是「沉默逻辑错误」的高发区：色值悄悄偏一点，编译过、能跑、没人发现。
     所以在真实浏览器里把每个 (令牌, 百分比) 组合分别以 color-mix 与实色渲染，
     比对通道与 alpha —— 等价性由浏览器引擎回答，不由我们的代数假设回答。 */
  const pairs = collectColorMixPairs();
  const mixProbe = await cdp.eval(`(() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px';
    document.body.appendChild(el);
    const out = [];
    for (const [tok, p] of ${JSON.stringify(pairs)}) {
      el.style.background = 'rgba(1,2,3,1)';
      el.style.background = 'color-mix(in srgb, var(' + tok + ') ' + p + '%, transparent)';
      const mixed = getComputedStyle(el).backgroundColor;
      el.style.background = 'rgba(1,2,3,1)';
      el.style.background = 'var(' + tok + ')';
      const solid = getComputedStyle(el).backgroundColor;
      out.push({ tok, p, mixed, solid });
    }
    el.remove();
    return out;
  })()`);
  /* Chromium 把 color-mix 的结果序列化成 `color(srgb r g b / a)`，通道是 0..1 的浮点；
     实色则序列化成 `rgb(62, 220, 255)`。归一化到 0..255 再比。 */
  const parse = (s) => {
    const n = (s.match(/[\d.]+/g) || []).map(Number);
    return /^color\(srgb/i.test(s) ? n.map((v, i) => (i < 3 ? v * 255 : v)) : n;
  };
  const badMix = mixProbe.filter((r) => {
    const m = parse(r.mixed); const c = parse(r.solid);
    if (m.length < 4 || c.length < 3) return true;
    if (Math.abs(m[3] - r.p / 100) > 0.005) return true;   // alpha 必须精确
    /* alpha=0 ⇒ 完全透明：通道不可观测（且 CSS 渐变按预乘插值，通道 ×0 后同样为 0）。
       浏览器在这里会把通道归一成 0，不是等价性被破坏。 */
    if (m[3] <= 0.001) return false;
    return !(Math.abs(m[0] - c[0]) <= 1 && Math.abs(m[1] - c[1]) <= 1 && Math.abs(m[2] - c[2]) <= 1);
  });
  add('AC-11 color-mix 改写与原文 rgba 逐通道等价', pairs.length > 0 && badMix.length === 0,
    `检查 ${pairs.length} 组（令牌×透明度）` + (badMix.length ? ` 不合格=${JSON.stringify(badMix.slice(0, 3))}` : ''));

  /* ---------- AC-04：未登录访问官网，不得发出任何需鉴权的 /api/* ----------
     只有 `/api/auth/session` 是「匿名也可调」的（未登录返回 authenticated:false）。
     `/healthz` 不是 /api/ 前缀，属公开探测，不在此列。 */
  await cdp.goto(base + '/');
  cdp.net.length = 0;
  await cdp.goto(base + '/');
  await delay(600);
  const apiCalls = cdp.net.filter((u) => /\/api\//.test(u)).map((u) => new URL(u).pathname);
  const authedCalls = apiCalls.filter((p) => p !== '/api/auth/session');
  add('AC-04 未登录不发需鉴权的 /api/*', authedCalls.length === 0,
    `全部 /api 调用=${JSON.stringify([...new Set(apiCalls)])} 越权=${JSON.stringify([...new Set(authedCalls)])}`);

  /* ---------- AC-08：/healthz 不可达时显示离线态，且页面其余部分照常可读 ----------
     断言环境（vite preview）本来就没有后端，/healthz 必然失败 —— 天然就是离线态。 */
  const offline = await cdp.eval(`(() => {
    const badge = document.querySelector('.hero-badge');
    const txt = badge ? badge.textContent.replace(/\\s+/g, ' ').trim() : null;
    return {
      badgeText: txt,
      offline: !!txt && /离线/.test(txt),
      h1: (document.querySelector('.hero-h1')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 18),
      sections: ['#ways', '#quickstart', '#clients', '#status', '#cta'].filter((s) => document.querySelector(s)).length,
      footer: !!document.querySelector('.footer'),
      docHeight: document.documentElement.scrollHeight,
    };
  })()`);
  add('AC-08 /healthz 不可达 → 离线态，且页面其余部分可读',
    offline.offline && offline.h1.length > 5 && offline.sections === 5 && offline.footer && offline.docHeight > 3000,
    JSON.stringify(offline));

  /* ---------- 按设计差异的**反证** ----------
     比对器放行了 21 处差异（.hero-badge 宽度 ×14、.landing 存在性 ×7）。
     白名单最容易变成"洗白"，所以这两条不靠说明、靠**否证**。 */

  /* ① .hero-badge：放行掉的那点宽度，必须能被"多出来的那段文本"精确解释。
     「（示例）」是应用侧额外的一个文本节点；徽标是 `display:inline-flex; gap:9px`，
     所以它同时带来 (a) 一段文字宽度、(b) 一个新的 flex 间隙。
     摘掉它以后宽度减少量 Δ 必须 ≈ 文字宽度 + gap —— 差额若另有来源
     （内边距 / 字号 / 字体偏了），放行就是在掩盖真实偏差。 */
  const badgeFix = await cdp.eval(`(() => {
    const b = document.querySelector('.hero-badge');
    if (!b) return { missing: true };
    const before = b.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(b).columnGap) || 0;
    /* 量那段文字宽度：探针必须 position:absolute —— 否则它会被当成 flex 子项，
       自己又引入一个 gap，量出来的就不是纯文字宽度了。
       不继承？不，它挂在徽标下，font-size / font-family / letter-spacing 全部照继承。 */
    const probe = document.createElement('span');
    probe.textContent = '（示例）';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    b.appendChild(probe);
    const textW = probe.getBoundingClientRect().width;
    probe.remove();
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let removed = false;
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t.nodeValue && t.nodeValue.includes('（示例）')) {
        t.nodeValue = t.nodeValue.replace('（示例）', '');
        removed = true;
      }
    }
    return {
      before: +before.toFixed(3),
      after: +b.getBoundingClientRect().width.toFixed(3),
      gap: +gap.toFixed(2),
      textW: +textW.toFixed(3),
      removed,
      residualText: b.textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  const delta = badgeFix.before - badgeFix.after;
  const explained = badgeFix.gap + badgeFix.textW;
  add('可否证①：徽标多出的宽度 = 「（示例）」文字宽度 + 它引入的 flex gap',
    !!badgeFix.removed && badgeFix.textW > 10 && Math.abs(delta - explained) <= 0.6,
    `Δ=${delta.toFixed(3)} 文字=${badgeFix.textW} gap=${badgeFix.gap} 合计=${explained.toFixed(3)}`
      + ` | 摘掉后文案="${badgeFix.residualText}"`);

  /* ② .landing：原型页里**根本没有**这个 class —— 不是"看起来没有"，是**源码级**否证。
     但它确实是个真实盒子，所以还得证明它**没干别的**：
       · 布局中性：无内边距 / 边框 / 外边距，宽度即视口宽 —— 不会作为独立盒子挪动子元素；
       · 唯一多做的一件事是**底色**：原型里这层底由 <body> 承担，应用里 <body> 被
         控制台共用，只能由包装层接管。所以直接和原型 <body> 的 computed 底色对齐。
     两条都成立，才叫「差异来自结构而非样式」。 */
  const protoHtml = readFileSync(resolve(REPO, 'relay-station-design/prototype/v4/index.html'), 'utf8');
  const protoHasLanding = [
    /class\s*=\s*"[^"]*\blanding\b/,
    /class\s*=\s*'[^']*\blanding\b/,
  ].some((re) => re.test(protoHtml));
  let protoBodyBg = null;
  if (protoRaw) {
    await cdp.goto(protoRaw);
    protoBodyBg = await cdp.eval('getComputedStyle(document.body).backgroundColor');
  }
  await cdp.goto(base + '/');
  const wrap = await cdp.eval(`(() => {
    const el = document.querySelector('.landing');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
      border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(' '),
      margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].join(' '),
      bg: cs.backgroundColor,
      w: Math.round(el.getBoundingClientRect().width),
      vw: document.documentElement.clientWidth,
    };
  })()`);
  const zeros = (v) => /^0px( 0px)*$/.test(String(v).trim());
  const wrapNeutral = !wrap.missing
    && zeros(wrap.pad) && zeros(wrap.border) && zeros(wrap.margin)
    && Math.abs(wrap.w - wrap.vw) <= 1;
  const bgCarried = !protoBodyBg || wrap.bg === protoBodyBg;
  add('可否证②：原型源码无 landing class，且应用侧 .landing 布局中性 + 只接管原型的 body 底色',
    !protoHasLanding && wrapNeutral && bgCarried,
    `原型源码含 landing class=${protoHasLanding} | 底色 proto.body=${protoBodyBg} app.landing=${wrap?.bg} | 包裹层=${JSON.stringify(wrap)}`);

  /* ---------- 严重错误网：整轮断言跑完，JS 异常与 error 级日志必须为零 ---------- */
  add('无 JS 异常 / 无 error 级日志（离线态网络错误除外）', cdp.errors.length === 0,
    cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 4)) : 'clean');

  return checks;
}

async function shotMode(cdp, url, out, { withMotion, scrollY, height }) {
  const dbg = (s) => { if (process.env.SHOT_DEBUG) console.error('[shot] ' + s); };
  if (withMotion) await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await cdp.goto(url);
  dbg('navigated');
  /* 视口固定 1440×H（默认 1080）：本机 Chromium 在超大合成面（如 1440×4570）上
     captureScreenshot 会挂死不返回，所以不追求「一张整页图」，改为按需分段截。
     需要看哪一段就传 scrollY。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false });
  if (scrollY) { await cdp.eval(`window.scrollTo(0, ${scrollY})`); await delay(600); }
  await delay(300);
  const shot = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    delay(20000).then(() => { throw new Error('captureScreenshot 超时（20s）'); }),
  ]);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), Buffer.from(shot.data, 'base64'));
  const kb = Math.round(Buffer.from(shot.data, 'base64').length / 1024);
  const total = Math.round((await cdp.eval('document.documentElement.scrollHeight')));
  console.log(`✓ ${basename(out)}  ${url}  视口 1440×${height}  scrollY=${scrollY}（整页高 ${total}）`
    + `${withMotion ? '  动效开启' : '  reduced-motion（AC-06 静态构图）'}  ${kb} KB`);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const { cdp, child, ws } = await launch(mode === 'compare', { appUrl: mode === 'compare' ? args[1] : args[0] });
  try {
    if (mode === 'shot') {
      const [url, out, motionArg, yArg, hArg] = args;
      await shotMode(cdp, url, out, {
        withMotion: motionArg === 'motion',
        scrollY: Number(yArg) || 0,
        height: Number(hArg) || 1080,
      });
    } else if (mode === 'compare') {
      const [protoUrl, appUrl] = args;
      const offsets = [0, 900, 1800, 2700, 3600, 4500, 5400];
      const proto = await collectAt(cdp, protoUrl, offsets);
      const app = await collectAt(cdp, appUrl, offsets);
      const { real, designed } = compare(proto, app);
      const total = SELECTORS.length * PROPS.length * offsets.length;
      console.log(`比对：${SELECTORS.length} 选择器 × ${PROPS.length} 属性 × ${offsets.length} 滚动位 = ${total} 个取值`);
      const summary = (list) => {
        const seen = new Map();
        for (const d of list) { const key = d.replace(/^\[y=\d+\] /, ''); seen.set(key, (seen.get(key) || 0) + 1); }
        return [...seen.entries()];
      };
      if (designed.length) {
        console.log(`\n· 按设计差异 ${designed.length} 处（不计入判定）：`);
        for (const [k, n] of summary(designed)) console.log(`   ×${n}  ${k}`);
      }
      if (!real.length) console.log('\n✅ 计算样式与原型一致（除上述按设计差异）');
      else if (process.env.VERBOSE) {
        console.log(`\n⛔ 真实差异 ${real.length} 处（原始清单）：`);
        for (const d of real) console.log('   ' + d);
      } else {
        console.log(`\n⛔ 真实差异 ${real.length} 处（${summary(real).length} 个唯一）：`);
        for (const [k, n] of summary(real)) console.log(`   ×${n}  ${k}`);
      }
      process.exitCode = real.length ? 1 : 0;
    } else {
      const checks = await assertMode(cdp, args[0], args[1]);
      for (const c of checks) console.log(`${c.pass ? '✅' : '⛔'} ${c.name} — ${c.detail}`);
      process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
    }
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { ws.terminate?.(); } catch { /* ignore */ }
    child.kill('SIGKILL');
    await delay(250);
  }
  /* 先把 stdout 冲干净，再硬退出。
     两个坑要同时避开：
       · 直接 `process.exit()` → Windows 上管道/重定向的输出会被截断（实测 0 字节）；
       · 完全不 `process.exit()` → Chrome 子进程偶尔留句柄，事件循环不收尾，脚本挂死。
     `write('', cb)` 的回调排在所有先前写入之后 ⇒ 它触发即代表已 flush。 */
  await new Promise((r) => process.stdout.write('', r));
  process.exit(process.exitCode ?? 0);
}

main().catch(async (err) => {
  console.error(err);
  await new Promise((r) => process.stdout.write('', r));
  process.exit(2);
});
