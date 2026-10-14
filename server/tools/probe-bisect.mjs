/**
 * D0 续：二分定位 11128 的最小触发窗口（task#2 fallback）
 *
 * 前置结论：A1 零宽脱敏 / A2 身份中性化 均无效（probe-sysprompt.mjs X1–X3 全 400）。
 * 本脚本在**干净提示**上二分，定位最小触发窗口的**偏移量与长度**。
 *
 * 关键纪律：**绝不输出触发窗口的正文**。
 * 已实测：该文本一旦进入任何模型上下文，该模型的请求即被上游 400（unapproved channel）。
 * 故本脚本只输出数值与「候选特征命中情况」，窗口正文单独落盘到服务器文件，不读入上下文。
 *
 * 用法：node probe-bisect.mjs <sysprompt.txt> <out-json> [window-out.txt]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions';
const UA = 'relay-station/0.4.1';
const MODEL = 'deepseek-v4.1-flash';
const MAX_REQ = 40;
const DELAY = 1200;

const sysPath = process.argv[2];
const outJson = process.argv[3] || 'd0-bisect.json';
const windowOut = process.argv[4] || 'd0-window.txt';

const rawKey = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!rawKey) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}

const text = readFileSync(sysPath, 'utf8').replace(/\r\n/g, '\n');
const N = text.length;

let used = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map();

async function probe(slice) {
  const key = `${slice.length}:${slice.slice(0, 24)}:${slice.slice(-24)}`;
  if (cache.has(key)) return cache.get(key);
  if (used >= MAX_REQ) throw new Error(`request budget exhausted (${MAX_REQ})`);
  used++;
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    max_tokens: 16,
    messages: [
      { role: 'system', content: slice },
      { role: 'user', content: 'Reply with OK only.' },
    ],
  });
  let status = -1;
  let code = null;
  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'user-agent': UA,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    const t = await res.text();
    try {
      code = JSON.parse(t).code ?? null;
    } catch {
      /* SSE 200，不解析 */
    }
  } catch (e) {
    status = -1;
    code = String(e.message).slice(0, 120);
  }
  const bad = status === 400 && code === 11128;
  cache.set(key, bad);
  await sleep(DELAY);
  return bad;
}

const steps = [];
async function step(desc, slice) {
  const bad = await probe(slice);
  steps.push({ desc, len: slice.length, bad });
  console.log(`  ${bad ? 'REJ' : 'ok '} len=${String(slice.length).padStart(5)} req=${used} ${desc}`);
  return bad;
}

console.log(`prompt length (normalized LF) = ${N}`);
console.log('phase 1: smallest triggering prefix');

if (!(await step('full', text))) {
  writeFileSync(outJson, JSON.stringify({ error: 'full prompt did not reproduce 11128', steps }, null, 2));
  console.log('BASELINE_LOST');
  process.exit(1);
}

let lo = 400;
let hi = N;
if (!(await step('prefix 400 (expected ok)', text.slice(0, lo)))) {
  lo = 1;
  await step('prefix 1', text.slice(0, 1));
}
while (hi - lo > 1 && used < MAX_REQ - 2) {
  const mid = (lo + hi) >> 1;
  if (await step(`prefix ${mid}`, text.slice(0, mid))) hi = mid;
  else lo = mid;
}
const end = hi;
console.log(`=> smallest triggering prefix length = ${end}`);

console.log('phase 2: largest start that still triggers (minimal window)');
let sLo = 0;
let sHi = end - 1;
if (!(await step('window from end-1 (expected ok)', text.slice(sHi, end)))) {
  sHi = Math.max(0, end - 2);
}
while (sHi - sLo > 1 && used < MAX_REQ) {
  const mid = (sLo + sHi) >> 1;
  if (await step(`window [${mid},${end})`, text.slice(mid, end))) sLo = mid;
  else sHi = mid;
}
const start = sLo;
const win = text.slice(start, end);

writeFileSync(windowOut, win, 'utf8');

const FEATURES = [
  '<env>',
  '</env>',
  'Working directory',
  'Is directory a git repo',
  'Platform:',
  'OS Version:',
  "Today's date",
  'git status',
  '# ',
  'IMPORTANT',
  'You are ',
  'system-reminder',
  'tool',
  'ZCode',
];
const hits = {};
for (const f of FEATURES) {
  const c = win.split(f).length - 1;
  if (c) hits[f] = c;
}

const out = {
  normalizedLength: N,
  requestsUsed: used,
  minimalTriggeringPrefixEnd: end,
  windowStart: start,
  windowEnd: end,
  windowLength: win.length,
  windowFeatureHits: hits,
  windowHashes: {
    sha1ish: [...win].reduce((a, ch) => (a * 31 + ch.codePointAt(0)) % 2147483647, 7),
  },
  steps,
  note: 'window raw text written to separate file on host; deliberately not returned to the LLM context',
};
writeFileSync(outJson, JSON.stringify(out, null, 2), 'utf8');

console.log(`=> minimal trigger window: [${start}, ${end}) length=${win.length}`);
console.log(`   feature hits: ${JSON.stringify(hits)}`);
console.log(`   raw window written to ${windowOut} (not printed)`);
console.log(`   requests used: ${used}`);
