/**
 * 端到端链路验证：失败的请求必须落库（spec-v4-failure-logging.md §7）。
 *
 * 与单测（`src/proxy/proxy-failure.spec.ts`，内存库 + 直接 new 对象）互补：
 * 这里**真起服务**（`dist/main.js`，走 Nest DI）+ **真 SQLite 文件** + **真 HTTP**，
 * 因此能覆盖「DI 装配 / 迁移后的真库 / 传输层」这些单测碰不到的地方
 * —— 正是这条链路最早揪出了 `ProxyLogger` 未加 `@Injectable()` 导致的落库静默失败。
 *
 * 前置：`npm run build`（需要 dist/）。
 * 用法：`node tools/e2e-failure-logging.mjs`
 * 退出码 0 = 全通过；非 0 = 有断言失败。
 *
 * 说明：上游 base 在代码里写死为 copilot.tencent.com，无法指向任意死地址，
 * 故 ① 用「未配上游密钥」触发真实失败（空 Bearer → 上游 401 → 502
 * upstream_credential_invalid，即 C8 场景）。若离线，fetch 抛错 → 502
 * upstream_unreachable，同样是「落一行 502 / credits=0 / first_byte_ms NULL」，断言不变。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_DIR = process.cwd();
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-e2e-fail-'));
const PORT = 18_500 + Math.floor(Math.random() * 1500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'e2e-failure-password-7c1d';
const ORIGIN = BASE;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE / 非 JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

const distUrl = (p) => pathToFileURL(join(SERVER_DIR, 'dist', p)).href;
const { hashPassword } = await import(distUrl('api/auth/password.js'));
const adminHash = hashPassword(ADMIN_PASSWORD);

const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    RELAY_DATA_DIR: DATA_DIR,
    RELAY_UPSTREAM_KEY: '',
    RELAY_PORT: String(PORT),
    RELAY_ADMIN_PASSWORD_HASH: adminHash,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));
let childExited = false;
child.on('exit', () => (childExited = true));

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) return false; // 子进程已死 —— 端口上应答的绝不是它
    try {
      const r = await req('/healthz');
      if (r.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function cleanup() {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

try {
  console.log('启动服务…');
  const ready = await waitReady();
  check('服务就绪', ready);
  if (!ready) {
    console.log('--- 服务日志 ---\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  // 造一把真实 sk-waygate- 密钥（真库写入），供 /v1 鉴权。
  process.env.RELAY_DATA_DIR = DATA_DIR;
  const { generateKey, hashKey } = await import(distUrl('auth/keys.js'));
  const { openDatabase } = await import(distUrl('store/db.js'));
  const { runMigrations } = await import(distUrl('store/migrate.js'));
  const secret = readFileSync(join(DATA_DIR, 'relay.secret'), 'utf8').trim();
  const { plain, hint } = generateKey();
  const db = openDatabase();
  runMigrations(db);
  db.prepare(
    'INSERT INTO client_keys (id,name,key_hash,key_hint,scope,client,enabled,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('k_e2e', 'E2E', hashKey(secret, plain), hint, JSON.stringify({ type: 'all' }), 'E2E 客户端', 1, 'console', Date.now());

  const auth = { authorization: `Bearer ${plain}`, 'content-type': 'application/json' };
  const latest = () => db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get();
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;

  console.log('\n① 上游失败（未配上游密钥）→ 落一行 502 / credits=0 / first_byte_ms NULL');
  const chat = await req('/v1/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check('返回 502', chat.status === 502, `HTTP ${chat.status} code=${JSON.stringify(chat.json?.error?.code)}`);
  const r502 = latest();
  check(
    '落一行 status=502 / credits=0 / first_byte_ms IS NULL',
    r502?.status === 502 && r502?.credits === 0 && r502?.first_byte_ms === null,
    JSON.stringify({ status: r502?.status, credits: r502?.credits, first_byte_ms: r502?.first_byte_ms, note: r502?.note }),
  );

  console.log('\n② 本地拒绝（assertBodyShape：缺 messages）→ 落一行 400');
  const bad = await req('/v1/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'kimi-k3' }),
  });
  check('返回 400', bad.status === 400, `HTTP ${bad.status}`);
  check('落库行数 +1（累计 2 行）', count() === 2, `count=${count()}`);
  const r400 = latest();
  check(
    '落一行 status=400 / credits=0 / note=bad request body',
    r400?.status === 400 && r400?.credits === 0 && String(r400?.note).includes('bad request body'),
    JSON.stringify({ status: r400?.status, credits: r400?.credits, note: r400?.note, model: r400?.model }),
  );

  console.log('\n③ 成功率不再恒 ~100%：清库后 3 成功 + 1 失败 → /api/overview successRate = 0.75');
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM aggregates').run();
  const cols = [
    'ts', 'trace_id', 'client_id', 'client', 'client_rule', 'key_id', 'key_hint', 'model', 'model_display',
    'status', 'upstream_code', 'ms', 'queued_ms', 'first_byte_ms', 'prompt_tokens', 'completion_tokens',
    'total_tokens', 'credits', 'stream', 'retry_count', 'note', 'remote_ip', 'ua', 'request_body',
    'response_body', 'created_at',
  ];
  const ins = db.prepare(`INSERT INTO requests (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (let i = 0; i < 3; i++) {
    ins.run(
      Date.now(), `ok-${i}`, 'k_e2e', 'E2E 客户端', 2, 'k_e2e', hint, 'kimi-k3', 'Kimi K3', 200, null, 100, 0, 40,
      100, 50, 150, 1, 1, 0, '', null, null, null, null, Date.now(),
    );
  }
  const failCall = await req('/v1/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check('失败调用返回 502', failCall.status === 502, `HTTP ${failCall.status}`);

  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  check('控制台登录成功', login.status === 200, `HTTP ${login.status}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const ov = await req('/api/overview?window=24h', { headers: { cookie } });
  const m = ov.json?.data?.metrics ?? {};
  check('requests=4', m.requests === 4, `requests=${m.requests}`);
  check('successRate=0.75', m.successRate === 0.75, `successRate=${m.successRate}`);
  const sumM = (ov.json?.data?.byModel ?? []).reduce((s, x) => s + x.credits, 0);
  const sumC = (ov.json?.data?.byClient ?? []).reduce((s, x) => s + x.credits, 0);
  check(
    '积分一致性：creditsUsed = ΣbyModel = ΣbyClient（失败行 credits=0 不破坏等式）',
    Math.round(sumM * 100) / 100 === m.creditsUsed && Math.round(sumC * 100) / 100 === m.creditsUsed,
    `used=${m.creditsUsed} byModel=${sumM} byClient=${sumC}`,
  );
} catch (err) {
  console.log('  脚本异常：' + err.message);
  fail += 1;
} finally {
  cleanup();
}

console.log(`\n==== E2E 失败落库链路：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
