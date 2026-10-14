/**
 * 凭证推送到远程 relay（v1.6.5）—— 分离部署用的一条命令。
 *
 * ## 为什么需要它
 * relay 跑在服务器、客户端登录态在本机时，服务器**读不到**本机文件，控制台按钮
 * 只能提示「写一条命令在本机跑」。本脚本就是那条命令：在本机读客户端登录态，
 * 登录 relay 控制台（HTTP-only cookie），PATCH 该提供商的凭证。全程 HTTPS。
 *
 * ## 用法
 *   node tools/import-credential-push.mjs <relay地址> minimax --password <管理口令>
 *   node tools/import-credential-push.mjs <relay地址> qoder   --password <管理口令>
 *   # provider_id 省略时按协议自动取第一条（多家时用 --provider <id> 指定）
 *
 * relay 地址形如 https://relay.example.com 或 https://relay.example.com:8443。
 * 自签证书时加 --insecure（仅本机信任链场景使用）。
 *
 * ## 安全
 *   · 口令与 token 都只在本进程内存；不经命令行回显（口令建议用 env RELAY_ADMIN_PASSWORD）。
 *   · 只走 HTTPS；--insecure 需显式指定。
 */

import { mask, qoderClientPresent, readQoderIdentity, minimaxClientPresent, readMinimaxRefreshToken } from './lib/read-client-credential.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const base = process.argv[2];
const kind = process.argv[3];
if (!base || !kind || !['minimax', 'qoder'].includes(kind)) {
  console.error('用法: node tools/import-credential-push.mjs <relay地址> <minimax|qoder> [--password <口令>] [--provider <id>] [--insecure]');
  process.exit(2);
}
const password = arg('password') ?? process.env.RELAY_ADMIN_PASSWORD ?? '';
if (!password) {
  console.error('缺少管理口令：用 --password <口令> 或环境变量 RELAY_ADMIN_PASSWORD 提供。');
  process.exit(2);
}

const origin = base.replace(/\/+$/, '');
/* 自签证书（自用单机常见）：需显式 --insecure 才放行，且只影响本进程。 */
if (has('insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * 非幂等方法必须带 `Origin`：relay 的 CSRF 防护对 POST/PATCH **缺失 Origin 一律 403**
 * （有意的设计 —— 浏览器必带，缺失意味着脚本来源）。脚本这里显式声明自己的 origin
 * 与目标同源，等价于「浏览器从控制台页面发出的请求」。
 */
const originHeader = { origin };

/** 收集 Set-Cookie 里的 relay_sid（Node fetch 的 getSetCookie 或回退解析）。 */
function extractSession(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    const m = /(?:^|,\s*)relay_sid=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  /* ① 读本机客户端登录态（先读，早失败早报，避免白登录一次） */
  let credential;
  let label;
  if (kind === 'qoder') {
    if (!qoderClientPresent()) throw new Error('本机找不到 Qoder CN 客户端登录态（客户端未登录？）');
    const { identity } = readQoderIdentity();
    credential = JSON.stringify(identity);
    label = `uid=${identity.uid} token=${mask(identity.token, 6)}`;
  } else {
    if (!minimaxClientPresent()) throw new Error('本机找不到 MiniMax Code 客户端登录态（客户端未登录？）');
    const { refreshToken, accountKey, rec } = readMinimaxRefreshToken();
    credential = refreshToken;
    label = `账号=${accountKey} token=${mask(refreshToken)} clientId=${rec.clientId ?? '—'}`;
  }
  console.log(`读到了 ${kind} 凭证：${label}`);

  /* ② 登录 relay 控制台 */
  const loginRes = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...originHeader },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) {
    const t = await loginRes.text().catch(() => '');
    throw new Error(`登录失败（HTTP ${loginRes.status}）${t ? `：${t.slice(0, 200)}` : ''}`);
  }
  const sid = extractSession(loginRes);
  if (!sid) throw new Error('登录成功但没拿到会话 cookie（relay 版本过旧？）');
  const cookie = `relay_sid=${sid}`;

  /* ③ 找到目标提供商 */
  const listRes = await fetch(`${origin}/api/providers`, { headers: { cookie } });
  if (!listRes.ok) throw new Error(`读取提供商列表失败（HTTP ${listRes.status}）`);
  const env = await listRes.json();
  /* `/api/providers` 的 data 形状是 `{ items: [...] }`（不是裸数组）。 */
  const rows = Array.isArray(env?.data?.items) ? env.data.items : Array.isArray(env?.data) ? env.data : [];
  const wantProto = kind === 'qoder' ? 'qoder' : 'anthropic';
  const explicit = arg('provider');
  const target = explicit
    ? rows.find((r) => r.id === explicit)
    : rows.find((r) => r.protocol === wantProto);
  if (!target) {
    throw new Error(`relay 上没有${explicit ? ` id=${explicit}` : ` ${wantProto} 协议的`}提供商（先去「客户端管理」建一条）。`);
  }

  /* ④ 推送凭证 */
  const patchRes = await fetch(`${origin}/api/providers/${encodeURIComponent(target.id)}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', ...originHeader },
    body: JSON.stringify({ credential }),
  });
  if (!patchRes.ok) {
    const t = await patchRes.text().catch(() => '');
    throw new Error(`推送失败（HTTP ${patchRes.status}）${t ? `：${t.slice(0, 300)}` : ''}`);
  }
  console.log(`\n已推送 ${kind} 凭证 → ${target.name}（id=${target.id}）`);
  console.log('到控制台「客户端管理 → 提供商」点「测试」确认可用；令牌过期后重跑本脚本。');
}

main().catch((e) => {
  console.error(`推送失败：${e.message}`);
  process.exit(1);
});
