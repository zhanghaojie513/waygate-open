/**
 * 端到端冒烟脚本（本地，不需要上游密钥）。
 *
 * 覆盖：启动 → /healthz → 无鉴权 401 → 造真实 sk-waygate- 密钥 → 鉴权 200 →
 *       模型数校验 → last_seen 回写 → 错误 key 401 → 优雅退出。
 *
 * 用法：node scripts/smoke-local.mjs
 * 退出码 0 = 全通过；非 0 = 有断言失败。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-smoke-'));

/**
 * 端口必须随机。
 *
 * 血的教训：定死 8787 时，若上一个没杀干净的实例还占着端口，
 * spawn 出的子进程会因 EADDRINUSE 立刻退出，而 `waitReady()` 却因为
 * 「端口上有人应答」而返回 true —— 于是整个测试**测的是别人的进程**，
 * 还全绿通过。随机端口 + 校验子进程存活，才能保证测的是自己起的那个。
 */
const PORT = 18_000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;

/** 控制台测试用固定口令。用环境变量注入哈希，避免依赖"首次启动随机生成"的不可测路径。 */
const ADMIN_PASSWORD = 'smoke-test-password-9f3a';
const ORIGIN = BASE; // 同源，用于通过 CSRF 校验

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function req(path, init = {}) {
  // 显式绕过系统代理：本机 http_proxy 会拦截 127.0.0.1
  const res = await fetch(BASE + path, { ...init, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如 SSE） */
  }
  return { status: res.status, text, json, headers: res.headers };
}

/**
 * 控制台管理口令的哈希。必须在 spawn 之前算好（要作为环境变量传进去）。
 * scrypt 参数默认档，耗时约 60ms，可以接受。
 */
const { hashPassword } = await import(
  (await import('node:url')).pathToFileURL(join(process.cwd(), 'dist', 'api/auth/password.js')).href
);
const adminHash = hashPassword(ADMIN_PASSWORD);

const child = spawn(process.execPath, ['dist/main.js'], {
  env: {
    ...process.env,
    RELAY_DATA_DIR: DATA_DIR,
    RELAY_UPSTREAM_KEY: '',
    RELAY_PORT: String(PORT),
    // 固定口令：本机生成哈希注入，端点就用这个口令登录。
    // 不依赖"首次启动随机生成并打印到 stdout"那条路径 —— 那条路径不可断言。
    RELAY_ADMIN_PASSWORD_HASH: adminHash,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));
/** 子进程是否已退出（被 EADDRINUSE 之类打死）。 */
let childExited = false;
child.on('exit', () => (childExited = true));

/** 等服务就绪。超时或子进程先死都算失败。 */
async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) return false; // 子进程已死 —— 端口上应答的绝不可能是它
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
  console.log('▶ 启动服务…');
  const ready = await waitReady();
  check('服务在 20s 内就绪', ready);
  if (!ready) {
    console.log('--- 服务日志 ---\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  console.log('\n▶ 1. 健康检查（不鉴权、不碰 DB）');
  const health = await req('/healthz');
  check('/healthz 返回 200', health.status === 200, `HTTP ${health.status}`);
  check('body.ok === true', health.json?.ok === true, JSON.stringify(health.json));
  check('含 version 与 uptime', typeof health.json?.version === 'string' && typeof health.json?.uptime === 'number');

  console.log('\n▶ 2. 无鉴权访问 /v1/models 必须 401');
  const noAuth = await req('/v1/models');
  check('状态码 401', noAuth.status === 401, `HTTP ${noAuth.status}`);
  check('错误体是 OpenAI 形状', noAuth.json?.error?.code === 'invalid_api_key', JSON.stringify(noAuth.json?.error));

  console.log('\n▶ 3. 格式错误的密钥 → 401（不查库快速拒绝）');
  const badFmt = await req('/v1/models', { headers: { authorization: 'Bearer not-a-relay-key' } });
  check('状态码 401', badFmt.status === 401, `HTTP ${badFmt.status}`);
  check('与无鉴权的文案完全一致（不泄露差异）', badFmt.json?.error?.message === noAuth.json?.error?.message);

  console.log('\n▶ 4. 造一把真实密钥并验证鉴权通过');
  // 动态 import 相对「本脚本」解析，故用绝对 file URL。
  // 关键：本脚本自身的 process.env 必须也指向 DATA_DIR，
  // 否则 openDatabase() 会退回默认 ./data —— 会撞上真实库里的旧记录。
  process.env.RELAY_DATA_DIR = DATA_DIR;
  const { pathToFileURL } = await import('node:url');
  const distUrl = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;
  const { generateKey, hashKey } = await import(distUrl('auth/keys.js'));
  const { openDatabase } = await import(distUrl('store/db.js'));
  const { runMigrations } = await import(distUrl('store/migrate.js'));
  const secret = readFileSync(join(DATA_DIR, 'relay.secret'), 'utf8').trim();
  const { plain, hint } = generateKey();
  const db = openDatabase();
  runMigrations(db);
  db.prepare(
    'INSERT INTO client_keys (id,name,key_hash,key_hint,scope,client,enabled,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('k_smoke01', '冒烟', hashKey(secret, plain), hint, JSON.stringify({ type: 'all' }), '冒烟客户端', 1, 'console', Date.now());

  const ok = await req('/v1/models', { headers: { authorization: `Bearer ${plain}` } });
  check('真实密钥返回 200', ok.status === 200, `HTTP ${ok.status}`);
  check('返回 object === "list"', ok.json?.object === 'list');
  check(
    '模型数 = 17（与 model-catalog.json 一致）',
    ok.json?.data?.length === 17,
    `实际 ${ok.json?.data?.length}`,
  );
  check(
    '两个映射反例正确（hy4-preview / kimi-k2.7）',
    ok.json?.data?.some((m) => m.id === 'hy4-preview') && ok.json?.data?.some((m) => m.id === 'kimi-k2.7'),
  );
  check('不掺入未沉淀的 deepseek-v3', !ok.json?.data?.some((m) => m.id === 'deepseek-v3'));

  console.log('\n▶ 5. last_seen 回写（Guard 的 touch 生效）');
  const row = db
    .prepare('SELECT key_hint, last_seen_at, last_seen_ip FROM client_keys WHERE id = ?')
    .get('k_smoke01');
  check('last_seen_at 已写入', row?.last_seen_at !== null, JSON.stringify(row));
  check('key_hint 是掩码形态（不含明文）', row?.key_hint === hint && !row.key_hint.includes(plain.slice(9, 29)));

  console.log('\n▶ 6. 停用后拒绝（enabled=0）');
  db.prepare('UPDATE client_keys SET enabled = 0 WHERE id = ?').run('k_smoke01');
  const disabled = await req('/v1/models', { headers: { authorization: `Bearer ${plain}` } });
  check('停用密钥返回 401', disabled.status === 401, `HTTP ${disabled.status}`);
  check('文案与未知密钥相同（不区分原因）', disabled.json?.error?.message === noAuth.json?.error?.message);

  console.log('\n▶ 7. 上游密钥未配置时，/v1 调用应明确失败而非静默');
  db.prepare('UPDATE client_keys SET enabled = 1 WHERE id = ?').run('k_smoke01');
  const chat = await req('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${plain}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check('未配上游密钥时返回 5xx（不是 200 空响应）', chat.status >= 500, `HTTP ${chat.status}`);
  check(
    '错误码指明是上游凭证问题',
    chat.json?.error?.code === 'upstream_credential_invalid' || chat.status >= 500,
    JSON.stringify(chat.json?.error?.code),
  );

  console.log('\n▶ 8. 控制台 API · 会话与 CSRF');
  // session 未登录：必须返回 authenticated:false，**不是 401**（契约 §3.3）
  const anonSession = await req('/api/auth/session');
  check('未登录 session 返回 200', anonSession.status === 200, `HTTP ${anonSession.status}`);
  check(
    '未登录 authenticated === false（且不是 401）',
    anonSession.json?.data?.authenticated === false,
    JSON.stringify(anonSession.json),
  );

  // 未登录访问受保护端点 → 401 / 40102
  const noSessOverview = await req('/api/overview');
  check('/api/overview 未登录返回 401', noSessOverview.status === 401, `HTTP ${noSessOverview.status}`);
  check('错误码 40102（会话缺失）', noSessOverview.json?.code === 40102, `code ${noSessOverview.json?.code}`);

  // 口令错 → 401 / 40101
  const badPw = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  check('口令错返回 401', badPw.status === 401, `HTTP ${badPw.status}`);
  check('错误码 40101', badPw.json?.code === 40101, `code ${badPw.json?.code}`);

  // 登录缺 Origin → 403 / 40301（CSRF）
  const noOrigin = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  check('缺 Origin 的 POST 返回 403', noOrigin.status === 403, `HTTP ${noOrigin.status}`);
  check('错误码 40301（CSRF）', noOrigin.json?.code === 40301, `code ${noOrigin.json?.code}`);

  // 正常登录 → 200 + Set-Cookie
  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  check('正确口令登录返回 200', login.status === 200, `HTTP ${login.status}`);
  check('返回 expiresAt', typeof login.json?.data?.expiresAt === 'string', JSON.stringify(login.json?.data));
  const setCookie = login.headers?.get?.('set-cookie') ?? '';
  check('下发 relay_sid cookie', setCookie.includes('relay_sid='), setCookie.slice(0, 60));
  check('cookie 含 HttpOnly/Secure/SameSite=Strict/Path=/api', 
    setCookie.includes('HttpOnly') && setCookie.includes('Secure') &&
    setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/api'));
  const cookie = setCookie.split(';')[0];

  console.log('\n▶ 9. 控制台 API · 概览一致性（契约 §3.4 硬约束）');
  const ov = await req('/api/overview?window=24h', { headers: { cookie } });
  check('/api/overview 登录后 200', ov.status === 200, `HTTP ${ov.status}`);
  check('强制含 provenance 字段', !!ov.json?.data?.provenance, JSON.stringify(ov.json?.data?.provenance));
  check('provenance.creditsUsed === "local"', ov.json?.data?.provenance?.creditsUsed === 'local');
  check(
    'quota.available === false 且 message 非空（不估算）',
    ov.json?.data?.quota?.available === false && (ov.json?.data?.quota?.message ?? '').length > 0,
  );
  check('quota.remain 为 null（无数据源就不编）', ov.json?.data?.quota?.remain === null);
  {
    const sum = (arr) => (arr ?? []).reduce((s, x) => s + x.credits, 0);
    const mSum = Math.round(sum(ov.json?.data?.byModel) * 100) / 100;
    const cSum = Math.round(sum(ov.json?.data?.byClient) * 100) / 100;
    const used = ov.json?.data?.metrics?.creditsUsed;
    check(
      'byModel 之和 === byClient 之和 === metrics.creditsUsed',
      mSum === cSum && cSum === used,
      `byModel=${mSum} byClient=${cSum} used=${used}`,
    );
  }
  check('window 回显为 24h', ov.json?.data?.window === '24h');

  console.log('\n▶ 10. 控制台 API · 密钥 CRUD（AC-08 明文只回显一次）');
  const createKey = await req('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ name: '冒烟新建密钥', scope: { type: 'all' }, client: '冒烟客户端' }),
  });
  check('创建密钥返回 200', createKey.status === 200, `HTTP ${createKey.status}`);
  const plainNew = createKey.json?.data?.key;
  check('响应含明文 key', typeof plainNew === 'string' && plainNew.startsWith('sk-waygate-'), String(plainNew).slice(0, 14));
  check('明文只回显一次：带 warning', typeof createKey.json?.data?.warning === 'string');
  check('新密钥形态合法（sk-waygate- + 24 hex）', /^sk-waygate-[0-9a-f]{24}$/.test(plainNew ?? ''), plainNew);
  const newId = createKey.json?.data?.id;

  // 列表永不返回明文
  const listKeys = await req('/api/keys', { headers: { cookie } });
  check('密钥列表返回 200', listKeys.status === 200, `HTTP ${listKeys.status}`);
  check(
    '列表中不含明文 key 字段',
    (listKeys.json?.data?.items ?? []).every((k) => k.key === undefined && !!k.hint),
    JSON.stringify((listKeys.json?.data?.items ?? [])[0]),
  );

  // 同名二次创建 → 409
  const dupKey = await req('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ name: '冒烟新建密钥' }),
  });
  check('同名密钥返回 409', dupKey.status === 409, `HTTP ${dupKey.status}`);
  check('错误码 40901', dupKey.json?.code === 40901, `code ${dupKey.json?.code}`);

  // 新密钥立即可用于 /v1
  const useNew = await req('/v1/models', { headers: { authorization: `Bearer ${plainNew}` } });
  check('新建密钥可立即用于 /v1/models', useNew.status === 200, `HTTP ${useNew.status}`);

  // PATCH 停用 → 该密钥立即失效
  const patch = await req(`/api/keys/${newId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ enabled: false }),
  });
  check('停用密钥返回 200', patch.status === 200, `HTTP ${patch.status}`);
  const afterDisable = await req('/v1/models', { headers: { authorization: `Bearer ${plainNew}` } });
  check('停用后该密钥 401', afterDisable.status === 401, `HTTP ${afterDisable.status}`);

  // DELETE
  const del = await req(`/api/keys/${newId}`, {
    method: 'DELETE',
    headers: { cookie, origin: ORIGIN },
  });
  check('删除密钥返回 deleted:1', del.json?.data?.deleted === 1, JSON.stringify(del.json?.data));
  const delAgain = await req(`/api/keys/${newId}`, {
    method: 'DELETE',
    headers: { cookie, origin: ORIGIN },
  });
  check('删除不存在的密钥返回 404', delAgain.status === 404, `HTTP ${delAgain.status}`);

  console.log('\n▶ 11. 控制台 API · 设置与危险操作');
  const getSettings = await req('/api/settings', { headers: { cookie } });
  check('设置返回 200', getSettings.status === 200, `HTTP ${getSettings.status}`);
  const groups = getSettings.json?.data?.groups ?? [];
  check('7 组设置', groups.length === 7, `实际 ${groups.length}`);
  check(
    '含 danger 组与 mapping 组',
    groups.some((g) => g.id === 'danger') && groups.some((g) => g.id === 'mapping'),
  );
  check('含 version 字段', typeof getSettings.json?.data?.version === 'number');

  // 非法值 → 400（服务端校验，不只信前端）
  const badPut = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ settings: [{ key: 'limits.concurrency', value: 999 }] }),
  });
  check('并发上限 999 被拒（400）', badPut.status === 400, `HTTP ${badPut.status}`);
  check('错误码 40001', badPut.json?.code === 40001, `code ${badPut.json?.code}`);

  // 公网监听需 RELAY_ALLOW_PUBLIC_BIND=1，否则 400
  const badBind = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ settings: [{ key: 'service.listenHost', value: '0.0.0.0' }] }),
  });
  check('监听 0.0.0.0 被拒（未开 ALLOW_PUBLIC_BIND）', badBind.status === 400, `HTTP ${badBind.status}`);

  // 合法修改
  const goodPut = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ settings: [{ key: 'limits.concurrency', value: 8 }] }),
  });
  check('合法修改返回 200', goodPut.status === 200, `HTTP ${goodPut.status}`);
  check('返回 applied 与 version', typeof goodPut.json?.data?.applied === 'number' && typeof goodPut.json?.data?.version === 'number');

  // danger：confirm 不是「确认」→ 400/40002
  const badConfirm = await req('/api/settings/danger', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ action: 'clearLogs', confirm: 'ok' }),
  });
  check('confirm 不匹配返回 400', badConfirm.status === 400, `HTTP ${badConfirm.status}`);
  check('错误码 40002', badConfirm.json?.code === 40002, `code ${badConfirm.json?.code}`);

  // danger：正确 confirm → 量化影响面
  const goodConfirm = await req('/api/settings/danger', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
    body: JSON.stringify({ action: 'clearLogs', confirm: '确认' }),
  });
  check('confirm 正确返回 200', goodConfirm.status === 200, `HTTP ${goodConfirm.status}`);
  check('返回 affected.logs（量化后果）', typeof goodConfirm.json?.data?.affected?.logs === 'number', JSON.stringify(goodConfirm.json?.data));

  console.log('\n▶ 12. 控制台 API · 请求日志与模型目录');
  const reqList = await req('/api/requests?page=1&limit=5', { headers: { cookie } });
  check('请求列表返回 200', reqList.status === 200, `HTTP ${reqList.status}`);
  check('含分页字段 total/page/limit/hasMore', 
    ['total', 'page', 'limit', 'hasMore'].every((k) => k in (reqList.json?.data ?? {})));
  check(
    '列表不含 requestBody/responseBody',
    (reqList.json?.data?.items ?? []).every((r) => r.requestBody === undefined && r.responseBody === undefined),
  );

  const notFoundReq = await req('/api/requests/999999', { headers: { cookie } });
  check('不存在的请求 id 返回 404', notFoundReq.status === 404, `HTTP ${notFoundReq.status}`);

  const catalog = await req('/api/models/catalog', { headers: { cookie } });
  check('模型目录返回 200', catalog.status === 200, `HTTP ${catalog.status}`);
  check('目录含 17 个模型', (catalog.json?.data?.models ?? []).length === 17, `实际 ${(catalog.json?.data?.models ?? []).length}`);
  check('含 upstreamReachable 与 source 字段',
    'upstreamReachable' in (catalog.json?.data ?? {}) && typeof catalog.json?.data?.source === 'string');

  // 未配上游密钥时，手动刷新应明确拒绝（400）而不是静默成功
  const refresh = await req('/api/models/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
  });
  check('未配上游密钥时刷新被拒（400）', refresh.status === 400, `HTTP ${refresh.status}`);

  console.log('\n▶ 13. 控制台 API · 登出');
  const logout = await req('/api/auth/logout', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN },
  });
  check('登出返回 200', logout.status === 200, `HTTP ${logout.status}`);
  const cleared = logout.headers?.get?.('set-cookie') ?? '';
  check('登出清 cookie（Max-Age=0）', cleared.includes('Max-Age=0'), cleared.slice(0, 70));

  console.log('\n▶ 14. 优雅退出（SIGTERM 后端口释放）');
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 2500));
  let released = false;
  try {
    await req('/healthz');
  } catch {
    released = true;
  }
  check('SIGTERM 后不再响应', released);
} catch (err) {
  console.log('  ❌ 脚本异常：' + err.message);
  fail += 1;
} finally {
  cleanup();
}

console.log(`\n${'='.repeat(48)}`);
console.log(`冒烟结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(48));
process.exit(fail === 0 ? 0 : 1);
