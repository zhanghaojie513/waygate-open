/**
 * 比对 mock 里 **两份**提供商名字表是否一致：
 *   · `web/src/mocks/fixtures.ts` 的 `MOCK_PROVIDER_NAME`（目录行反查用）
 *   · `web/src/mocks/api.ts` 的 `providerStore[].name`（提供商管理页用）
 *
 * ## 为什么需要
 * 这两张表是**同源镜像**：fixtures 不能 import api（api 反过来 import fixtures，会循环初始化），
 * 所以只能各存一份。而「提供商的显示名」是界面上到处在用的东西 —— 名字不一致时：
 *   · 目录按 providerId → 名字反查，可能得到 providerStore 里不存在的名字
 *   · 「模型列表」抽屉按名字过滤，一个都匹配不上（点开 WorkBuddy，列表却混着别家）
 * 这类漂移不会有任何报错，只会让 dev:mock 走查看到真实环境不存在的画面。
 *
 * ## 背景（v1.7.2 的真实缺陷）
 * 目录行的 `provider` 字段此前是「id 前缀猜的」——非 `MiniMax-` 前缀一律标成 WorkBuddy，
 * 于是 DeepSeek / GLM / Hy 全被标成 WorkBuddy，按提供商过滤时一个都滤不掉。
 *
 * 用法：node tools/compare-mock-providers.mjs [--check]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** 从 fixtures.ts 抓 `MOCK_PROVIDER_NAME` 对象字面量。 */
function namesFromFixtures() {
  const src = readFileSync(join(root, 'web/src/mocks/fixtures.ts'), 'utf8');
  const start = src.indexOf('const MOCK_PROVIDER_NAME');
  if (start < 0) throw new Error('fixtures.ts 里找不到 MOCK_PROVIDER_NAME');
  const block = src.slice(start, src.indexOf('};', start));
  const out = new Map();
  for (const m of block.matchAll(/(\w+):\s*'([^']*)'/g)) out.set(m[1], m[2]);
  return out;
}

/** 从 api.ts 抓 `providerStore` 里的 `{ id: '...', name: '...' }`。 */
function namesFromStore() {
  const src = readFileSync(join(root, 'web/src/mocks/api.ts'), 'utf8');
  const start = src.indexOf('let providerStore');
  if (start < 0) throw new Error('api.ts 里找不到 providerStore');
  const block = src.slice(start, src.indexOf('\n];', start));
  const out = new Map();
  for (const m of block.matchAll(/id:\s*'([^']+)',\s*name:\s*'([^']+)'/g)) out.set(m[1], m[2]);
  return out;
}

const fixtures = namesFromFixtures();
const store = namesFromStore();

const problems = [];
for (const [id, name] of store) {
  const mirror = fixtures.get(id);
  if (mirror === undefined) problems.push(`providerStore 有 ${id}（${name}），MOCK_PROVIDER_NAME 缺这条`);
  else if (mirror !== name) problems.push(`${id} 名字不一致：providerStore="${name}" vs MOCK_PROVIDER_NAME="${mirror}"`);
}
for (const [id, name] of fixtures) {
  if (!store.has(id)) problems.push(`MOCK_PROVIDER_NAME 有 ${id}（${name}），providerStore 里没有该家`);
}

console.log(`providerStore ${store.size} 家 / MOCK_PROVIDER_NAME ${fixtures.size} 家`);
if (problems.length) {
  console.log(`\n⛔ 不一致 ${problems.length} 处：`);
  for (const p of problems) console.log(`  · ${p}`);
  if (CHECK) process.exit(1);
} else {
  console.log('✅ 两张表逐家一致（id → 显示名）。');
}
