#!/usr/bin/env node
/**
 * AC-11 · 把控制台样式表里的**非中性色字面量**迁移成令牌引用。
 *
 * 背景：`design/tools/normalize-colors.py` 已经为 `prototype/v4` 做过同一件事，
 * 但它不覆盖 `web/src/styles/` 下我们自己维护的控制台样式表。那两张表里
 * 还留着 `rgba(124,92,255,.07)` 这类「语义色 + 透明度」的直写 —— 正是铁律 A
 * 第二类禁止的写法（换一次品牌色，它必须跟着动；不跟着动且不会报错）。
 *
 * 做两件事，都要求**数学等价**：
 *   ① rgba(R,G,B,A) → color-mix(in srgb, var(--token) P%, transparent)
 *        srgb 是预乘空间，与 transparent 混合只影响 alpha ⇒ 通道不变、alpha = P%。
 *   ② 十六进制字面量 → 对应令牌（如 #7C5CFF → var(--brand-450)）。
 *
 * 中性叠加 rgba(255,255,255,α) / rgba(0,0,0,α) 属铁律 A 第三类，**原样保留**。
 *
 * 用法：
 *   node tools/normalize-web-colors.mjs          # 改写
 *   node tools/normalize-web-colors.mjs --check  # 只报告
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const TARGETS = ['web/src/styles/app.css', 'web/src/styles/vendor/console-fx.css'];
const CHECK = process.argv.includes('--check');

/* RGB → 令牌名。每个非中性色都必须在色板里有名字（找不到就报错，不静默放过）。 */
const TOKEN = new Map([
  ['124,92,255', '--brand-450'],
  ['110,92,255', '--brand-500'],
  ['167,155,255', '--brand-400'],
  ['62,220,255', '--accent-cyan'],
  ['53,224,138', '--signal-live'],
  ['255,170,59', '--warn-amber'],
  ['255,107,107', '--danger-red'],
  ['4,3,9', '--bg-scrim'],
  ['17,14,34', '--bg-surface-deep'],
]);

/* 十六进制 → 令牌（大小写不敏感）。#FFB4B4 是 --danger-red-lt（见 tokens 回填）。 */
const HEX = new Map([
  ['7c5cff', '--brand-450'],
  ['35dce8', '--brand-stop-2'],
  ['ff6b6b', '--danger-red'],
  ['ffb4b4', '--danger-red-lt'],
]);

const isNeutral = (r, g, b) => (r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0);

/** 0.07 → '7'，0.3 → '30'，1 → '100'，0 → '0' */
function pct(a) {
  const n = Math.round(a * 10000) / 100;
  return String(Number.isInteger(n) ? n : n);
}

/* ---------- 剥注释，只改「真代码」；改完把注释原样放回 ---------- */
function splitComments(css) {
  const parts = [];
  let last = 0;
  for (const m of css.matchAll(/\/\*[\s\S]*?\*\//g)) {
    parts.push({ code: css.slice(last, m.index), comment: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ code: css.slice(last), comment: '' });
  return parts;
}

function convertCode(code, problems, rel) {
  let out = code.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)/g,
    (whole, rs, gs, bs, as) => {
      const r = +rs; const g = +gs; const b = +bs;
      if (isNeutral(r, g, b)) return whole;                       // 铁律 A 第三类：保留
      const token = TOKEN.get(`${r},${g},${b}`);
      if (!token) { problems.push(`${rel}: 色板里没有 rgba(${r},${g},${b}) 的名字 → ${whole}`); return whole; }
      if (as === undefined) return `var(${token})`;                // 不透明 → 直接引用令牌
      const a = parseFloat(as);
      if (a >= 1) return `var(${token})`;
      return `color-mix(in srgb, var(${token}) ${pct(a)}%, transparent)`;
    });

  /* 十六进制字面量 → 令牌；#fff/#000 及其变体放行。 */
  out = out.replace(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (whole, hex) => {
    const k = hex.toLowerCase();
    if (/^(fff|ffffff|000|000000)$/.test(k)) return whole;
    const token = HEX.get(k);
    if (!token) { problems.push(`${rel}: 色板里没有 #${hex} 的名字`); return whole; }
    return `var(${token})`;
  });

  /* `var(--danger-red, #FF6B6B)` —— 这里的兜底字面量是冗余的：令牌已存在，
     留着等于给同一颜色留了第二个出处。去掉兜底。 */
  out = out.replace(/var\((--[a-z0-9-]+),\s*#[0-9a-fA-F]{3,8}\s*\)/g, 'var($1)');
  return out;
}

const problems = [];
let changed = 0;
let conversions = 0;

for (const rel of TARGETS) {
  const abs = resolve(REPO, rel);
  const before = readFileSync(abs, 'utf8');
  const parts = splitComments(before);
  let after = '';
  for (const p of parts) {
    const conv = convertCode(p.code, problems, rel);
    if (conv !== p.code) {
      /* 粗算改动条数：看 color-mix / var() 的净增量 */
      conversions += (conv.match(/color-mix\(/g) || []).length - (p.code.match(/color-mix\(/g) || []).length;
    }
    after += conv + p.comment;
  }
  if (after !== before) {
    if (!CHECK) writeFileSync(abs, after, 'utf8');
    changed += 1;
    console.log(`  ${CHECK ? '[待改]' : '~'} ${rel}`);
  }
}

console.log('');
if (problems.length) {
  console.log(`[FAIL] ${problems.length} 处找不到令牌名（未静默放过）：`);
  for (const p of problems) console.log('   ' + p);
  process.exitCode = 1;
} else if (changed === 0) {
  console.log('[OK] 无需改动：目标文件已是令牌化写法。');
} else {
  console.log(`[OK] ${CHECK ? '需要' : '已'}迁移 ${changed} 个文件（新增 ${conversions} 处 color-mix）。`);
}
