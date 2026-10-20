/**
 * 把 mock 里 settings 的 `why` 同步为后端 catalog 的原文（一次性修复工具）。
 *
 * 只替换「`key: '<k>'` 之后最近的 `why: '<...>'`」里那段字面量，不动其它任何东西。
 * 之所以用脚本而不是手改：6 段长文案手抄必错，而错一个标点就是新的漂移。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = join(root, 'server', 'src', 'api', 'settings.catalog');
const backendSrc = readdirSync(catalogDir)
  .filter((f) => f.startsWith('group-') && f.endsWith('.ts'))
  .map((f) => readFileSync(join(catalogDir, f), 'utf8'))
  .join('\n');

const unesc = (s) => s.replace(/\\(['\\])/g, '$1');
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function whyAfter(src, key) {
  const i = src.indexOf(`key: '${key}'`);
  if (i < 0) return null;
  const m = /why:\s*'((?:[^'\\]|\\.)*)'/.exec(src.slice(i, i + 4000));
  return m ? unesc(m[1]) : null;
}

const keys = [...backendSrc.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);

const mockPath = join(root, 'web/src/mocks/fixtures.ts');
let mock = readFileSync(mockPath, 'utf8');
let changed = 0;

for (const key of keys) {
  const backendWhy = whyAfter(backendSrc, key);
  if (backendWhy === null) continue;
  const mockWhy = whyAfter(mock, key);
  if (mockWhy === backendWhy) continue;

  // 定位 mock 里该 key 之后那段 why 字面量，整体替换
  const i = mock.indexOf(`key: '${key}'`);
  const seg = mock.slice(i, i + 4000);
  const m = /why:\s*'((?:[^'\\]|\\.)*)'/.exec(seg);
  if (!m) continue;
  const replaced = `why: '${esc(backendWhy)}'`;
  const abs = i + m.index;
  mock = mock.slice(0, abs) + replaced + mock.slice(abs + m[0].length);
  changed += 1;
  console.log(`  ✓ ${key}`);
}

writeFileSync(mockPath, mock);
console.log(`\n同步完成：${changed} 项。`);
