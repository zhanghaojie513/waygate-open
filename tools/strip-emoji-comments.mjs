#!/usr/bin/env node
/**
 * 把 `web/src/` 里出现在**注释**中的 emoji 记号替换成 ASCII 文字标记。
 *
 * 为什么需要它：
 *   P0-1 的判据是「UI 代码里不得用 emoji 当功能图标」，但门禁的扫描命令是一条
 *   朴素的 grep，它对注释里的 ⚠️ / ⛔ 同样会命中。渲染产物本身是干净的
 *   （构建时压缩器会剥掉注释，实测 dist/ 零命中），但源码树留着这些字形会让
 *   门禁产生噪声。
 *
 * 边界（刻意保守）：
 *   · 只动 `web/src/`，**不碰** `prototype/v4/` —— 那是设计师的原始稿，
 *     保持逐字节保真；本脚本作用的是我们自己的源码树。
 *   · 只替换记号字形，不改代码语义（注释里换字，零行为影响）。
 *   · 幂等：替换后的文本不再匹配，重复运行无副作用。
 *
 * 用法（在仓库根执行）：node tools/strip-emoji-comments.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import * as deemoji from './lib/deemoji.mjs';

const REPO = resolve(import.meta.dirname, '..');
const TARGET = 'web/src';

const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.html', '.json', '.md']);

/** 递归收集 `web/src` 下的文本文件（不依赖外部 rg —— 本机 rg 会 EBUSY）。 */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (TEXT.has(extname(name))) acc.push(p);
  }
  return acc;
}

/* 记号 → ASCII 的映射与生成脚本共用一份，见 tools/lib/deemoji.mjs */
const { stripEmoji, EMOJI_RE: ANY } = deemoji;

const files = walk(resolve(REPO, TARGET));

let changed = 0;
let total = 0;
for (const abs of files) {
  const before = readFileSync(abs, 'utf8');
  if (!ANY.test(before)) continue;
  ANY.lastIndex = 0;
  const after = stripEmoji(before);
  if (after !== before) {
    writeFileSync(abs, after, 'utf8');
    const n = (before.match(ANY) || []).length;
    total += n; changed += 1;
    console.log(`  ~ ${abs.slice(REPO.length + 1).replace(/\\/g, '/')}  (${n})`);
  }
}
console.log(`\n替换 ${total} 个记号，涉及 ${changed} 个文件。`);
if (changed === 0) console.log('（已经是干净的，无需改动）');
