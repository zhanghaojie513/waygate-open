#!/usr/bin/env node
/**
 * `waygate-open` 的命令行入口（v1.6.14）。
 *
 * ## 它做什么
 *   `npx waygate-open` / `waygate-open` —— 起本地服务 → 等它就绪 → **自动打开浏览器**
 *   到控制台。这是「本地启动」形态：自带控制台（同源托管），不需要另起前端。
 *
 * ## 为什么是这个形状（参考 Astra-Gate 的分发方式）
 * Astra-Gate 也是「一条命令起服务 + 开浏览器」，但它要发**6 个平台的预编译二进制**
 * （C# 应用）。本包是纯 Node：`better-sqlite3` 自带 N-API prebuild（`gypfile:false`
 * 且无 install 脚本，安装不编译），所以**一个包全平台通用**。
 *
 * ## 参数（多可用环境变量等价替代）
 *   --port <n>        监听端口（默认 8787；等价 RELAY_PORT）
 *   --host <addr>     监听地址（默认 127.0.0.1；对外监听需 RELAY_ALLOW_PUBLIC_BIND=1）
 *   --data-dir <path> 数据目录（默认 ~/.waygate/open；等价 RELAY_DATA_DIR）
 *   --no-open         不自动开浏览器（服务器 / CI 场景）
 *   --help / -h
 *
 * ## 数据落在哪
 * 默认 **`~/.waygate/open/`**（与家族的 wb / qoc / mmcode 一致的"用户主目录下"约定），
 * 而**不是** cwd —— 全局安装后 cwd 是用户随便某个目录。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本包根目录：bin/ 的上一级。 */
const PKG_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--open') out.open = true;
    else if (a === '--port') out.port = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length);
    else if (a === '--password') out.password = argv[++i];
    else if (a.startsWith('--password=')) out.password = a.slice('--password='.length);
    else {
      console.error(`未知参数：${a}\n用 --help 看用法。`);
      process.exit(2);
    }
  }
  return out;
}

const HELP = `
途关 Waygate · 本地启动（自带控制台）

用法：
  waygate-open [选项]

选项：
  --port <n>         监听端口（默认 8787，环境变量 RELAY_PORT 同义）
  --host <addr>      监听地址（默认 127.0.0.1；对外监听需 RELAY_ALLOW_PUBLIC_BIND=1）
  --data-dir <path>  数据目录（默认 ~/.waygate/open，环境变量 RELAY_DATA_DIR 同义）
  --password <pw>    首次启动的管理口令（默认 waygate；环境变量 RELAY_ADMIN_PASSWORD 同义）
                     只对「首次启动」生效，不改已改过的口令；对外监听时不套用默认值
  --no-open          不自动打开浏览器（服务器 / CI）
  -h, --help         显示本帮助

启动后：
  · 控制台   http://127.0.0.1:<port>/console   （浏览器会自动打开）
  · 接入地址 http://127.0.0.1:<port>/v1        （填进任意 OpenAI / Anthropic 兼容客户端）
  · 健康检查 http://127.0.0.1:<port>/healthz

默认管理口令是 waygate —— 仅本机可访问时使用，登录后建议改掉。
按 Ctrl+C 停止。
`.trim();

// ---------------------------------------------------------------- 开浏览器

/**
 * 用系统默认浏览器打开 URL。
 *
 * 三种平台各一条命令（与 Astra-Gate 的 cli/src/lib/browser.ts 同一套写法）：
 *   darwin  → open
 *   win32   → rundll32 url.dll,FileProtocolHandler（比 `start` 可靠：`start` 是 cmd 内建，
 *             不经 shell 无法调用）
 *   其他    → xdg-open
 * 全部 `detached + unref + stdio:ignore`：不阻塞、不继承 stdout，且**失败也不影响服务**
 * （URL 已打印，用户手点即可）。
 */
function openInBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就算了 —— URL 已打印 */
  }
}

// ---------------------------------------------------------------- 等就绪

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /healthz 直到 200 或超时。 */
async function waitReady(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  /* 数据目录：显式参数 > 环境变量 > ~/.waygate/open。放主目录而非 cwd。 */
  const dataDir = args.dataDir ?? process.env.RELAY_DATA_DIR ?? join(homedir(), '.waygate', 'open');
  mkdirSync(dataDir, { recursive: true });

  const entry = join(PKG_ROOT, 'server', 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.error(
      `未找到服务端产物：${entry}\n` +
        `源码仓请先在 server/ 下跑 \`npm run build\`；npm 安装的正式包不应出现此项。`,
    );
    process.exit(1);
  }

  const port = args.port ?? process.env.RELAY_PORT ?? '8787';
  const host = args.host ?? '127.0.0.1';
  /* 对外监听（非回环）在服务端要显式放行 —— 把用户的 --host 意图翻译成那个环境变量，
     否则服务端会静默降级回 127.0.0.1，用户以为监听成功了。 */
  const allowPublicBind = ['127.0.0.1', '::1', 'localhost'].includes(host) ? undefined : '1';

  /* 默认管理口令（v1.6.14）：**只在回环绑定**（= 只有本机能访问）时注入。
     理由：本地启动的诉求是"装上就能用"，不该卡在"去日志里抄那串随机字符"。
     而对外监听时，一个众所周知的口令等于把控制台公开 —— 那种情形仍走随机生成，
     用户从启动日志里取（CLI 会把日志透传出来）。
     用户显式给了 --password / RELAY_ADMIN_PASSWORD 时以他给的为准。 */
  const isLoopback = !allowPublicBind;
  const defaultPassword = isLoopback ? 'waygate' : undefined;

  console.log('途关 Waygate · 本地启动');
  console.log(`  数据目录  ${dataDir}`);
  console.log(`  监听      http://${host}:${port}`);
  if (args.password ?? process.env.RELAY_ADMIN_PASSWORD ?? defaultPassword) {
    const pw = args.password ?? process.env.RELAY_ADMIN_PASSWORD ?? defaultPassword;
    console.log(`  管理口令  ${pw}${isLoopback && pw === defaultPassword ? '（默认，建议登录后改掉）' : ''}`);
  }

  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit', // 服务端日志（含首次启动的管理口令）直接透给用户
    env: {
      ...process.env,
      RELAY_DATA_DIR: dataDir,
      RELAY_PORT: port,
      ...(allowPublicBind ? { RELAY_ALLOW_PUBLIC_BIND: allowPublicBind } : {}),
      ...((args.password ?? process.env.RELAY_ADMIN_PASSWORD ?? defaultPassword)
        ? { RELAY_ADMIN_PASSWORD: args.password ?? process.env.RELAY_ADMIN_PASSWORD ?? defaultPassword }
        : {}),
    },
    cwd: join(PKG_ROOT, 'server'),
  });

  /* Ctrl+C：把信号转给子进程，让它走优雅关闭（WAL 检查点、在途请求收尾）。 */
  const forward = (sig) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('exit', (code) => process.exit(code ?? 0));

  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const ready = await waitReady(base);
  if (!ready) {
    console.error(`\n服务在 30 秒内没就绪，请查看上面的日志（端口 ${port} 可能被占用）。`);
    return;
  }

  const consoleUrl = `${base}/console`;
  console.log(`\n就绪 ✓  控制台 ${consoleUrl}`);
  console.log(`      接入地址 ${base}/v1\n`);
  if (args.open) openInBrowser(consoleUrl);
}

main().catch((e) => {
  console.error(`启动失败：${e && e.message ? e.message : String(e)}`);
  process.exit(1);
});
