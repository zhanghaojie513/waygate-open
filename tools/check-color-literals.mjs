#!/usr/bin/env node
/**
 * AC-11 · 色值纪律自查（作用于 `web/src`）。
 *
 * 为什么需要第二个检查器：规格点名的 `design/tools/normalize-colors.py --check`
 * 只扫 `prototype/v4`（设计稿源头），它管不到我们**集成落地时手写的**那一层。
 * 本脚本补上这一段，判据与铁律 A 对齐：
 *
 *   1) 组件样式（CSS 与内联）不得出现色值字面量，例外只有四个：`#fff` `#ffffff`
 *      `#000` `#000000`（含它们的透明变体写法）。
 *   2) 语义色的透明度变体必须写 `color-mix(in srgb, var(--token) N%, transparent)`。
 *   3) 中性叠加 `rgba(255,255,255,α)` / `rgba(0,0,0,α)` 属铁律 A 第三类，允许直写。
 *
 * 分类规则（不搞「一刀切」，避免把设计稿的授权值误判成违规）：
 *   · HAND    —— 我们手写的源码，**必须干净**，有问题即 exit 1。
 *   · DERIVED —— 由 `tools/scope-css.mjs` 等从 prototype/v4 **逐字节派生**的文件。
 *                里面的场景材质/悬停色是设计稿的授权值（design-spec §17），
 *                只统计、不判定。派生文件的可信来源是原型，不是这里。
 *
 * 扫描前会剥掉注释 —— 否则「说明为什么不用 #xxxxxx」这类注释会被当成违规。
 *
 * 用法：node tools/check-color-literals.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SRC = resolve(REPO, 'web/src');

/** 派生文件（来自 prototype/v4，逐字节保真）→ 只统计。 */
const DERIVED = [
  'landing/landing.css', 'landing/ui.css', 'landing/scene.css',
  'landing/scene.ts', 'landing/page.ts',
  'styles/vendor/tokens.css', 'styles/vendor/motion.css', 'styles/vendor/fonts.css',
  /* [v8] reactbits.dev 的 copy-paste 源码（CountUp/BlurText，MIT）。
     原样入库保真（升级=从上游重新复制），里面的色值/默认值是上游的，
     不是本仓手写组件 —— 与"派生文件"同一判据：可信来源不在本仓。 */
  'landing/bits/CountUp.jsx', 'landing/bits/BlurText.jsx',
];

/**
 * 色板源文件（palette source）→ 只统计。
 *
 * 与"手写组件样式"是**两类东西**，判据也不同：
 *   · 组件样式里出现色值字面量 = 缺陷（它绕过了令牌，换主题时不会跟着动）；
 *   · 色板文件里出现色值字面量 = **本分**（它**就是**令牌的赋值处 ——
 *     字面量若不写在这里，就没有任何地方该写）。
 * 所以这里不是"网开一面"，而是承认这两个文件的角色：
 *   · styles/vendor/tokens.css 的 :root —— 深色色板（已在 DERIVED 里，
 *     因为它同时是原型派生物）
 *   · styles/theme.css 的 `:root[data-theme='light']` —— **浅色色板**
 * 判据仍然有效且更强：theme.css **只允许**在 `:root[data-theme=…]` 块里
 * 出现字面量；一旦它出现在某个组件选择器里，下面的 `paletteLeaks`
 * 检查会把它抓出来（那条才是真正的违规）。
 */
const PALETTE = ['styles/theme.css'];

/** 色板文件里，字面量必须落在这些选择器的块内（否则是真违规，见上）。 */
function paletteLeaks(body) {
  const out = [];
  let depth = 0;
  let inPalette = false;
  for (const line of body.split('\n')) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (depth === 0) inPalette = /^:root\[data-theme=/.test(line.trim());
    const hasColor = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line) && !/^\s*\*/.test(line);
    if (hasColor && !inPalette) out.push(line.trim());
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  return out;
}

const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (TEXT.has(extname(name))) acc.push(p);
  }
  return acc;
}

/** 剥注释：CSS `/* */`、JS `//` 与 `/* */`。字符串内的 `//`（如 URL）要保住。 */
function stripComments(src, isCss) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (isCss) return s;
  /* 逐字符走一遍，跳过字符串字面量，避免误伤 'http://…' */
  let out = '';
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FN = /\b(rgba?|hsla?|oklch|lab|lch|color)\s*\(/g;
const NEUTRAL = /^rgba?\(\s*(255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)\s*[,)]/;
const ALLOWED_HEX = /^#(fff|ffffff|000|000000)([0-9a-fA-F]{0,2})?$/i;

let handViolations = 0;
let derivedHits = 0;
let paletteHits = 0;

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).replace(/\\/g, '/');
  const isDerived = DERIVED.includes(rel);
  const isPalette = PALETTE.includes(rel);
  const isCss = extname(abs) === '.css';
  const body = stripComments(readFileSync(abs, 'utf8'), isCss);
  const bad = [];

  for (const m of body.matchAll(HEX)) {
    if (!ALLOWED_HEX.test(m[0])) bad.push(`hex ${m[0]}`);
  }
  for (const m of body.matchAll(FN)) {
    const at = m.index;
    const snippet = body.slice(at, at + 90);
    const close = snippet.indexOf(')');
    const call = close >= 0 ? snippet.slice(0, close + 1) : snippet;
    if (m[1] === 'color' || m[1] === 'oklch' || m[1] === 'lab' || m[1] === 'lch') { bad.push(call); continue; }
    if (NEUTRAL.test(call.replace(/\s+/g, ' ').replace(/,/g, ', '))) continue;   // 中性叠加，允许
    bad.push(call.replace(/\s+/g, ' '));
  }

  if (isDerived) {
    if (bad.length) { derivedHits += bad.length; console.log(`  · [派生] ${rel}  ${bad.length} 处（设计稿授权值，不判定）`); }
    continue;
  }
  if (isPalette) {
    /* 色板文件：字面量在 `:root[data-theme=…]` 块内属本分（它就是赋值处）；
       跑到别的选择器里才是违规（那意味着组件样式绕开了令牌）。 */
    const leaks = paletteLeaks(body);
    if (bad.length) { paletteHits += bad.length; console.log(`  · [色板] ${rel}  ${bad.length} 处（令牌赋值，不判定）`); }
    if (leaks.length) {
      handViolations += leaks.length;
      console.log(`  [违规] ${rel} —— 色值字面量出现在色板块之外：`);
      for (const l of leaks.slice(0, 8)) console.log(`         ${l}`);
      if (leaks.length > 8) console.log(`         …另有 ${leaks.length - 8} 处`);
    }
    continue;
  }
  if (bad.length) {
    handViolations += bad.length;
    console.log(`  [违规] ${rel}`);
    for (const b of bad.slice(0, 8)) console.log(`         ${b}`);
    if (bad.length > 8) console.log(`         …另有 ${bad.length - 8} 处`);
  }
}

console.log('');
if (derivedHits) console.log(`派生文件里 ${derivedHits} 处设计稿授权色值（不计入判定）。`);
if (paletteHits) console.log(`色板文件里 ${paletteHits} 处令牌赋值色值（不计入判定）。`);
if (handViolations === 0) {
  console.log('[OK] AC-11 通过：手写组件样式零色值字面量（例外仅 #fff/#000 与其透明变体、中性叠加）。');
  process.exitCode = 0;
} else {
  console.log(`[FAIL] AC-11 未通过：手写文件里 ${handViolations} 处色值字面量。`);
  process.exitCode = 1;
}
