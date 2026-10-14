/**
 * 把 src/ 下的非 TS 静态资源复制到 dist/，让构建产物自包含。
 *
 * 为什么需要：`tsc` 只编译 .ts，不会复制 schema.sql / model-catalog.json 这类
 * 资源。而 `resolveAsset()` 会优先在 dist/ 下查找，找不到就回退到 src/ ——
 * 开发机上有 src/ 所以永远不会暴露问题，一旦部署只传 dist/ 就会启动即崩
 * （实测：`Error: 资源文件缺失：store/schema.sql` + systemd 疯狂重启 59 次）。
 *
 * 设计取舍：**自动扫描 src/ 下所有非 .ts 文件**，而不是手工维护一份清单。
 * 手工清单的问题是"新增资源时容易忘"，而忘记的代价是部署时才炸；
 * 自动扫描的代价是可能复制多余文件（几 KB，可忽略）。
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/* ★ [v0.2.0] 版本号一致性闸：src/version.ts 的 VERSION 必须与 package.json 的
 * version 相等，否则 fail build。防止「package.json 升了、代码侧单源忘了升」
 * （或反过来）—— healthz 在 systemd 下没有 npm_package_version，靠的就是代码侧单源。 */
{
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const versionTs = readFileSync(join(srcDir, 'version.ts'), 'utf8');
  const m = /VERSION = '([^']+)'/.exec(versionTs);
  if (!m || m[1] !== pkgVersion) {
    console.error(
      `[copy-assets] ⛔ 版本号不一致：package.json=${pkgVersion}，src/version.ts=${m ? m[1] : '(未找到)'}。请两处同步修改。`,
    );
    process.exit(1);
  }
  console.log(`[copy-assets] 版本一致 ✓ v${pkgVersion}`);
}

/**
 * ★ 拆分/改名前遗留的旧编译产物（2026-10-07 全盘验证实测踩到）。
 *
 * `tsc` 只增不删：源码把 `settings.catalog.ts` 拆成 `settings.catalog/` 目录后，
 * 旧的 `dist/api/settings.catalog.js` 会一直残留 —— 而 Node 的模块解析**文件优先于
 * 同名目录**，于是运行时永远加载旧 catalog（当天新增的两个设置项在 /api/settings
 * 里凭空消失，单测全绿也发现不了，因为 vitest 跑的是 src 不是 dist）。
 * 每次构建后按清单删除这类孤儿；将来再有拆分/改名，务必把旧路径加进来。
 */
const LEGACY_ARTIFACTS = [
  'api/settings.catalog.js', // 已拆分为 api/settings.catalog/ 目录（task#37）
  'config/defaults.js',      // 已改名为 config/settings.defaults.js
  'config/validate.js',      // 已改名为 config/settings.validate.js
];

let removed = 0;
for (const rel of LEGACY_ARTIFACTS) {
  const target = join(distDir, rel);
  try {
    rmSync(target);
    removed += 1;
    console.warn(`[copy-assets] 已删除遗留产物 ${rel}（防止遮蔽同名目录/新名）`);
  } catch {
    // 不存在即无需处理
  }
}
if (removed === 0) console.log('[copy-assets] 无遗留产物需要清理');

/** 递归收集 src/ 下所有非 .ts 文件（.d.ts 也排除）。 */
function collectAssets(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectAssets(full));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext === '.ts') continue; // 编译产物由 tsc 负责
    out.push(full);
  }
  return out;
}

const assets = collectAssets(srcDir);
if (assets.length === 0) {
  console.warn('[copy-assets] 未在 src/ 下发现任何资源文件。');
  process.exit(0);
}

let copied = 0;
for (const asset of assets) {
  const rel = relative(srcDir, asset);
  const dest = join(distDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(asset, dest);
  const size = statSync(asset).size;
  console.log(`[copy-assets] ${rel}  (${size} B)`);
  copied += 1;
}

console.log(`[copy-assets] 已复制 ${copied} 个资源文件到 dist/`);
