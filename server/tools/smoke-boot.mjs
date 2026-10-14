/**
 * 冒烟：**真启动一次构建产物（dist/main.js）并打 /healthz**。
 *
 * 为什么必须有它：Nest 的装配缺陷（provider 缺失、原始类型参数、忘写
 * `@Injectable()`）**单测抓不到** —— 单测直接 `new` 依赖、绕过 IoC 容器，
 * 233 个测试全绿，应用却起不来。这类事故已经发生**两次**：
 *   ① ProxyLogger 缺 `@Injectable()` → 运行时静默 no-op
 *   ② CatalogSyncService 第 5 参是 `number` → UnknownDependenciesException，
 *      整个服务启动失败（线上真事故，靠回滚恢复）
 * 两次都只能靠「真启动」拦住。`scripts/smoke-local.mjs` 虽然也会真启动，但它
 * 不在门禁链里、且依赖较多断言；这里补一个**最小、快、可进 CI** 的启动门禁。
 *
 * 设计要点：
 *   - **不依赖上游**：临时数据目录 + 随机空闲端口 + 不设 RELAY_UPSTREAM_KEY。
 *     上游密钥缺失**不阻止**启动（main.ts 的设计），故冒烟与凭证无关。
 *   - **临时库**：`RELAY_DATA_DIR` 指向 mkdtemp 出来的目录，进程退出后删除。
 *     绝不动 ./data 或线上 /var/lib/relay。
 *   - **不误连旧进程**：随机空闲端口 + 校验子进程存活，避免连上残留实例
 *     「全绿但什么都没测」。
 *   - **不吐一次性口令**：注入固定的管理口令哈希，走可控路径，避免子进程把
 *     「首次启动随机生成的口令」打进 stdout（那既是噪声也是敏感信息）。
 *   - 断言链：服务就绪 → /healthz 200 → 登录 → **GET /api/models/catalog 200**
 *     （最后一条直接覆盖出事故的那个模块的注入图）。
 *   - 子进程输出**缓冲**，仅在失败时打印（成功时 CI 只看到一行结论）。
 *   - 退出码：0 = 全部通过；非 0 = 失败（CI 直接判红）。
 *
 * 用法：
 *   node tools/smoke-boot.mjs
 *   （前置：先 npm run build）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const ENTRY = join(SERVER_ROOT, 'dist', 'main.js');
const PASSWORD_MODULE = join(SERVER_ROOT, 'dist', 'api', 'auth', 'password.js');

/** /healthz 的等待上限（冷启动含 SQLite 建表 + Nest 装配，给足余量）。 */
const BOOT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

if (!existsSync(ENTRY)) {
  console.error(`找不到构建产物 ${ENTRY}\n请先执行： npm run build`);
  process.exit(2);
}

/** 取一个当前空闲的 TCP 端口（listen(0) 让内核分配），避免撞上残留进程。 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(url, isAlive) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr = '未发起请求';
  while (Date.now() < deadline) {
    if (!isAlive()) return { ok: false, reason: '子进程已退出（见下方子进程输出）' };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body && body.ok === true) {
        return { ok: true, body };
      }
      lastErr = `HTTP ${res.status} body=${JSON.stringify(body)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, reason: `超时 ${BOOT_TIMEOUT_MS}ms 未就绪：${lastErr}` };
}

/** 简化的请求助手：返回 { status, json, setCookie }。 */
async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') ?? '' };
}

// 固定口令：注入哈希，走可控路径，避免「首次启动随机生成口令并打印」。
// 该口令仅用于本次冒烟进程、随临时库一起丢弃，无实际价值。
const ADMIN_PASSWORD = 'smoke-boot-password-0000';
const { hashPassword } = await import(pathToFileURL(PASSWORD_MODULE).href);
const adminHash = hashPassword(ADMIN_PASSWORD);

const dataDir = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const healthUrl = `${BASE}/healthz`;

console.log(`[smoke-boot] 启动 ${ENTRY}`);
console.log(`[smoke-boot] RELAY_DATA_DIR=${dataDir}`);
console.log(`[smoke-boot] RELAY_PORT=${port}`);

const child = spawn(process.execPath, [ENTRY], {
  cwd: SERVER_ROOT,
  env: {
    ...process.env,
    RELAY_DATA_DIR: dataDir,
    RELAY_PORT: String(port),
    // 冒烟与凭证无关：显式清掉，确保验证的是「装配本身能起来」。
    RELAY_UPSTREAM_KEY: '',
    // 固定口令哈希：不给「随机生成 + 打印」留路径。
    RELAY_ADMIN_PASSWORD_HASH: adminHash,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// 输出缓冲：成功时不打印（保持 CI 安静），失败时一次性回放以便排障。
let childLog = '';
let sawStartedLog = false;
let alive = true;
let childExit = null;

const onChunk = (buf) => {
  const text = buf.toString();
  if (text.includes('Nest application successfully started')) sawStartedLog = true;
  childLog += text;
};
child.stdout.on('data', onChunk);
child.stderr.on('data', onChunk);
child.on('exit', (code, signal) => {
  alive = false;
  childExit = { code, signal };
});

let ok = false;
let detail = '';
try {
  const health = await waitForHealth(healthUrl, () => alive);
  if (!health.ok) {
    detail = health.reason;
  } else {
    const logMark = sawStartedLog ? '命中' : '未命中，但 /healthz 已答，以健康检查为准';
    const healthLine = `GET /healthz → 200 ${JSON.stringify(health.body)}（启动日志标记=${logMark}）`;

    // ★ 关键：登录后 GET /api/models/catalog —— 直接覆盖出事故的 ApiModule 注入图。
    //   登录需要同源 Origin（CSRF 校验）。
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    if (login.status !== 200) {
      detail = `${healthLine}；但登录失败：HTTP ${login.status} ${JSON.stringify(login.json)}`;
    } else {
      const cookie = login.setCookie.split(';')[0];
      const catalog = await req('/api/models/catalog', { headers: { cookie } });
      const models = catalog.json?.data?.models;
      if (catalog.status !== 200 || !Array.isArray(models) || models.length === 0) {
        detail = `${healthLine}；登录 200 但 /api/models/catalog → HTTP ${catalog.status} ${JSON.stringify(catalog.json?.data ?? catalog.json)}`;
      } else {
        // ★ [2026-10-07] 追加设置面断言：曾有 dist 遗留的旧 settings.catalog.js 遮蔽同名目录，
        //   运行时加载旧 catalog、新设置项从 /api/settings 凭空消失 —— healthz/登录/模型目录
        //   全都照常，只有这一步能抓到。断言组数与关键键（新设置项上线时在此登记）。
        const settings = await req('/api/settings', { headers: { cookie } });
        const items = ((settings.json?.data?.groups ?? []).flatMap((g) => g.items ?? [])) ?? [];
        const keys = new Set(items.map((i) => i.key));
        const mustKeys = ['upstream.promptRewrite', 'quota.warnBelow', 'upstream.spoofUA', 'logs.recordRequestBody'];
        const missing = mustKeys.filter((k) => !keys.has(k));
        if (settings.status !== 200 || missing.length > 0) {
          detail = `${healthLine}；登录 200；模型目录 200；但 /api/settings → HTTP ${settings.status}，缺键 [${missing.join(',')}]（疑似 dist 遗留产物遮蔽 settings.catalog 目录）`;
        } else {
          ok = true;
          detail = `${healthLine}；登录 200；GET /api/models/catalog → 200（${models.length} 个模型，source=${catalog.json?.data?.source}）；GET /api/settings → ${items.length} 项（含新键）`;
        }
      }
    }
  }
} catch (err) {
  detail = err instanceof Error ? err.message : String(err);
} finally {
  if (alive) {
    child.kill('SIGTERM');
    // 给优雅关闭（enableShutdownHooks）一点时间，再强杀
    const waitExit = (async () => {
      for (let i = 0; i < 20 && alive; i += 1) await sleep(100);
    })();
    await Promise.race([waitExit, sleep(2500)]);
    if (alive) child.kill('SIGKILL');
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响判定 */
  }
}

if (ok) {
  console.log(`\n[smoke-boot] 通过：${detail}`);
  process.exit(0);
}

console.error(`\n[smoke-boot] 失败：${detail}`);
if (childExit) console.error(`[smoke-boot] 子进程退出码=${childExit.code} signal=${childExit.signal}`);
console.error(`--- 子进程输出 ---\n${childLog}`.trimEnd());
process.exit(1);
