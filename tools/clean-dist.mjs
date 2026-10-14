#!/usr/bin/env node
/**
 * 构建前清掉 `web/dist/` 里的**上一次构建产物**（index.html + assets/），
 * 但**保留** `dist/fonts/`（109 个自托管 woff2，内容寻址、不随构建变化）。
 *
 * 为什么不在 vite 里开 `emptyOutDir: true`：
 *   那会让 vite 删除整个 outDir，一次性删 430+ 个字体文件会触发环境的
 *   「批量删除保护」门禁（SAFE_DELETE_BULK_CONFIRM_REQUIRED），构建直接失败。
 *   这里的策略是「只删会变的、不动不会变的」：每次构建只需删掉几个带 hash
 *   的资产文件，删除量远低于阈值，同时也不会残留上一版哈希文件
 *   （残留会误导「产物里怎么还有旧东西」的排查）。
 *
 * 用法（由 web/package.json 的 prebuild 自动调用）：
 *   node ../tools/clean-dist.mjs        # 相对于 web/
 */
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const DIST = resolve(REPO, 'web/dist');

if (!existsSync(DIST)) {
  console.log('[clean-dist] dist/ 不存在，跳过');
  process.exit(0);
}

let removed = 0;
for (const name of readdirSync(DIST)) {
  if (name === 'fonts') continue;             // 自托管字体：保留
  rmSync(join(DIST, name), { recursive: true, force: true });
  removed += 1;
}

// 字体孤儿清理：public/fonts 里已删除的文件（如可变字体去重后），不应残留在 dist/fonts 被一起发版
const DIST_FONTS = join(DIST, 'fonts');
const SRC_FONTS = resolve(REPO, 'web/public/fonts');
let orphans = 0;
if (existsSync(DIST_FONTS) && existsSync(SRC_FONTS)) {
  const live = new Set(readdirSync(SRC_FONTS));
  for (const name of readdirSync(DIST_FONTS)) {
    if (live.has(name)) continue;
    rmSync(join(DIST_FONTS, name), { force: true });
    orphans += 1;
  }
}
console.log(`[clean-dist] 清理了 dist/ 下 ${removed} 项（保留 fonts/，移除孤儿字体 ${orphans} 个）`);
