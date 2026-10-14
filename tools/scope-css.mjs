/**
 * CSS 作用域限定器（一次性工具）
 * ---------------------------------------------------------------------------
 * 为什么需要它：官网（v4 原型 ui.css / landing.css / scene.css）与控制台
 * 高度共用类名（`.nav` `.section` `.btn` `.pill` `.card` `.code` `.grid-*` …）。
 * 控制台这些类定义在全局命名空间里，官网若同样全局，就会与控制台互相污染。
 *
 * 做法：把官网三份样式表里的**每一条选择器**前缀 `.landing `，
 * 使官网样式只在官网根节点内生效；控制台落在这个作用域之外。
 *
 * 少数**不能**加前缀的选择器（html / body / * / 滚动条）被显式改写 —— 见 SPECIAL。
 *
 * 不重排、不合并、不美化：输出尽量贴近输入，便于逐行 diff 复核。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stripEmoji } from './lib/deemoji.mjs';

const SRC = 'relay-station-design/prototype/v4';
const OUT = 'web/src/landing';

/* 不能直接前缀 `.landing ` 的选择器 → 显式改写 */
const SPECIAL = new Map([
  ['html', 'html.relay-landing'],
  ['body', '.landing'],
  ['::-webkit-scrollbar', 'html.relay-landing ::-webkit-scrollbar'],
  ['::-webkit-scrollbar-track', 'html.relay-landing ::-webkit-scrollbar-track'],
  ['::-webkit-scrollbar-thumb', 'html.relay-landing ::-webkit-scrollbar-thumb'],
  ['[id]', '.landing [id]'],
]);

/* 整条选择器列表的特例（合并处理，避免半套覆盖） */
const UNIVERSAL = '.landing, .landing *, .landing *::before, .landing *::after';

function classifyPrelude(prelude) {
  const t = prelude.trim();
  if (/^@(-webkit-)?keyframes\b/.test(t)) return 'keyframes';
  if (/^@(media|supports|container|layer|document)\b/.test(t)) return 'group';
  if (t.startsWith('@')) return 'other';
  return 'rule';
}

function indentOf(s) {
  return (s.match(/^[ \t]*/) || [''])[0];
}

function scopeRulePrelude(prelude) {
  const trimmed = prelude.trim();
  if (/^\*\s*,\s*\*::before\s*,\s*\*::after$/.test(trimmed)) {
    const indent = indentOf(prelude);
    return indent + UNIVERSAL + '\n' + indent;
  }
  const indent = indentOf(prelude);
  const scoped = trimmed.split(',').map((sel) => {
    const s = sel.trim();
    if (!s) return s;
    if (SPECIAL.has(s)) return SPECIAL.get(s);
    return `.landing ${s}`;
  });
  return indent + scoped.join(',\n' + indent) + '\n' + indent;
}

function transform(css) {
  let buffer = '';
  let out = '';
  const stack = [];

  const flushComment = (text) => {
    if (buffer.trim() === '') {
      out += buffer + text;
      buffer = '';
    } else {
      buffer += text;
    }
  };

  for (let i = 0; i < css.length; i += 1) {
    const two = css.slice(i, i + 2);
    if (two === '/*') {
      const end = css.indexOf('*/', i + 2);
      const comment = css.slice(i, end === -1 ? css.length : end + 2);
      flushComment(comment);
      i += comment.length - 1;
      continue;
    }
    const ch = css[i];
    if (ch === '{') {
      const prelude = buffer;
      buffer = '';
      const inKeyframes = stack.includes('keyframes');
      const type = inKeyframes ? 'keyframes' : classifyPrelude(prelude);
      if (!inKeyframes && type === 'rule') out += scopeRulePrelude(prelude);
      else out += prelude;
      out += '{';
      stack.push(type);
    } else if (ch === '}') {
      out += buffer + '}';
      buffer = '';
      stack.pop();
    } else {
      buffer += ch;
    }
  }
  out += buffer;
  return out;
}

const HEADER =
  '/* ==========================================================================\n' +
  '   ⚠️ 自动产出：由 tools/scope-css.mjs 从\n' +
  '      relay-station-design/prototype/v4/<同名文件> 生成。\n' +
  '   要改请改原型稿再重跑脚本。本文件只在原型基础上加了 `.landing` 作用域前缀，\n' +
  '   规则内容与原型一致（便于 diff），不重排、不合并。\n' +
  '   ========================================================================== */\n\n';

/**
 * @keyframes 名字是**全局**的：后定义的会覆盖先定义的。
 * 官网的 `sheen` 与控制台 console-fx.css 的 `sheen` 撞名（后者动画的是 `left`，
 * 前者动画的是 background-position）—— 不改名就会互相覆盖，且症状是
 * 「动画动了，但动的是错的东西」，极难排查。`grad-sweep` 同理（motion.css）。
 * 只改**关键帧名与 animation 引用**，不动 `--sheen-dur` 这类变量名。
 */
const RENAME = {
  'scene.css': [
    [/@keyframes sheen\b/g, '@keyframes p-sheen'],
    [/animation:\s*sheen\b/g, 'animation: p-sheen'],
    /* P0-2：色值字面量只允许 #fff / #000。`#FFFFFF` 是同一个色的另一种写法，
       归一成白名单形式（零视觉差异），其余场景材质字面量是设计稿的授权值，保留。 */
    [/#FFFFFF\b/gi, '#fff'],
  ],
  'ui.css': [
    [/@keyframes grad-sweep\b/g, '@keyframes lg-grad-sweep'],
    [/animation:\s*grad-sweep\b/g, 'animation: lg-grad-sweep'],
  ],
};

const FILES = ['scene.css', 'ui.css', 'landing.css'];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const name of FILES) {
    let css = await readFile(path.join(SRC, name), 'utf8');
    for (const [re, to] of RENAME[name] || []) css = css.replace(re, to);
    await writeFile(path.join(OUT, name), stripEmoji(HEADER + transform(css)), 'utf8');
    console.log(`scoped ${name} → ${path.join(OUT, name)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
