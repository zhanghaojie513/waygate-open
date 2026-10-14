/**
 * 控制台原型 ← 前端 同步器（可重入）
 * ===========================================================================
 * 背景：用户要求「把原型同步到最新的前端页面，跟最新的前端页面一样」。
 *
 * 原型的控制台样式是**手写**的（.sb / .tb / .sb-item.on …），前端在迁移时
 * 重写成了一套自己的类名与视觉（.sidebar / .topbar / .sb-item.active …）。
 * 两边各写一遍，就必然会漂。这里把「样式基座」改成**单一来源 = 前端**：
 *
 *   ① relay-station-design/prototype/v4/console.css
 *        = web/src/styles/vendor/tokens.css 的 `:root` 起整段（令牌 + @property
 *          + prefers-reduced-motion + 控制台基础层）
 *        + web/src/styles/vendor/motion.css
 *        + web/src/styles/vendor/console-fx.css
 *        + web/src/styles/app.css
 *      —— 加载顺序与前端一致（tokens → motion → console-fx → app）。
 *      原型只需 <link> tokens.css + console.css 两份。
 *
 *   ② relay-station-design/prototype/v4/icons.js
 *        = 从 web/node_modules/lucide-react 里把 web/src 实际用到的图标
 *          序列化成内联 SVG 数据（原型是静态页，没有 React 组件）。
 *          粗细取 lucide 默认 2 —— 原型旧版用 1.6，那是与前端不一致的一处。
 *
 * 方向说明（重要）：设计意义上的「原型为准」在本目录**仍然成立**；
 * 但控制台这一层，前端已经先走一步，所以这里反过来以前端为准。
 * 文件头会写明，别手改 console.css —— 改前端后重跑本脚本。
 *
 * 用法： node tools/sync-prototype-console.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'relay-station-design', 'prototype', 'v4');

/* ---------------------------------------------------------------- ① CSS */

const HEADER = [
  '/* ==========================================================================',
  '   \u26a0\ufe0f 自动产出，请勿手改 —— 由 tools/sync-prototype-console.mjs 生成。',
  '   ==========================================================================',
  '',
  '   来源（控制台风格以**前端**为准，加载顺序与前端一致）：',
  '     \u00a70  web/src/styles/vendor/tokens.css   （:root 起整段 = 令牌 + @property',
  '         + prefers-reduced-motion + 控制台基础层）',
  '     \u00a71  web/src/styles/vendor/motion.css',
  '     \u00a72  web/src/styles/vendor/console-fx.css',
  '     \u00a73  web/src/styles/app.css',
  '',
  '   为什么要「同一份文本」而不是「照着改一遍」：',
  '     手抄一遍就会漂 —— 前端调一次间距，原型不会知道。同源之后，',
  '     前端的样式改动只要重跑一次脚本，原型立即跟上，且可逐行 diff 复核。',
  '',
  '   方向说明：本目录的整体纪律仍是「原型为准」（见 design/design-spec.md）。',
  '     但控制台这一层前端已经先行，因此这里反过来以前端为唯一来源。',
  '     官网（scene/ui/landing）方向不变：仍是原型 -> 前端（tools/scope-css.mjs）。',
  '',
  '   改样式请改前端，然后： node tools/sync-prototype-console.mjs',
  '   ========================================================================== */',
  '',
  '',
].join('\n');

function banner(t) {
  return (
    '\n/* ==========================================================================\n   ' +
    t +
    '\n   ========================================================================== */\n\n'
  );
}

async function buildCss() {
  const tokens = await readFile(path.join(WEB, 'src/styles/vendor/tokens.css'), 'utf8');
  const motion = await readFile(path.join(WEB, 'src/styles/vendor/motion.css'), 'utf8');
  const fx = await readFile(path.join(WEB, 'src/styles/vendor/console-fx.css'), 'utf8');
  const app = await readFile(path.join(WEB, 'src/styles/app.css'), 'utf8');

  /* tokens.css 从 `:root {` 起整段取走（含回填令牌、@property、降级媒体查询、
     控制台基础层）。头部那段注释是给 web 仓库看的，不带过来。 */
  const at = tokens.indexOf(':root {');
  if (at < 0) throw new Error('web tokens.css 里找不到 :root {');
  const tokensBody = tokens.slice(at).trimEnd();

  const out =
    HEADER +
    banner('\u00a70 · 令牌 + 控制台基础层 ← web/src/styles/vendor/tokens.css') +
    tokensBody +
    '\n' +
    banner('\u00a71 · 动效 ← web/src/styles/vendor/motion.css') +
    motion.trim() +
    '\n' +
    banner('\u00a72 · 控制台视觉锚点 ← web/src/styles/vendor/console-fx.css') +
    fx.trim() +
    '\n' +
    banner('\u00a73 · 应用层 ← web/src/styles/app.css') +
    app.trim() +
    '\n';

  await writeFile(path.join(OUT, 'console.css'), out, 'utf8');
  return out.length;
}

/* --------------------------------------------------------------- ② 图标 */

const ICON_HEADER = [
  '/* ==========================================================================',
  '   \u26a0\ufe0f 自动产出，请勿手改 —— 由 tools/sync-prototype-console.mjs 生成。',
  '   ==========================================================================',
  '',
  '   控制台与官网用到的 Lucide 图标，序列化成内联 SVG（原型是静态页，没有 React）。',
  '   来源：web/node_modules/lucide-react 的 __iconData（与前端**图形同源**），',
  '   因此图形、描边宽度（lucide 默认 2）与前端一致。',
  '',
  '   旧版原型把统一粗细写在 CSS（.ic { stroke-width: 1.6 }）里，前端用 2 ——',
  '   那是不一致的一处，这里改成与前端同源的 2。',
  '   ========================================================================== */',
  '',
  '',
].join('\n');

/**
 * 把 lucide 的 node 数组序列化成 SVG 内部标记。
 *
 * ⚠️ 属性顺序**必须保持 lucide 原样**（即 `Object.keys` 的插入顺序），
 * 不要"按好看的顺序重排"。原因不是审美：验证方式是拿原型的 DOM 与
 * 前端渲染出的 DOM 做**逐字**比较，把 `d` 排到 `x` 前面这种"无害重排"
 * 会让每一处差异都报出来，真差异就被淹没了。
 */
function serialize(nodes) {
  return nodes
    .map(([tag, attrs]) => {
      const body = Object.keys(attrs)
        .filter((k) => k !== 'key')
        .map((k) => ' ' + k + '="' + String(attrs[k]) + '"')
        .join('');
      return '<' + tag + body + '/>';
    })
    .join('');
}

/* 组件名 → lucide 文件名（kebab）。
   ⚠️ 数字前也要断开：Link2 -> link-2、CheckCircle2 -> check-circle-2、Loader2 -> loader-2。
   不断开就会去找 link2.mjs，找不到 —— 而"找不到"在这里表现为"图标少了一个"，
   不是报错，很容易漏。 */
function kebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

async function walkSources(dir, names) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkSources(p, names);
      continue;
    }
    if (!/\.tsx?$/.test(e.name)) continue;
    const s = await readFile(p, 'utf8');
    const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'lucide-react'/g;
    for (const m of s.matchAll(re)) {
      for (const raw of m[1].split(',')) {
        const n = raw.trim().split(/\s+as\s+/)[0].trim();
        if (n) names.add(n);
      }
    }
  }
}

async function buildIcons() {
  const names = new Set();
  await walkSources(path.join(WEB, 'src'), names);

  const dir = path.join(WEB, 'node_modules/lucide-react/dist/esm/icons');

  /* ⚠️ 别名文件只是再导出（`export { default } from './triangle-alert.mjs'`），
     它**不带 __iconData** —— 直接 import 会拿到 undefined，表现是"图标少了一个"
     而不是报错：AlertTriangle / Trash2 / CheckCircle2 / XCircle / Loader2 全是这种。
     所以这里顺着 re-export 追到真身，并把两个名字都登记上。 */
  const canonicalOf = async (file) => {
    const text = await readFile(path.join(dir, file), 'utf8');
    const m = text.match(/from '\.\/([a-z0-9-]+)\.mjs'/);
    return m ? m[1] + '.mjs' : file;
  };

  const table = {};
  for (const n of names) {
    const aliasKebab = kebab(n);
    try {
      const file = await canonicalOf(aliasKebab + '.mjs');
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const data = mod.__iconData;
      if (!data) continue;
      /* class 串必须与 lucide-react 的输出**逐字相同**：
         `lucide` + 正名 + 全部历史别名（顺序也是正名在前）。
         别名不是装饰：前端 DOM 实测就是 `lucide lucide-chart-column lucide-bar-chart-3`
         —— 少了后半段，逐个 DOM 比对时每条图标都会报一处差异，真差异会被淹掉。 */
      const cls =
        'lucide-' + data.name + (data.aliases || []).map((a) => ' lucide-' + a).join('');
      const entry = { cls, inner: serialize(data.node) };
      table[aliasKebab] = entry;
      table[data.name] = entry;
    } catch {
      /* 名字对不上：记进 missing，最后一起报 */
    }
  }

  const entries = Object.keys(table)
    .sort()
    .map(
      (k) =>
        "  '" + k + "': { cls: '" + table[k].cls + "', inner: '" + table[k].inner + "' },",
    );

  const helper = [
    '',
    '/* 描边宽度与前端一致（lucide 默认 2）。尺寸由调用处给。',
    '   class 串与 lucide-react 逐字一致：`lucide` + 正名 + 历史别名（见生成器注释）。',
    '   传进来的 name 可以是正名也可以是别名，两种键都在表里，输出相同。 */',
    'window.lucideSvg = function (name, size, extraClass) {',
    '  var e = window.LUCIDE[name];',
    "  if (!e) throw new Error('未登记的图标：' + name);",
    '  size = size || 24;',
    '  return \'<svg xmlns="http://www.w3.org/2000/svg" width="\' + size + \'" height="\' + size + \'" \' +',
    "         'viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" ' +",
    "         'stroke-linecap=\"round\" stroke-linejoin=\"round\" ' +",
    '         \'class="lucide \' + e.cls + (extraClass ? \' \' + extraClass : \'\') + \'" aria-hidden="true">\' +',
    "         e.inner + '</svg>';",
    '};',
    '',
  ];

  const body =
    'window.LUCIDE = {\n' + entries.join('\n') + '\n};\n' + helper.join('\n');

  await writeFile(path.join(OUT, 'icons.js'), ICON_HEADER + body, 'utf8');
  const missing = [...names].filter((n) => !table[kebab(n)]);
  return { count: Object.keys(table).length, missing };
}

/* ------------------------------------------------------------- ③ 版本号 */

/**
 * 原型侧栏也要显示版本号（与前端 AppShell 的 .brand-ver 同一处）。
 * 原型是静态页、没有 vite define，所以由一个生成物提供 —— 值现读 web/package.json，
 * 与 server/src/version.ts、web/src/landing/data.ts 同源。
 * 生成而不是手写：手写的版本号必然在某次发版时漏改，而它恰恰是判新旧的唯一快速判据。
 */
async function buildVersion() {
  const pkg = JSON.parse(await readFile(path.join(WEB, 'package.json'), 'utf8'));
  const body = [
    '/* ==========================================================================',
    '   \u26a0\ufe0f 自动产出，请勿手改 —— 由 tools/sync-prototype-console.mjs 生成。',
    '   ==========================================================================',
    '',
    '   构建版本号（来自 web/package.json）—— 原型侧栏品牌区读它，与前端同源。',
    '   ========================================================================== */',
    '',
    'window.RELAY_VERSION = ' + JSON.stringify(pkg.version) + ';',
    '',
  ].join('\n');
  await writeFile(path.join(OUT, 'version.js'), body, 'utf8');
  return pkg.version;
}

/* ---------------------------------------------------------------- main */

const cssBytes = await buildCss();
const { count, missing } = await buildIcons();
const version = await buildVersion();
console.log('[OK] console.css  ' + (cssBytes / 1024).toFixed(1) + ' KB');
console.log('[OK] icons.js     ' + count + ' 个图标');
console.log('[OK] version.js   v' + version);
if (missing.length) console.log('[注意] 未找到数据：' + missing.join(', '));
