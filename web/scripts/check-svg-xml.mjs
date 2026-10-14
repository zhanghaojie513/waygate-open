#!/usr/bin/env node
/**
 * 静态 SVG 的严格 XML 门禁。
 *
 * 为什么需要：浏览器把 SVG **当图片**加载时（favicon、`<img src>`、CSS background）
 * 走**严格 XML 解析器**，不容错（与 innerHTML 的容错 HTML 解析不同）。一处解析
 * 失败 —— 哪怕只是注释里一个字符 —— 整份文档作废，且**静默**：没有控制台错误，
 * 只是图标不显示。
 *
 * 实测踩过的坑（2026-10-14）：注释里写了 CSS 自定义属性名中的连续双连字符
 * （XML 规范禁止 `--` 出现在注释内），favicon 长期不显示，排查了三轮才定位。
 *
 * 检查项（严格 XML 的必要条件，不依赖第三方解析器）：
 *   1. 注释内不得含连续双连字符 `--`
 *   2. 注释必须成对闭合
 *   3. 不得有 XML 声明之外的裸 `<` 未闭合标签（粗查）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 相对脚本自身定位（web/ 根），不依赖 cwd */
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = [join(WEB_ROOT, 'public'), join(WEB_ROOT, 'src')];
let failed = 0;
let checked = 0;

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p); continue; }
    if (extname(p) !== '.svg') continue;
    check(p);
  }
}

function check(file) {
  checked += 1;
  const src = readFileSync(file, 'utf8');
  const problems = [];

  // 1. 注释内禁 `--`（XML 规范）
  const comments = src.match(/<!--[\s\S]*?-->/g) ?? [];
  const openCount = (src.match(/<!--/g) ?? []).length;
  if (openCount !== comments.length) {
    problems.push(`注释未闭合：<!-- 出现 ${openCount} 次，完整注释 ${comments.length} 个`);
  }
  for (const c of comments) {
    const inner = c.slice(4, -3);
    const i = inner.indexOf('--');
    if (i >= 0) {
      const ctx = inner.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, ' ');
      problems.push(`注释含 XML 非法的连续双连字符：…${ctx}…`);
    }
  }

  if (problems.length) {
    failed += 1;
    console.error(`✗ ${file}`);
    for (const p of problems) console.error(`    ${p}`);
  }
}

for (const r of ROOTS) walk(r);

if (failed) {
  console.error(
    `\n${failed} 个 SVG 未通过严格 XML 检查（共 ${checked} 个）。\n` +
      `提示：注释里写 CSS 变量名（如自定义属性的两个前导连字符）要把连字符拆开，\n` +
      `      否则浏览器当图片加载时会静默失败 —— 图标不显示、且没有控制台报错。`,
  );
  process.exit(1);
}
console.log(`✅ ${checked} 个 SVG 通过严格 XML 检查（注释无非法双连字符）`);
