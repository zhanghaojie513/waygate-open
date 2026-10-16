/**
 * v1.6.12「导入客户端」端到端验收（隔离实例，不碰生产凭据）。
 *
 * ## 验什么
 * 三家客户端的**设备授权**是三种不同协议，「未授权」信号也各不相同 ——
 * 这正是本功能最容易写错的地方（照抄必错）：
 *   · WorkBuddy  → 未授权是**业务码非 0**（实测 11217 "login ing"）
 *   · MiniMax    → 未授权是 **HTTP 400 + authorization_pending**（PKCE S256 强制）
 *   · Qoder      → 未授权是 **HTTP 404**（官方 CLI 亦以 404 判"继续等"）
 *
 * 所以本脚本真调三家上游的 `start`（**申请**授权，不消耗任何凭据）拿 authUrl，
 * 再调 `poll` 确认**在未授权时正确回报 `pending`**（而不是误报 error/done）。
 *
 * ## 为什么必须真调上游
 * 只断言「路由存在」（403 vs 404）证明不了协议写对了 —— 参数错会被上游 400 挡回来，
 * 而单测无法覆盖真实上游。本脚本是唯一能证明「三家参数真被接受」的手段。
 *
 * ## 安全边界
 *   · `start` 只申请 device_code / state，**不消耗任何令牌**（授权动作在浏览器里，脚本不做）。
 *   · `poll` 在未授权时上游不会签发任何令牌 —— 只读语义，零消耗。
 *   · 用生产库快照 + 一次性口令起隔离实例，绝不触碰生产进程与凭据。
 *
 * 用法（服务器上跑，与 verify-all 同一形态）：
 *   cd /opt/relay/server && node tools/e2e-device-import.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRV = process.cwd();
const DATA = process.env.RELAY_DATA_DIR || '/var/lib/relay';
const ENTRY = join(SRV, 'dist', 'main.js');
const PASSWORD_MODULE = join(SRV, 'dist', 'api', 'auth', 'password.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

const iso = mkdtempSync(join(tmpdir(), 'e2e-device-'));
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const PW = 'e2e-device-onetime-0000';
const { hashPassword } = await import(pathToFileURL(PASSWORD_MODULE).href);

// 快照生产库（同 verify-all：VACUUM INTO 才能拿到 WAL 里的写入）。
{
  const DB = (await import(join(SRV, 'node_modules', 'better-sqlite3', 'lib', 'index.js'))).default;
  const vdb = new DB(DATA + '/relay.db', { readonly: true });
  vdb.exec(`VACUUM INTO '${iso}/relay.db'`);
  vdb.close();
}

const child = spawn(process.execPath, [ENTRY], {
  cwd: SRV,
  env: { ...process.env, RELAY_DATA_DIR: iso, RELAY_PORT: String(port), RELAY_UPSTREAM_KEY: '', RELAY_ADMIN_PASSWORD_HASH: hashPassword(PW) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
for (let i = 0; i < 80 && !booted; i++) {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1000) });
    if (r.status === 200) booted = true;
  } catch {
    /* not up yet */
  }
  await sleep(250);
}
check('隔离实例启动', booted);

if (booted) {
  const req = async (p, init = {}) => {
    const r = await fetch(BASE + p, {
      ...init,
      headers: { origin: BASE, ...(init.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie') ?? '' };
  };
  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  check('登录', login.status === 200, `HTTP ${login.status}`);
  const cookie = login.cookie.split(';')[0];

  /* 三家各建一行（无凭证），拿到 id 后再走 start/poll —— 与前端流程一致。 */
  const CASES = [
    { protocol: 'openai', label: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com' },
    { protocol: 'anthropic', label: 'MiniMax Code', baseUrl: 'https://agent.minimax.cn' },
    { protocol: 'qoder', label: 'Qoder CN', baseUrl: 'https://gateway.qoder.com.cn' },
  ];

  for (const c of CASES) {
    const created = await req('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `e2e-${c.protocol}`, baseUrl: c.baseUrl, credential: '', protocol: c.protocol }),
    });
    const id = created.json?.data?.item?.id;
    if (!id) {
      check(`${c.label} 建行（无凭证）`, false, JSON.stringify(created.json).slice(0, 120));
      continue;
    }

    /* ① start：申请授权 —— 真打上游，拿 authUrl。 */
    const start = await req(`/api/providers/${id}/import-device/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    const d = start.json?.data ?? {};
    check(`${c.label} start 拿到 authUrl`, !!d.authUrl, d.authUrl ? d.authUrl.slice(0, 72) : JSON.stringify(start.json).slice(0, 140));
    if (d.userCode) console.log(`     userCode: ${d.userCode}`);
    if (!d.authUrl) continue;

    /* ② 安全断言：私有状态绝不回传浏览器。 */
    const leaked = ['device_code', 'deviceCode', 'code_verifier', 'codeVerifier'].filter((k) => k in d);
    check(`${c.label} 私有状态不外泄`, leaked.length === 0, leaked.length ? `泄漏=${leaked.join(',')}` : 'ok');

    /* ③ poll：未授权 —— 三家各自的「等待中」信号都要被正确识别为 pending。 */
    const poll = await req(`/api/providers/${id}/import-device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    const pd = poll.json?.data ?? {};
    check(`${c.label} 未授权时 poll=pending`, pd.status === 'pending', `status=${pd.status} msg=${pd.message ?? ''}`);
  }
}

child.kill('SIGTERM');
await sleep(300);
try {
  rmSync(iso, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n====== 汇总 ======\n通过 ${pass} 项；失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
