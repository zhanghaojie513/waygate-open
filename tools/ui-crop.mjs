/**
 * 截图 + 裁剪：把页面上某个元素单独放大截出来，便于逐像素检查。
 * 用法：node ui-crop.mjs <url> <out.png> <css选择器> [步骤JSON]
 * 与 ui-shot.mjs 共用同一套 CDP 驱动逻辑，只是最后用 clip 截元素区域。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/haiha/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const [url, outPath, sel, stepsRaw] = process.argv.slice(2);
const steps = stepsRaw ? JSON.parse(stepsRaw) : [];

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
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const wsUrl = await waitPage(port);
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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1080, deviceScaleFactor: 2, mobile: false,
  });
  await send('Page.navigate', { url });
  await delay(2500);

  for (const step of steps) {
    if (step.type === 'fill') {
      await evalJs(`(() => { const el=document.querySelector(${JSON.stringify(step.sel)}); if(!el) return 'missing';
        const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(el, ${JSON.stringify(step.value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    } else if (step.type === 'click') {
      await evalJs(`(() => { const el=document.querySelector(${JSON.stringify(step.sel)}); if(!el) return 'missing'; el.click(); return 'ok'; })()`);
    } else if (step.type === 'clickText') {
      await evalJs(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(step.sel ?? 'button')})];
        const el=els.find(e=>e.textContent.includes(${JSON.stringify(step.text)})); if(!el) return 'missing'; el.click(); return 'ok'; })()`);
    } else if (step.type === 'wait') {
      await delay(step.ms ?? 1000);
    }
  }

  const box = await evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)});
    if(!el) return null; const r=el.getBoundingClientRect();
    return {x:r.x, y:r.y, width:r.width, height:r.height}; })()`);
  if (!box) throw new Error(`找不到元素：${sel}`);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 },
  });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${outPath}  (${Math.round(box.width)}x${Math.round(box.height)})`);

  ws.close();
  child.kill();
  await delay(300);
  process.exit(0);
}

async function waitPage(port) {
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
