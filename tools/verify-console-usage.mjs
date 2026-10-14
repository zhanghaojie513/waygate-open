/**
 * 「积分与用量」视图 + 概览瘦身的实测校验器（CDP 驱动本机 Chromium，无新依赖）。
 *
 * 用法：
 *   node tools/verify-console-usage.mjs <consoleUrl> [password] [outDir]
 * 例（Mock 模式的 dev server；注意 vite dev 只监听 ::1，要用 localhost）：
 *   npm run dev:mock -- --port 5188
 *   node tools/verify-console-usage.mjs http://localhost:5188 relay-dev
 *
 * 覆盖 AC-U01..AC-U11（AC-U07/U08/U11 是静态纪律，见 tools/check-color-literals.mjs
 * 与底部的静态检查段），外加一条 Mock 数据自洽断言：
 * **页面上「近 30 天消耗 = Σ按模型 = Σ按客户端」三处必须相等**（design-spec §18.8 硬规则）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(import.meta.dirname, '..');
const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/haiha/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : r(m.result); return;
      }
      const hs = this.handlers.get(m.method); if (hs) hs.forEach((h) => h(m.params));
    };
  }
  on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
  send(m, p = {}) {
    return new Promise((r, j) => { const id = ++this.id; this.pending.set(id, { resolve: r, reject: j }); this.ws.send(JSON.stringify({ id, method: m, params: p })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r?.result?.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url }); await delay(400);
    for (let i = 0; i < 40; i += 1) { if ((await this.eval('document.readyState')) === 'complete') break; await delay(150); }
    await delay(600);
  }
}

/* 页面里到处要用的两个小工具，注入成一次性的全局函数，省得每个 eval 里重写。 */
const HELPERS = `
window.__t = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\\s+/g, ' ').trim();
window.__byLabel = (rootSel, label) => {
  for (const el of document.querySelectorAll(rootSel)) {
    const lb = el.querySelector('.lb');
    if (lb && lb.textContent.trim() === label) return el;
  }
  return null;
};
window.__bars = () => [...document.querySelectorAll('.bars30 .b')].map((b) => ({
  /* [2026-10-08] 图表在 task#54 用**自绘浮层**替代了原生 title，文字搬到了 aria-label。
     校验器还在读 title，于是 expectedHeights 永远拿不到值（返回 null）、
     AC-U03 恒定失败 —— 而它失败的样子和"柱高真的不对"一模一样。
     两个都读：title 留着兼容，aria-label 是现在真正承载文案的那个。 */
  title: b.getAttribute('aria-label') || b.getAttribute('title') || '',
  h: parseFloat(b.style.height) || 0,
}));
true;
`;

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-usage-'));
  const port = 9200 + Math.floor(Math.random() * 300);
  const child = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
      }
    } catch { /* 还没起来 */ }
    if (!wsUrl) await delay(250);
  }
  if (!wsUrl) { child.kill('SIGKILL'); throw new Error(`Chrome DevTools 端点未就绪（端口 ${port}）`); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  cdp.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (e.level === 'error' && e.source !== 'network') cdp.errors.push(String(e.text || '').slice(0, 180)); });
  cdp.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails || {}; cdp.errors.push(String(d.exception?.description || d.text || 'x').slice(0, 180)); });
  return { cdp, child, ws };
}

/** `.bars30` 的柱子高度 = round(max(2, v / max * 100))，v 由 title 里的两个数给出。 */
function expectedHeights(bars, field) {
  const values = bars.map((b) => {
    const m = /(\d[\d,]*)\s*次请求\s*·\s*([\d,.]+)\s*积分/.exec(b.title);
    if (!m) return null;
    return field === 'requests' ? Number(m[1].replace(/,/g, '')) : Number(m[2].replace(/,/g, ''));
  });
  if (values.some((v) => v === null)) return null;
  const max = Math.max(1, ...values);
  return values.map((v) => Math.max(2, Math.round((v / max) * 100)));
}

function near(a, b, tol = 0.6) { return Math.abs(a - b) <= tol; }

async function main() {
  const [urlArg, pwArg, outArg] = process.argv.slice(2);
  const BASE = (urlArg ?? 'http://localhost:5188').replace(/\/+$/, '');
  const PW = pwArg ?? 'relay-dev';
  const OUT = resolve(REPO, outArg ?? '.evidence');

  const { cdp, child, ws } = await launch();
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? '✅' : '⛔'} ${name} — ${detail}`);
  };

  try {
    await cdp.goto(BASE + '/console');
    await cdp.eval(HELPERS);
    const login = await cdp.eval(`(() => {
      const pw = document.querySelector('#pw');
      if (!pw) return { noForm: true };
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pw), 'value');
      d.set.call(pw, ${JSON.stringify(PW)});
      pw.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('button[type=submit]')?.click();
      return { noForm: false };
    })()`);
    let authed = false;
    for (let i = 0; i < 40; i += 1) {
      await delay(400);
      if (await cdp.eval('!!document.querySelector(".sidebar")')) { authed = true; break; }
    }
    add('前置：Mock 登录成功', !login.noForm && authed, JSON.stringify({ ...login, authed }));
    if (!authed) throw new Error('未登录成功，后续断言无意义 —— 检查口令参数');
    await delay(400);

    /* ---------- AC-U01：侧栏第 5 项 + 激活态 ---------- */
    await cdp.eval(`document.querySelectorAll('.sb-item').forEach((b) => { if (b.textContent.trim() === '积分与用量') b.click(); })`);
    await delay(900);
    const nav = await cdp.eval(`({
      hash: location.hash,
      active: __t('.sb-item.active'),
      labels: [...document.querySelectorAll('.sb-item')].map((b) => b.textContent.trim()),
      h1: __t('.topbar h1'),
      iconSvg: document.querySelectorAll('.sb-item svg').length,
    })`);
    add('AC-U01 #usage 可达 + 侧栏「积分与用量」激活态正确',
      nav.hash === '#/usage' && nav.active === '积分与用量' && nav.h1 === '积分与用量'
        && nav.labels.includes('积分与用量') && nav.labels.indexOf('积分与用量') === 1,
      JSON.stringify(nav));

    /* ---------- 切窗口（自绘 listbox：选项挂 `data-value`，见 ui/Select.tsx） ---------- */
    const switchWindow = async (value) => {
      await cdp.eval(`document.querySelector('.sel-field button.sel').click()`);
      await delay(250);
      const ok = await cdp.eval(
        `(() => { const o = [...document.querySelectorAll('.sel-opt')].find((x) => x.dataset.value === ${JSON.stringify(value)}); if (o) o.click(); return !!o; })()`,
      );
      await delay(900);
      return ok;
    };

    /* ---------- AC-U12：默认窗口是「今日」（2026-10-09 用户口径） ----------
       三页（概览 / 积分与用量 / 客户端管理）的默认窗口统一为 today。
       本页在 today 下统计条走"今天到目前为止"那一支 —— **没有**「日均消耗 / 按当前速度可用天数」
       （today 不是完整的一天，日均在早上会严重偏低，见 UsagePage 的 WINDOW_DAYS_OF）。 */
    const defWin = await cdp.eval(`({
      sel: __t('.topbar-right .sel-val'),
      statItems: [...document.querySelectorAll('.statbar > div')].map((d) => (d.querySelector('.lb')?.textContent || '').trim()),
      trendTitle: (() => { const b = document.querySelector('.bars30'); const p = b && b.closest('.card'); return p ? ((p.querySelector('.panel-head h3')?.textContent) || '').trim() : ''; })(),
      credits: (__byLabel('.statbar > div', '今日消耗')?.querySelector('.vl')?.textContent || '').trim(),
    })`);
    add('AC-U12 默认窗口「今日」：选择器 / 统计条 / 趋势标题三处自洽',
      defWin.sel === '今日'
        && JSON.stringify(defWin.statItems) === JSON.stringify(['今日消耗', '今日请求', '本窗口总 tokens'])
        && defWin.trendTitle === '今日趋势',
      JSON.stringify(defWin));

    /* 下面几条（六块齐备 / 两态日均 / 可用天数 / 逐分求和）只在**天级窗口**下成立 ——
       today 按设计隐藏了日均与可用天数。所以先切到「最近 30 天」再验：
       那才是「六块齐备」这条口径成立的窗口。 */
    await switchWindow('30d');

    /* ---------- AC-U09 / 结构：六个区块齐备 ---------- */
    const blocks = await cdp.eval(`({
      banner: !!document.querySelector('.credit-banner'),
      statItems: [...document.querySelectorAll('.statbar > div')].map((d) => (d.querySelector('.lb')?.textContent || '').trim()),
      trend: !!document.querySelector('.bars30') && !!document.querySelector('.seg-tabs'),
      modelTable: !!document.querySelector('table.tbl'),
      modelCols: [...document.querySelectorAll('table.tbl thead th')].map((t) => t.textContent.trim()),
      clientBars: !!document.querySelector('.dist'),
      srcCard: [...document.querySelectorAll('.panel-head h3')].map((h) => h.textContent.trim()),
      segButtons: [...document.querySelectorAll('.seg-tabs button')].map((b) => b.textContent.trim()),
    })`);
    /* 默认窗口 30 天时的实际文案。标签自 2026-10-07 起随窗口动态生成
     （`${WINDOW_LABEL[window]}消耗`），所以这里跟着默认窗口写。 */
    const SIX = ['最近 30 天消耗', '最近 30 天请求', '日均消耗', '按当前速度可用天数'];
    add('AC-U09 用量页六块齐备（横幅/统计条/趋势/按模型/按客户端/来源卡）',
      blocks.banner && JSON.stringify(blocks.statItems) === JSON.stringify(SIX)
        && blocks.trend && blocks.modelTable && blocks.clientBars
        && blocks.srcCard.includes('配额数据来源'),
      JSON.stringify(blocks));
    add('AC-U11 按模型明细表五列（模型/请求次数/消耗积分/占比/平均单次）',
      JSON.stringify(blocks.modelCols) === JSON.stringify(['模型', '请求次数', '消耗积分', '占比', '平均单次']),
      JSON.stringify(blocks.modelCols));

    /* ---------- AC-U03：趋势两态与 trend 一致 ----------
       ⚠️ Mock 里 credits = requests × 0.9（mocks/fixtures.ts:149），两条序列**严格成正比**，
       所以归一化后的柱高在两态下必然完全相同 —— 拿柱高证明"切换生效"是证不了的。
       柱高只用来证明"画的是所选那一列"，切换本身由**日均**与**单位**两处给证据。 */
    const stat = await cdp.eval(`(() => ({
      credits: (__byLabel('.statbar > div', '最近 30 天消耗')?.querySelector('.vl')?.textContent || '').trim(),
      requests: (__byLabel('.statbar > div', '最近 30 天请求')?.querySelector('.vl')?.textContent || '').trim(),
    }))()`);
    const num = (s) => Number(String(s).replace(/,/g, ''));
    const creditsUsed = num(stat.credits);
    const reqUsed = num(stat.requests);

    const creditsBars = await cdp.eval('__bars()');
    const creditsHeights = expectedHeights(creditsBars, 'credits');
    const creditsOk = creditsHeights !== null && creditsBars.length > 0
      && creditsBars.every((b, i) => near(b.h, creditsHeights[i]));
    const creditsTag = await cdp.eval(`__t('.avgline .avg-tag')`);
    const creditsUnit = await cdp.eval(`__t('.panel-aside-row .pill')`);

    await cdp.eval(`[...document.querySelectorAll('.seg-tabs button')].forEach((b) => { if (b.textContent.trim() === '请求数') b.click(); })`);
    await delay(500);
    const reqBars = await cdp.eval('__bars()');
    const reqHeights = expectedHeights(reqBars, 'requests');
    const reqOk = reqHeights !== null && reqBars.length > 0
      && reqBars.every((b, i) => near(b.h, reqHeights[i]));
    const reqTag = await cdp.eval(`__t('.avgline .avg-tag')`);
    const reqUnit = await cdp.eval(`__t('.panel-aside-row .pill')`);

    const tagNum = (s) => Number((/\s([\d,.]+)\s*$/.exec(String(s)) || [])[1]?.replace(/,/g, ''));
    const tagOk = near(tagNum(creditsTag), creditsUsed / 30, 0.02) && near(tagNum(reqTag), reqUsed / 30, 0.6);
    const unitOk = creditsUnit.includes('消耗积分') && reqUnit.includes('请求次数');
    const sameShape = reqBars.length === creditsBars.length && reqBars.every((b, i) => near(b.h, creditsBars[i].h, 0.01));

    add('AC-U03 趋势卡可切「积分 ⇄ 请求数」，两态柱高与日均都与 trend 对应字段一致',
      creditsOk && reqOk && tagOk && unitOk && creditsTag !== reqTag && creditsUnit !== reqUnit,
      `积分态 n=${creditsBars.length} 柱高ok=${creditsOk}「${creditsTag}」单位「${creditsUnit}」`
        + ` | 请求态 n=${reqBars.length} 柱高ok=${reqOk}「${reqTag}」单位「${reqUnit}」`
        + ` | 日均对齐 ${creditsUsed}/30 与 ${reqUsed}/30 = ${tagOk}`
        + ` | 两态柱高相同=${sameShape}（Mock 里 credits≡requests×0.9，成正比 ⇒ 柱高必然相同）`);

    /* ---------- AC-U05：额度不可用时「可用天数」= — 且注明原因 ---------- */
    const days = await cdp.eval(`(() => {
      const box = __byLabel('.statbar > div', '按当前速度可用天数');
      return box ? { v: (box.querySelector('.vl')?.textContent || '').trim(),
                     d: (box.querySelector('.sdl')?.textContent || '').trim(),
                     color: getComputedStyle(box.querySelector('.vl')).color } : null;
    })()`);
    add('AC-U05 额度不可用 → 可用天数显示 — 且注明原因，无推测数字',
      days !== null && days.v === '—' && /额度接口/.test(days.d) && !/\d/.test(days.v),
      JSON.stringify(days));

    /* ---------- AC-U06：来源卡区分「接口」与「本机」并写出 ≤30s 偏差 ---------- */
    const src = await cdp.eval(`(() => {
      const panel = [...document.querySelectorAll('.card.panel')].find((c) => /配额数据来源/.test(c.textContent || ''));
      const t = panel ? panel.textContent.replace(/\\s+/g, '') : '';
      return {
        hasOfficial: /来自上游额度接口/.test(t),
        hasLocal: /本机按请求累计/.test(t),
        has30s: /30秒/.test(t) && /滞后/.test(t),
        hasProvenance: /来源标记/.test(t),
        hasNoEstimate: /不做估算/.test(t),
        chars: t.length,
      };
    })()`);
    add('AC-U06 来源卡区分「来自接口 / 本机累计」+ 写明 ≤30s 偏差 + 未接入时不估算',
      src.hasOfficial && src.hasLocal && src.has30s && src.hasProvenance && src.hasNoEstimate,
      JSON.stringify(src));

    /* ---------- Mock 数据自洽：页面上「同一数字」必须处处相等（fixtures 修正后的端到端证据） ----------
       改 fixtures 之前这条在 Mock 下恒真无效（四路各写死一个值、页面根本没同时展示），
       现在这些都由 Σtrend 推导，页面才会真的把它们摆在一起。

       [2026-10-08] 求和对象由「页面上所有 .dist」改为**按面板标题定位**。
       原因：本轮新增了「按工具消耗」面板，它和「按客户端消耗」用的是同一个 .dist 组件；
       不限定范围的话两块的数会被加在一起（实测 1882.8 被算成 3765.6 = 2 倍），
       看起来像"数据错了"，实际是**校验器选错了范围** —— 而它红的样子和真错一模一样。
       现在两块各自与总量比对：任何一个对不上都是真问题。 */
    const sums = await cdp.eval(`(() => {
      const num = (s) => Number(String(s ?? '').replace(/[^0-9.]/g, '')) || 0;
      /* 按面板标题找那一块，而不是"页面上所有 .dist" —— 见上面的注释。 */
      const distUnder = (title) => {
        for (const p of document.querySelectorAll('.view.on .card')) {
          const h = p.querySelector('.panel-head h3');
          if (h && h.textContent.trim() === title) return p.querySelector('.dist');
        }
        return null;
      };
      const sumDist = (title) => {
        const d = distUnder(title);
        if (!d) return null;
        return +[...d.querySelectorAll('.d-row .d-val')]
          .reduce((s, el) => s + num(String(el.textContent).split('·')[0]), 0).toFixed(2);
      };
      const used = num(__byLabel('.statbar > div', '最近 30 天消耗')?.querySelector('.vl')?.textContent);
      const model = [...document.querySelectorAll('table.tbl tbody tr')]
        .reduce((s, tr) => s + num(tr.children[2]?.textContent), 0);
      return {
        used: +used.toFixed(2), model: +model.toFixed(2),
        client: sumDist('按客户端消耗'), tool: sumDist('按工具消耗'),
      };
    })()`);
    add('Mock 求和相等（近 30 天消耗 = Σ按模型 = Σ按客户端 = Σ按工具）',
      sums.used > 0 && sums.used === sums.model && sums.used === sums.client && sums.used === sums.tool,
      JSON.stringify(sums));

    /* ---------- AC-U04：跨页同一数字必须相等（30 天口径：用量页 ⇄ 概览） ----------
       概览的默认窗口也是 today，所以这里要**把概览也切到 30 天**再比 ——
       否则是拿"今日"比"近 30 天"，红的是校验器而不是页面（同 AC-U03 选错范围那次的教训）。
       顺带记下概览**切换前**的选择器值：它证明概览的默认窗口也是「今日」。 */
    const usageCredits = await cdp.eval(`(__byLabel('.statbar > div', '最近 30 天消耗')?.querySelector('.vl')?.textContent || '').trim()`);
    await cdp.eval(`document.querySelectorAll('.sb-item').forEach((b) => { if (b.textContent.trim() === '概览') b.click(); })`);
    await delay(1200);
    const ovDefaultWin = await cdp.eval(`__t('.topbar-right .sel-val')`);
    await switchWindow('30d');
    const ov = await cdp.eval(`({
      credits: (__byLabel('.metric-row .metric', '已消耗积分')?.querySelector('.vl')?.textContent || '').trim(),
      hasTrend: !!document.querySelector('.bars30'),
      hasDist: !!document.querySelector('.dist'),
      text: document.body.innerText,
    })`);
    add('AC-U04 近 30 天消耗在概览与用量页相等（且概览默认窗口也是「今日」）',
      usageCredits !== '' && usageCredits === ov.credits && ovDefaultWin === '今日',
      `用量=${usageCredits} 概览(已消耗积分)=${ov.credits} 概览默认窗口=${ovDefaultWin}`);

    /* ---------- AC-U02：概览不再出现趋势 / 模型分布 / 客户端排行 ---------- */
    const leftovers = ['请求趋势', '模型分布', '客户端排行'].filter((s) => ov.text.includes(s));
    add('AC-U02 概览已无 请求趋势 / 模型分布 / 客户端排行',
      leftovers.length === 0 && !ov.hasTrend && !ov.hasDist,
      `残留文案=${JSON.stringify(leftovers)} hasBars30=${ov.hasTrend} hasDist=${ov.hasDist}`);
    add('概览「最近请求」不再承诺自动刷新', !ov.text.includes('自动刷新'), `含"自动刷新"=${ov.text.includes('自动刷新')}`);
    add('概览指路文案指向「积分与用量」与「请求日志」',
      ov.text.includes('积分与用量') && ov.text.includes('请求日志') && ov.text.includes('同一组数字不再有两个入口'),
      '文案命中');

    /* ---------- AC-U10：1280 / 1440 两档不塌、无横向滚动 ----------
       重进页面会回到默认窗口（today，统计条 3 格），所以这里也切到 30 天 ——
       这条验的是"六块齐备时的四格统计条与两栏来源卡"，那是天级窗口的形态。 */
    await cdp.eval(`document.querySelectorAll('.sb-item').forEach((b) => { if (b.textContent.trim() === '积分与用量') b.click(); })`);
    await delay(900);
    await switchWindow('30d');
    mkdirSync(OUT, { recursive: true });
    const layout = [];
    for (const [w, h] of [[1440, 900], [1280, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await delay(600);
      const m = await cdp.eval(`({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        statCols: getComputedStyle(document.querySelector('.statbar')).gridTemplateColumns.split(' ').length,
        srcCols: getComputedStyle(document.querySelector('.src-grid')).gridTemplateColumns.split(' ').length,
        chartW: Math.round(document.querySelector('.bars30').getBoundingClientRect().width),
        tableW: Math.round(document.querySelector('table.tbl').getBoundingClientRect().width),
      })`);
      layout.push({ w, ...m });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `console-usage-${w}.png`), Buffer.from(shot.data, 'base64'));
    }
    add('AC-U10 1280/1440 两档无横向滚动、四格统计条与两栏来源卡未塌',
      layout.every((l) => l.sw <= l.cw && l.statCols === 4 && l.srcCols === 2 && l.chartW > 200 && l.tableW > 400),
      JSON.stringify(layout));

    /* ---------- 严重错误网 ---------- */
    add('无 JS 异常 / 无 error 级日志', cdp.errors.length === 0,
      cdp.errors.length ? JSON.stringify(cdp.errors.slice(0, 3)) : 'clean');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    child.kill('SIGKILL');
    await delay(200);
  }

  const bad = checks.filter((c) => !c.pass).length;
  console.log(`\n===== 静态纪律（AC-U07 / U08 / U11）=====`);

  /* AC-U11：本次涉及的**代码模块**单文件 ≤ 300 行。
     样式表另算：控制台的全部组件样式按既有约定集中在一个 app.css 里（本任务之前
     就已经是 406 行）。把这条规则套到样式表上等于要求拆分 app.css —— 那是
     架构级改动、且会动到 main.tsx 里写死的样式加载顺序，不在本任务范围。
     这里如实报出它的行数，不塞进判定。 */
  const FILES = [
    'web/src/pages/UsagePage.tsx',
    'web/src/pages/OverviewPage.tsx',
    'web/src/components/usage/TrendChart.tsx',
    'web/src/components/usage/BreakdownBars.tsx',
    'web/src/components/usage/ModelUsageTable.tsx',
    'web/src/components/usage/QuotaSourceCard.tsx',
    'web/src/components/ui/Panel.tsx',
    'web/src/components/AppShell.tsx',
    'web/src/hooks/useHashRoute.ts',
    'web/src/App.tsx',
  ];
  const lines = (f) => readFileSync(resolve(REPO, f), 'utf8').split('\n').length - 1;
  const measured = FILES.map((f) => ({ f, n: lines(f) }));
  const over = measured.filter((x) => x.n > 300);
  const staticFail = [];
  if (over.length) staticFail.push('超 300 行: ' + JSON.stringify(over));
  console.log(`AC-U11 单文件 ≤300 行（${FILES.length} 个代码模块）→ ${over.length ? '⛔ ' + JSON.stringify(over) : '✅ 最大 ' + Math.max(...measured.map((x) => x.n)) + ' 行（' + measured.map((x) => `${x.f.split('/').pop()}=${x.n}`).join(' ') + '）'}`);
  console.log(`   · 样式表 app.css = ${lines('web/src/styles/app.css')} 行（本任务 +26 行；既有约定是控制台样式集中一处，未拆）`);
  console.log(`   · Mock 数据模块 mocks/fixtures.ts = ${lines('web/src/mocks/fixtures.ts')} 行（改动前 324 行即超 300；纯数据+推导，未与页面模块同列）`);

  /* AC-U07：手写组件样式零色值字面量（#fff/#000 与其透明变体、中性 rgba 叠加除外） */
  const CSS_FILES = ['web/src/styles/app.css'];
  const NEUTRAL = /^rgba?\(\s*(255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)\s*,[^)]*\)$/;
  const lit = [];
  for (const rel of CSS_FILES) {
    const src = readFileSync(resolve(REPO, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const line of src.split('\n')) {
      const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      for (const h of hexes) {
        if (!['#fff', '#ffffff', '#000', '#000000'].includes(h.toLowerCase())) lit.push(`${rel}: ${h}`);
      }
      for (const m of line.match(/rgba?\([^)]*\)/g) || []) {
        if (!NEUTRAL.test(m.replace(/\s+/g, ' '))) lit.push(`${rel}: ${m}`);
      }
    }
  }
  if (lit.length) staticFail.push('色值字面量: ' + JSON.stringify(lit.slice(0, 5)));
  console.log(`AC-U07 手写组件样式零色值字面量 → ${lit.length ? '⛔ ' + JSON.stringify(lit.slice(0, 5)) : '✅ 0 处'}`);

  /* AC-U08：交付面无 emoji */
  const EMOJI = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const emojiHit = [];
  for (const rel of [...FILES, 'web/src/styles/app.css']) {
    const src = readFileSync(resolve(REPO, rel), 'utf8');
    if (EMOJI.test(src)) emojiHit.push(rel);
  }
  if (emojiHit.length) staticFail.push('emoji: ' + JSON.stringify(emojiHit));
  console.log(`AC-U08 无 emoji 作功能图标 → ${emojiHit.length ? '⛔ ' + JSON.stringify(emojiHit) : '✅ 0 命中'}`);

  const total = bad + staticFail.length;
  console.log(`\n合计（含静态） ${checks.length + 3} 项，失败 ${total}`);
  await new Promise((r) => process.stdout.write('', r));
  process.exit(total ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await new Promise((r) => process.stdout.write('', r));
  process.exit(2);
});
