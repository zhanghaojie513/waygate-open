/**
 * 比对 `web/src/mocks/fixtures.ts` 的趋势桶序列 vs 服务端 `server/src/api/window.ts`。
 *
 * ## 为什么需要
 *
 * `dev:mock` 是**控制台开发与截图的唯一数据源**（见 `frontend-has-no-tests`）：
 * 改前端后唯一的验收手段是 `tools/shot-console.mjs` 重截六页，用的是 mock 数据。
 * 所以 mock 与真实行为一旦漂移，**漂移会直接变成截图里的假象** ——
 * 「文档说一套、代码做一套」里最隐蔽的一种（没人会去比对两边的桶数）。
 *
 * v1.6.31 已经吃过一次：服务端把桶序列改成「起点向下对齐到桶边界」，
 * 24h 从 24 格变 25 格；mock 若没同步，`dev:mock` 下画出来的是 24 格，
 * 截图看着「柱数不对」却查不出是哪边错。
 *
 * ## 比什么
 *
 * 同一时刻（固定 `2026-10-19 15:30` 本地时间，覆盖**非整点**这个关键情形），
 * 逐格比对五件事：
 *   1. 桶**标签序列**（首桶 / 末桶 / 长度 / 是否连续）；
 *   2. 每格的 **`partial` 标记**（首/末桶是否标「不足一格」）；
 *   3. 桶粒度（hour / day）；
 *   4. mock 的 `Σrequests` 与桶数对应关系（mock 自带硬规则，这里只查桶序列）。
 *
 * ## 为什么直接 import 服务端源码
 *
 * 服务端的 `fillEmptyBuckets` / `markPartialBuckets` 是**纯函数**（不碰 DB、不碰 Nest），
 * 用 esbuild 转译后即可在 Node 里跑 —— 这样比对的是**真实实现**，不是抄一遍的公式。
 * 抄一遍的公式必然随时间腐化（这正是本门禁要防的事，换个方向也会腐化）。
 *
 * ## 用法
 *
 *   node tools/compare-mock-trend.mjs            # 报告
 *   node tools/compare-mock-trend.mjs --check    # 不一致即 exit 1（供 lint 调用）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/* esbuild 在 `server/node_modules`（server 的 devDependency），不在根目录 ——
   用 createRequire 从 server 的位置解析，避免依赖调用者的 cwd。 */
const require = createRequire(join(root, 'server/package.json'));
const { build } = require('esbuild');

/** 比对用的固定时刻：2026-10-19 15:30（本地）。**故意取非整点** ——
 *  整点时刻首末桶都满，测不出「向下对齐」这件事。 */
const NOW = new Date(2026, 9, 19, 15, 30, 0).getTime();

/* ---------------------------------------------------------------- 服务端侧 */

/** 把服务端的纯函数模块转译成可执行的 ESM，临时写到系统临时目录。 */
async function loadServerWindow() {
  const entry = join(root, 'server/src/api/window.ts');
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(url);
}

/* ------------------------------------------------------------------ mock 侧 */

/** 从 mock 源码里抠出 `buildWindowTrend` 与它依赖的纯函数，交给 esbuild 一起编。 */
const MOCK_SRC = join(root, 'web/src/mocks/fixtures.ts');

async function loadMockTrend() {
  const out = await build({
    entryPoints: [MOCK_SRC],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    define: { 'import.meta.env.VITE_ENABLE_MOCKS': '"1"' },
  });
  const code = out.outputFiles[0].text;
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(url);
}

/* ------------------------------------------------------------------- 比对 */

const server = await loadServerWindow();
const mock = await loadMockTrend();

const WINDOWS = ['today', '1h', '24h', '7d', '30d'];

const problems = [];
const rows = [];

for (const key of WINDOWS) {
  const spec = server.resolveWindow(key);
  const { from, to } = server.windowRange(spec, NOW);

  /* 服务端：真实实现。 */
  const sRows = server.markPartialBuckets(
    server.fillEmptyBuckets([], spec, from, to, (bucket) => ({ bucket })),
    spec,
    from,
    to,
  );
  const sLabels = sRows.map((r) => r.bucket);
  const sPartial = sRows.map((r) => r.partial);

  /* mock：真实实现。 */
  const mTrend = mock.buildWindowTrend(key, NOW);
  const mLabels = mTrend.map((p) => p.bucket);
  const mPartial = mTrend.map((p) => p.partial === true);

  const issues = [];
  if (mLabels.length !== sLabels.length) {
    issues.push(`桶数不一致：服务端 ${sLabels.length}、mock ${mLabels.length}`);
  }
  if (mLabels[0] !== sLabels[0]) {
    issues.push(`首桶不一致：服务端 ${sLabels[0]}、mock ${mLabels[0]}`);
  }
  if (mLabels[mLabels.length - 1] !== sLabels[sLabels.length - 1]) {
    issues.push(
      `末桶不一致：服务端 ${sLabels[sLabels.length - 1]}、mock ${mLabels[mLabels.length - 1]}`,
    );
  }
  const n = Math.min(sLabels.length, mLabels.length);
  for (let i = 0; i < n; i += 1) {
    if (sLabels[i] !== mLabels[i]) {
      issues.push(`第 ${i} 格标签不一致：服务端 ${sLabels[i]}、mock ${mLabels[i]}`);
      break;
    }
    if (sPartial[i] !== mPartial[i]) {
      issues.push(
        `第 ${i} 格（${sLabels[i]}）partial 不一致：服务端 ${sPartial[i]}、mock ${mPartial[i]}`,
      );
    }
  }
  /* mock 的 partial 不能是 undefined —— 那样前端 `tip.partial` 恒为假，
     「不足一格」标签在 dev:mock / 截图里永远不会出现。 */
  if (mTrend.some((p) => p.partial === undefined)) {
    issues.push('mock 有桶缺 partial 字段（前端 tooltip 的「不足一格」标签将不出现）');
  }

  const partialCount = mPartial.filter(Boolean).length;
  rows.push({ key, buckets: mLabels.length, partial: partialCount, issues });

  if (issues.length) {
    problems.push({ key, issues });
  }
}

/* ------------------------------------------------------------------- 报告 */

for (const r of rows) {
  const mark = r.issues.length ? '⛔' : '✅';
  console.log(
    `${mark} ${r.key.padEnd(5)} 桶数=${String(r.buckets).padStart(2)}  partial 桶=${r.partial}`,
  );
  for (const i of r.issues) console.log(`     · ${i}`);
}

if (problems.length) {
  console.error(
    '\n⛔ mock 的趋势桶序列与服务端不一致。mock 是 dev:mock 与控制台截图的数据源，' +
      '桶数/partial 一旦漂移，截图就会展示真实环境不会出现的图。',
  );
  if (CHECK) process.exit(1);
} else {
  console.log('\n✅ mock 与服务端的趋势桶序列逐格一致（标签 + partial 标记）。');
}
