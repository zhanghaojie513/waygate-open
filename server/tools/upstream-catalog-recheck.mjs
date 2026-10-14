#!/usr/bin/env node
/**
 * 驿站 · Relay — 上游模型目录「端点重探」（task #17）
 *
 * ## 为什么要在服务器侧跑
 *
 * 上游凭证**明文只存在于服务端**：库里只有掩码/哈希，读不回来。
 * 运行时加载优先级（见 config.service.ts:loadUpstreamKey）：
 *   1. 环境变量 `RELAY_UPSTREAM_KEY`（含 systemd `EnvironmentFile` 注入的 `.env`）
 *   2. `<RELAY_DATA_DIR>/upstream.key`（控制台 `PUT /api/settings/credential` 的落点）
 * 本脚本**完全复刻这条优先级**，因此能拿到与运行时同一把 key。
 *
 * ⛔ 安全：全程只打印掩码；key 不落任何输出（stdout/stderr/文件）。
 *    只做只读 GET 探测，不改上游任何状态。
 *
 * ## 用法（在服务器 `/opt/relay/server/` 下）
 *
 *   node tools/upstream-catalog-recheck.mjs
 *
 * 可选环境变量：
 *   RELAY_DATA_DIR        数据目录（默认 <cwd>/data；部署时即 /var/lib/relay）
 *   RELAY_UPSTREAM_BASE   上游基址（默认 https://copilot.tencent.com）
 *   RELAY_SPOOF_UA        伪装 UA（默认 WorkBuddy/5.6.2；上游对 UA 有校验）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.RELAY_UPSTREAM_BASE || 'https://copilot.tencent.com').replace(/\/+$/, '');
const UA = process.env.RELAY_SPOOF_UA || 'WorkBuddy/5.6.2';

function resolveDataDir() {
  const configured = (process.env.RELAY_DATA_DIR ?? '').trim();
  return configured || join(process.cwd(), 'data');
}

/** 复刻 config.service.ts 的加载优先级：环境变量 → 数据目录文件。 */
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

/**
 * 候选端点表。依据（实测依据）：
 *  - primary: `/v2/enterprises/personal/models` —— prior art 记录的国内版目录路径，
 *    无凭证判别实测返回 401（路由存在），旧探针从未试过它。
 *  - config:  `/v3/config` —— prior art 记录的国际版目录路径，匿名可达但 models:null。
 *  - control: 旧探针试过的路径，无凭证判别实测 404（路由不存在），仅作对照。
 */
const CANDIDATES = [
  { kind: 'catalog', path: '/v2/enterprises/personal/models', note: 'prior art 国内版目录（首选）' },
  { kind: 'catalog', path: '/v2/enterprises/personal/models?scene=codebuddy', note: '带 scene 查询参数' },
  { kind: 'config', path: '/v3/config', note: 'prior art 国际版目录 / 客户端配置' },
  { kind: 'control', path: '/v2/models', note: '旧探针路径（预期 404）' },
  { kind: 'control', path: '/v1/models', note: '旧探针路径（预期 404）' },
  { kind: 'control', path: '/v2/model/list', note: '旧探针路径（预期 404）' },
];

/** 从响应里尽力抽出模型数组（兼容 data[] / models[] / list[]）。 */
function extractModels(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload;
  const containers = [obj.data, obj.models, obj.list, obj.result];
  for (const c of containers) {
    const arr = Array.isArray(c) ? c : c && Array.isArray(c.models) ? c.models : c && Array.isArray(c.list) ? c.list : null;
    if (arr && arr.length) return arr;
  }
  return null;
}

async function probe({ kind, path, note }) {
  const url = BASE + path;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}`, accept: 'application/json', 'user-agent': UA },
    });
    const ms = Date.now() - t0;
    const text = await res.text().catch(() => '');
    let models = null;
    let shape = null;
    try {
      const json = JSON.parse(text);
      models = extractModels(json);
      shape = models ? `模型 ${models.length} 项，首项键：${Object.keys(models[0] || {}).slice(0, 12).join(',')}` : null;
    } catch { /* 非 JSON */ }
    return { kind, path, note, status: res.status, ms, models, shape, text: text.slice(0, 240) };
  } catch (e) {
    return { kind, path, note, status: 'NET', ms: Date.now() - t0, models: null, shape: null, text: String(e.message || e) };
  }
}

const { key: KEY, from } = loadUpstreamKey();
if (!KEY) {
  console.error('\n未找到上游访问密钥。请确认服务器上已配置（RELAY_UPSTREAM_KEY 或 <数据目录>/upstream.key）。\n');
  process.exit(2);
}

console.log('\n驿站 · Relay —— 上游模型目录端点重探');
console.log(`基址    ${BASE}`);
console.log(`密钥    ${mask(KEY)}   （来自 ${from}，完整值不打印）`);
console.log(`UA      ${UA}\n`);

const rows = [];
for (const c of CANDIDATES) {
  const r = await probe(c);
  rows.push({
    类型: r.kind,
    路径: r.path,
    结果: r.status === 'NET' ? 'NET' : `HTTP ${r.status}`,
    耗时: `${r.ms}ms`,
    判读: r.shape ? `✅ ${r.shape}` : r.text.replace(/\s+/g, ' ').slice(0, 60),
  });
}
console.table(rows);

const hit = rows.some((r) => r.判读.startsWith('✅'));
console.log('\n结论');
if (hit) {
  console.log('  ✅ 找到可用目录端点（见上表 ✅ 行）。');
  console.log('  → 下一步：把返回体脱敏样本 + 端点路径发回，用于实现「运行时拉取」。');
} else {
  console.log('  ❌ 本次候选全部未返回模型清单。');
  console.log('  → 检查状态码：401=鉴权/格式问题；404=路由不存在；200 但 models:null=需带上下文参数。');
  console.log('  → 兜底：清单 = 种子 ∪ requests 表里实际成功调用过的模型，并在界面标注来源。');
}
console.log('');
