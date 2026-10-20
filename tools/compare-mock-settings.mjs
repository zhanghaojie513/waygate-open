/**
 * 比对 `web/src/mocks/fixtures.ts` 的 settings 文案 vs 后端 `settings.catalog/group-*.ts`。
 *
 * 为什么需要：mock 里那行注释声称「readonly/why **逐字对齐**后端」—— 但那是**手抄**的，
 * 没有任何机制保证。实测已漂移 6 项（`credential.source` 还写着 `ck_`，早于 v1.6.13 退役）。
 * 漂移的后果是 `dev:mock` 与 README 截图里显示的说明**与真实行为不一致**，
 * 而这恰恰是「文档说一套、代码做一套」最隐蔽的一种（没人会去比对两段长文案）。
 *
 * 为什么直接读源码而不是构建产物：catalog 的 why 全是单行字面量（27/27），
 * 纯文本解析就够、且不要求先 build —— 门禁要能被随手跑，才有人跑。
 *
 * 用法：`node tools/compare-mock-settings.mjs`
 *   加 `--check` 时不一致即 exit 1（供 lint 调用）；否则只报告。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const unesc = (s) => s.replace(/\\(['\\])/g, '$1');

/** 抓一段源码里 `key: '<k>'` 之后的 label / why（两者都取该 key 之后最近的）。 */
function entryAfter(src, key) {
  const i = src.indexOf(`key: '${key}'`);
  if (i < 0) return null;
  const seg = src.slice(i, i + 4000);
  const head = src.slice(Math.max(0, i - 400), i); // label 常在 key 之前
  const unesc = (s) => s.replace(/\\(['\\])/g, '$1');
  const w = /why:\s*'((?:[^'\\]|\\.)*)'/.exec(seg);
  const l = /label:\s*'((?:[^'\\]|\\.)*)'/.exec(seg) ?? /label:\s*'((?:[^'\\]|\\.)*)'/.exec(head);
  return { why: w ? unesc(w[1]) : undefined, label: l ? unesc(l[1]) : undefined };
}

/* ---------- 后端：把 8 个 group-*.ts 拼成一份，按 key 索引 ---------- */
import { readdirSync } from 'node:fs';
const catalogDir = join(root, 'server', 'src', 'api', 'settings', 'catalog');
const legacyDir = join(root, 'server', 'src', 'api', 'settings.catalog');
const dir = (() => {
  try { readdirSync(catalogDir); return catalogDir; } catch { return legacyDir; }
})();
const backendSrc = readdirSync(dir)
  .filter((f) => f.startsWith('group-') && f.endsWith('.ts'))
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n');

const backendKeys = [...backendSrc.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
const backend = new Map(backendKeys.map((k) => [k, entryAfter(backendSrc, k)]));

const mockSrc = readFileSync(join(root, 'web/src/mocks/fixtures.ts'), 'utf8');

const missing = [];
const whyDiff = [];
const labelDiff = [];
for (const [key, b] of backend) {
  const m = entryAfter(mockSrc, key);
  if (!m) { missing.push(key); continue; }
  if (m.why !== b.why) whyDiff.push(key);
  if (m.label !== b.label) labelDiff.push(key);
}

console.log(`后端 catalog 项数：${backend.size}`);
console.log(`mock 缺项：${missing.length}${missing.length ? ' → ' + missing.join(', ') : ''}`);
console.log(`label 不一致：${labelDiff.length}${labelDiff.length ? ' → ' + labelDiff.join(', ') : ''}`);
console.log(`why 不一致：${whyDiff.length}${whyDiff.length ? ' → ' + whyDiff.join(', ') : ''}`);

if (whyDiff.length) {
  console.log('\n--- why 差异明细 ---');
  for (const k of whyDiff) {
    console.log(`· ${k}`);
    console.log(`  mock:    ${entryAfter(mockSrc, k).why}`);
    console.log(`  backend: ${backend.get(k).why}`);
  }
}

if (CHECK && (whyDiff.length || labelDiff.length || missing.length)) {
  console.error('\n⛔ mock 的 settings 文案与后端 catalog 不一致。mock 是 dev:mock 与截图的数据源，必须逐字对齐后端。');
  process.exit(1);
}
