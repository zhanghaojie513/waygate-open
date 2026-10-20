/**
 * 版本号三处同源闸（server/package.json / server/src/version.ts / web/package.json）。
 *
 * ## 为什么需要
 * server 侧本来就有闸（`server/scripts/copy-assets.mjs` 比对 package.json 与 version.ts），
 * 但**不覆盖 web** —— 于是 web/package.json 悄悄落后了三个版本（1.6.26 对 1.6.28）
 * 而没人发现。README 写着「前后端同版本联动发版」，闸不覆盖就等于这句话没人守。
 *
 * 为什么 web 也要同版本：两端的 dist 由**同一个部署脚本一起上线**（见 README 部署一节），
 * 版本号不一致时，线上 healthz 报的版本无法代表前端产物是哪一版 —— 排障时
 * 「用户看到的是哪版界面」会变成一个查不清的问题。
 *
 * 用法：随 web 的 prebuild 自动跑；也可手跑 `node tools/check-version-sync.mjs`。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const readJsonVersion = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')).version;

const serverPkg = readJsonVersion('server/package.json');
const webPkg = readJsonVersion('web/package.json');
const versionTsRaw = readFileSync(join(root, 'server/src/version.ts'), 'utf8');
const versionTs = /VERSION = '([^']+)'/.exec(versionTsRaw)?.[1];

const items = [
  ['server/package.json', serverPkg],
  ['server/src/version.ts', versionTs],
  ['web/package.json', webPkg],
];

const bad = items.filter(([, v]) => v !== serverPkg);
if (bad.length > 0) {
  console.error('[check-version-sync] ⛔ 版本号不一致：');
  for (const [file, v] of items) {
    console.error(`  ${file} = ${v ?? '(未找到)'}${v === serverPkg ? '' : '  ← 需与 server/package.json 一致'}`);
  }
  console.error('  前后端同版本联动发版，三处必须相等。');
  process.exit(1);
}

console.log(`[check-version-sync] 版本三处一致 ✓ v${serverPkg}`);
