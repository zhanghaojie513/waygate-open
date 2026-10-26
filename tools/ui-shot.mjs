/**
 * 用 Chrome DevTools Protocol 驱动已有 Chromium 截图的小工具。
 *
 * 为什么不用 agent-browser：它自带的 Chromium 下载在本机网络环境下失败
 * （googlechromelabs.github.io TLS handshake eof），而本机已有 Playwright
 * 的 Chromium；agent-browser 的守护进程又一直卡在启动阶段。
 * CDP 是同一套浏览器，但少一层依赖。
 *
 * 用法：node ui-shot.mjs <url> <out.png> [步骤 JSON]
 * 步骤形如 [{"type":"fill","sel":"#cred-value","value":"ck_..."},{"type":"click","sel":"button"}]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * [v1.10.2] 自动探测本机 playwright chromium —— 目录名带版本号（chromium-1243 →
 * chromium-1248），硬编码必然在 playwright 升级后过期（本次实测 ENOENT）。
 * 取 ms-playwright 下**版本号最大**的 chromium-*；探测失败回落旧路径（报错可见）。
 */
function resolveChrome() {
  const root = 'C:/Users/haiha/AppData/Local/ms-playwright';
  try {
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.replace('chromium-', '')) - Number(a.replace('chromium-', '')));
    if (dirs.length === 0) throw new Error('无 chromium-*');
    const exe = join(root, dirs[0], 'chrome-win64', 'chrome.exe');
    if (!existsSync(exe)) throw new Error(`${exe} 不存在`);
    return exe;
  } catch (err) {
    console.warn(`[ui-shot] chromium 自动探测失败（${String(err && err.message ? err.message : err)}），回落占位路径`);
    return 'C:/Users/haiha/AppData/Local/ms-playwright/chromium-UNKNOWN/chrome.exe';
  }
}

const CHROME =
  process.env.CHROME_PATH ?? resolveChrome();

const [url, outPath, stepsRaw] = process.argv.slice(2);
const steps = stepsRaw ? JSON.parse(stepsRaw) : [];

/* README 用的截图规格：1440×900、1x（与 docs/img 里既有的图一致）。
   环境变量可覆盖 —— 默认值保持旧的 1440×1080@2x，不给其他调用方添麻烦。 */
const VW = Number(process.env.UI_SHOT_W ?? 1440);
const VH = Number(process.env.UI_SHOT_H ?? 1080);
const SCALE = Number(process.env.UI_SHOT_SCALE ?? 2);
/** 整页截图（含滚动区）：README 里概览/用量页下半截要靠它，否则会被切掉。 */
const FULL = process.env.UI_SHOT_FULL === '1';
/**
 * [v1.7.3] 固定高度截图：README 的「控制台一览」是 2 列并排表格，
 * 同一行左右两张图必须等高，否则版面参差（实测 900 / 1067 / 1257 / 1619 / 2076 五种高度）。
 * 设了它就忽略 FULL 的「按内容高度撑开」行为，统一按这个高度拍。
 */
const FIXED_H = process.env.UI_SHOT_FIXED_H ? Number(process.env.UI_SHOT_FIXED_H) : null;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  const port = 9333 + Math.floor(Math.random() * 400);
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1440,1080',
      // 自签证书不在 Chrome 的信任库里。截图只是为了看**界面渲染**，
      // 不是校验 TLS（TLS 已由 tools/verify-tls.mjs 用真 CA 严格验证过），
      // 所以这里允许忽略证书错误是合理的取舍。
      '--ignore-certificate-errors',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const wsUrl = await waitForTarget(port);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW,
    height: VH,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  await send('Page.navigate', { url });
  await delay(2500);

  /*
   * [2026-10-20] 目标没起来时**别拍一张错误页当截图**。
   * 实测过：mock dev server 没启动，Page.navigate 落到 chrome-error://，
   * 脚本照样 "saved" 并覆盖了 docs/img 里的正式截图 —— 比直接失败危险得多
   * （图看起来是新的，内容却是「无法访问此网站」）。
   */
  const landed = await evalJs('location.href');
  if (typeof landed === 'string' && landed.startsWith('chrome-error://')) {
    throw new Error(`目标页面加载失败（${url}）—— 服务没起来？拒绝保存错误页截图。`);
  }
  const bodyText = await evalJs('document.body ? document.body.innerText.slice(0, 400) : ""');
  if (typeof bodyText === 'string' && /ERR_CONNECTION_REFUSED|无法访问此网站/.test(bodyText)) {
    throw new Error(`目标页面是浏览器错误页（${url}）—— 拒绝保存。`);
  }

  for (const step of steps) {
    if (step.type === 'fill') {
      await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(step.sel)});
        if (!el) return 'missing';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(step.value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);
    } else if (step.type === 'click') {
      await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(step.sel)});
        if (!el) return 'missing';
        el.click();
        return 'ok';
      })()`);
    } else if (step.type === 'clickText') {
      await evalJs(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(step.sel ?? 'button')})];
        const el = els.find((e) => e.textContent.includes(${JSON.stringify(step.text)}));
        if (!el) return 'missing';
        el.click();
        return 'ok';
      })()`);
    } else if (step.type === 'wait') {
      await delay(step.ms ?? 1000);
    } else if (step.type === 'eval') {
      /* 调试/探针：执行表达式并把结果打到 stdout（如探测元素是否存在、当前 hash）。 */
      console.log(`[eval] ${step.expr} =>`, JSON.stringify(await evalJs(step.expr)));
    } else if (step.type === 'hover' || step.type === 'hoverText') {
      /* 真 CDP 鼠标事件（el.click() 合成事件不触发 React 的 onMouseEnter）：
         轮询等元素出现（路由/懒加载时序抖动）→ 移到中心 → 停留等浮层/过渡。
         `hoverText` 是「按可见文字找元素」的变体：CSS 选择器表达不了
         「label 是「平均 TPM」的那张卡」这类意图，而那正是核对 tooltip 时
         最常用的定位方式（同 clickText，但派发真鼠标移动而非合成 click）。 */
      const findExpr =
        step.type === 'hoverText'
          ? `[...document.querySelectorAll(${JSON.stringify(step.sel ?? '.card')})]
               .find((e) => e.textContent.includes(${JSON.stringify(step.text)}))`
          : `document.querySelector(${JSON.stringify(step.sel)})`;
      let rect = null;
      for (let i = 0; i < 40 && !rect; i += 1) {
        rect = await evalJs(`(() => {
          const el = ${findExpr};
          if (!el) return null;
          /* tooltip 的挂载点优先：悬停数值节点本身（.tooltip-value-anchor） */
          const target = el.querySelector('.tooltip-value-anchor') ?? el;
          const r = target.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (!rect) await delay(150);
      }
      if (!rect) throw new Error(`hover 目标不存在: ${step.sel}${step.text ? ` / 文字「${step.text}」` : ''}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await delay(step.ms ?? 600);
    }
  }

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  }

  /* 整页截图：先把 CSS 视口高度设成内容高度，captureScreenshot 才能多出这么多
     （captureBeyondViewport 单独用不够 —— 它按当前视口尺寸截，仍会切掉下方内容）。
     [v1.7.3] FIXED_H 优先：README 并排表格要求六张图同高 —— 此时**不**按内容撑开。 */
  if (FIXED_H !== null) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: VW, height: FIXED_H, deviceScaleFactor: SCALE, mobile: false,
    });
    await delay(400); // 等重排稳定再拍
  } else if (FULL) {
    const contentH = await evalJs(
      'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)',
    );
    if (typeof contentH === 'number' && contentH > VH) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: VW, height: Math.min(contentH, 8000), deviceScaleFactor: SCALE, mobile: false,
      });
      await delay(400); // 等重排稳定再拍
    }
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    /* 固定高度模式**不**越界捕获 —— 那会按内容高度截，反而破坏统一尺寸。 */
    ...(FULL && FIXED_H === null ? { captureBeyondViewport: true } : {}),
  });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${outPath}`);

  ws.close();
  child.kill();
  await delay(300);
  process.exit(0);
}

async function waitForTarget(port) {
  // 注意要拿**页面级** target 的 ws 地址，不是 /json/version 的浏览器级地址 ——
  // 浏览器级连接不接受 Page.navigate / Runtime.evaluate 这类域命令。
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* 还没起来 */
    }
    await delay(300);
  }
  throw new Error('Chrome DevTools 页面端点未就绪');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
