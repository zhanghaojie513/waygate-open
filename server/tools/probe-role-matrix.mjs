#!/usr/bin/env node
/**
 * 驿站 · Relay — 上游 role 矩阵直连探针（task#77 的实测依据）
 *
 * 目的：回答「上游是否接受**多个 system**」—— 决定 `developer→system` 是就地 1:1 转换，
 * 还是必须合并。仅此一问，总请求数 ≤8，max_tokens 取小。
 *
 * ## 为什么要在服务器侧跑
 * 上游凭证**明文只存在于服务端**（读不回来），运行时优先级见 config.service.ts:loadUpstreamKey：
 *   1. 环境变量 `RELAY_UPSTREAM_KEY`（含 systemd EnvironmentFile 注入的 .env）
 *   2. `<RELAY_DATA_DIR>/upstream.key`
 * 本脚本完全复刻该优先级。⛔ 全程只打印掩码；key 不落任何输出。
 *
 * ## 用法（服务器 `/opt/relay/server/` 下）
 *   node tools/probe-role-matrix.mjs
 * 可选：RELAY_UPSTREAM_BASE（默认 https://copilot.tencent.com）、RELAY_SPOOF_UA（默认 WorkBuddy/5.6.2）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.RELAY_UPSTREAM_BASE || 'https://copilot.tencent.com').replace(/\/+$/, '');
const UA = process.env.RELAY_SPOOF_UA || 'WorkBuddy/5.6.2';
const MODEL = process.env.RELAY_PROBE_MODEL || 'kimi-k3';

function resolveDataDir() {
  const configured = (process.env.RELAY_DATA_DIR ?? '').trim();
  return configured || join(process.cwd(), 'data');
}
function loadUpstreamKey() {
  const fromEnv = (process.env.RELAY_UPSTREAM_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, from: 'env RELAY_UPSTREAM_KEY' };
  const file = join(resolveDataDir(), 'upstream.key');
  try {
    if (existsSync(file)) return { key: readFileSync(file, 'utf8').trim(), from: file };
  } catch (err) {
    console.error(`读取 ${file} 失败：${err.message}`);
  }
  return { key: '', from: '(未找到)' };
}
const mask = (k) => (k.length <= 8 ? '••••' : `${k.slice(0, 4)}${'•'.repeat(4)}${k.slice(-4)}`);

const { key: KEY, from } = loadUpstreamKey();
if (!KEY) {
  console.error('\n未找到上游访问密钥（RELAY_UPSTREAM_KEY 或 <数据目录>/upstream.key）。\n');
  process.exit(2);
}

/** 六个用例：核心是第 ① 行「两个 system」。其余是正/对照。 */
const CASES = [
  { name: '① [system, system, user]（★核心：多个 system）', messages: [
    { role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'hi' },
  ] },
  { name: '② [system, system, system, user]（三个 system）', messages: [
    { role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'system', content: 'C' }, { role: 'user', content: 'hi' },
  ] },
  { name: '③ [system, user]（对照：单 system，应 200）', messages: [
    { role: 'system', content: 'A' }, { role: 'user', content: 'hi' },
  ] },
  { name: '④ [system, developer, user]（对照：developer，应 400/11128）', messages: [
    { role: 'system', content: 'A' }, { role: 'developer', content: 'B' }, { role: 'user', content: 'hi' },
  ] },
  { name: '⑤ [system, assistant, system, user]（非相邻 system + assistant）', messages: [
    { role: 'system', content: 'A' }, { role: 'assistant', content: 'ok' }, { role: 'system', content: 'B' }, { role: 'user', content: 'hi' },
  ] },
  { name: '⑥ [system(空), system, user]（空内容 system 是否可）', messages: [
    { role: 'system', content: '' }, { role: 'system', content: 'B' }, { role: 'user', content: 'hi' },
  ] },
];

const url = `${BASE}/v2/chat/completions`;
console.log('\n上游 role 矩阵直连探针（task#77）');
console.log(`基址 ${BASE}  模型 ${MODEL}  UA ${UA}  密钥 ${mask(KEY)}（来自 ${from}）\n`);

const rows = [];
for (const c of CASES) {
  const t0 = Date.now();
  let status = 'NET';
  let code = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': UA,
      },
      // stream:true（上游只接受流式）；max_tokens 取小避免 11133
      body: JSON.stringify({ model: MODEL, messages: c.messages, stream: true, max_tokens: 16 }),
      signal: AbortSignal.timeout(20_000),
    });
    status = `HTTP ${res.status}`;
    const text = await res.text().catch(() => '');
    const m = /"code"\s*:\s*(\d+)/.exec(text) || /(11\d{3})/.exec(text);
    if (m) code = m[1];
  } catch (e) {
    status = 'NET';
    code = String(e.message || e).slice(0, 40);
  }
  rows.push({ 用例: c.name, 结果: status + (code ? ` / ${code}` : ''), 耗时: `${Date.now() - t0}ms` });
}

console.table(rows);
const twoSystem = rows[0].结果.startsWith('HTTP 200');
console.log('\n结论');
console.log(`  多个 system（[system, system, user]）→ ${twoSystem ? '✅ 上游接受 → 就地 1:1 转换即可' : '❌ 上游拒绝 → 需合并为单个 system'}`);
if (!rows[1].结果.startsWith('HTTP 200')) console.log('  （三个 system 也不通过 —— 同样按合并处理）');
console.log('');
