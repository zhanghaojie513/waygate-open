/**
 * 密钥前缀更名（sk-relay- → sk-waygate-）的端到端验证。
 *
 * 为什么需要它：守卫在查库前用 `looksLikeRelayKey()`（KEY_PATTERN）做形态快速拒绝，
 * 若只认新前缀，**库里所有存量密钥会立刻 401** —— 这是本次更名唯一的灾难性失效模式，
 * 单测能钉住正则，但「旧前缀密钥真的能通过守卫拿到 200」必须真机跑一次才算数。
 *
 * 手法（零生产污染）：隔离实例 + **全新临时库** + 已知 RELAY_SECRET：
 *   ① 控制台建密钥 → 断言明文是 sk-waygate- 形态（35 字符）
 *   ② 用同一个 secret 直接写一行**旧前缀**密钥（hash 与真实签发路径同构）
 *   ③ GET /v1/models：新密钥必须 200；**旧前缀密钥必须 401**（更名窗口已关闭，
 *      旧前缀在形态检查阶段即被拒）；乱码 401
 *
 * 用法（在 /opt/relay/server 下）：
 *   node tools/probe-key-prefix.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import Database from 'better-sqlite3';

const SRV = '/opt/relay/server';
const ENTRY = join(SRV, 'dist', 'main.js');
const PASSWORD_MODULE = join(SRV, 'dist', 'api', 'auth', 'password.js');
const KEYS_MODULE = join(SRV, 'dist', 'auth', 'keys.js');
const PW = 'probe-key-prefix-onetime-0000';
/** 固定 secret：探针要自己算旧前缀密钥的 hash，必须知道它（生产用环境变量注入，不是这个值）。 */
const SECRET = 'probe-secret-for-key-prefix-0123456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const iso = mkdtempSync(join(tmpdir(), 'probe-prefix-'));
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const { hashPassword } = await import(pathToFileURL(PASSWORD_MODULE).href);
const { hashKey, KEY_PREFIX, KEY_PATTERN } = await import(pathToFileURL(KEYS_MODULE).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const child = spawn(process.execPath, [ENTRY], {
  cwd: SRV,
  env: {
    ...process.env,
    RELAY_DATA_DIR: iso,
    RELAY_PORT: String(port),
    RELAY_SECRET: SECRET,
    RELAY_UPSTREAM_KEY: '',
    RELAY_ADMIN_PASSWORD_HASH: hashPassword(PW),
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) up = true;
    } catch {}
    await sleep(250);
  }
  if (!up) throw new Error('隔离实例未启动');
  console.log(`隔离实例就绪（库=${iso}）\n`);

  const req = async (p, init = {}) => {
    const r = await fetch(BASE + p, {
      ...init,
      headers: { origin: BASE, ...(init.headers || {}) },
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie') ?? '' };
  };

  // ① 登录 + 建密钥
  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  if (login.status !== 200) throw new Error(`登录失败 HTTP ${login.status}`);
  const cookie = login.cookie.split(';')[0];

  const created = await req('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'prefix-probe-new' }),
  });
  const newKey = created.json?.data?.key;
  check(
    '① 新建密钥用新前缀 sk-waygate-',
    typeof newKey === 'string' && newKey.startsWith(KEY_PREFIX),
    `plain=${typeof newKey === 'string' ? newKey.slice(0, 14) + '…' : JSON.stringify(created.json).slice(0, 120)}`,
  );
  check('①b 新密钥总长 35（11 位前缀 + 24 位十六进制）', typeof newKey === 'string' && newKey.length === 35, `len=${newKey?.length}`);
  check('①c 新密钥 hint 保留新前缀', String(created.json?.data?.hint ?? '').startsWith('sk-waygate-'), `hint=${created.json?.data?.hint}`);

  // ② 直接写一行旧前缀密钥（hash 走真实同构路径）
  const legacyPlain = 'sk-relay-0123456789abcdef01234567';
  const db = new Database(join(iso, 'relay.db'));
  db.prepare(
    `INSERT INTO client_keys (id, name, key_hash, key_hint, scope, client, clients, enabled, expires_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'console', ?)`,
  ).run(
    'k_legacy01',
    'prefix-probe-legacy',
    hashKey(SECRET, legacyPlain),
    'sk-relay-0123…4567',
    '{"type":"all"}',
    null,
    '[]',
    Date.now(),
  );
  db.close();
  check('② 已写入一行旧前缀密钥（模拟更名前签发）', true, legacyPlain.slice(0, 12) + '…');

  // ③ 鉴权实测：新前缀 / 旧前缀都必须 200，乱码必须 401
  const auth = async (key) => {
    const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    return r.status;
  };
  const sNew = await auth(newKey);
  const sLegacy = await auth(legacyPlain);
  const sBogus = await auth('sk-waygate-not-a-real-key');

  check('③ 新前缀密钥可鉴权（/v1/models 200）', sNew === 200, `HTTP ${sNew}`);
  check('③b ★ 旧前缀密钥已被拒（更名窗口关闭，形态检查即 401）', sLegacy === 401, `HTTP ${sLegacy}`);
  check('③c 非法密钥被拒（401）', sBogus === 401, `HTTP ${sBogus}`);
  check('③d 新前缀进 KEY_PATTERN（守卫不查库即可放行）', KEY_PATTERN.test('sk-waygate-' + '0'.repeat(24)), '');
  check('③e 旧前缀已移出 KEY_PATTERN', KEY_PATTERN.test('sk-relay-' + '0'.repeat(24)) === false, '');
} catch (e) {
  check('探针执行', false, e.message);
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  try {
    rmSync(iso, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n====== 汇总：通过 ${results.length - failed.length}/${results.length} ======`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'));
  process.exit(1);
}
