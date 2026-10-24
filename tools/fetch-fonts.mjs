/**
 * 自托管字体抓取器（一次性工具）
 * ---------------------------------------------------------------------------
 * 为什么需要它：原型 `tokens.css` 用 `@import` 从 fonts.googleapis.com 取
 * Sora / Noto Sans SC / JetBrains Mono。产品要求「断网可用」，所以必须把字体
 * 落到本仓库。这个脚本做三件事：
 *   ① 以「支持 woff2 的 UA」请求 Google Fonts css2（不带该 UA 会拿到 ttf）
 *   ② 把每一条 @font-face 的 woff2 下载到 web/public/fonts/
 *   ③ 把 url() 改写成 /fonts/...，写出本地 fonts.css
 * 生成物是**构建输入**，脚本本身不必再跑；跑它需要联网。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const OUT_DIR = path.resolve('web/public/fonts');
const CSS_OUT = path.resolve('web/src/styles/vendor/fonts.css');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FAMILIES = [
  /* v5 · 字体清单是「体积 vs 覆盖」的取舍结果，不是把所有字重都拉下来。
   *
   * 删除 Sora：--font-display 已改为 Manrope，全项目零引用了。
   *   留着它只是让 fonts.css 多 8 个 @font-face 声明 + 8 个 woff2 文件。
   * 删除 Noto Sans SC 的 900：只有 .h2 一条规则用（且那条规则同时指定了
   *   --font-body，中文实际落不到 900），删掉少 101 个分片。
   * 思源宋体只保留 500/700：品牌名（700）与标题斜体（500）各一档，
   *   italic 由浏览器合成（中文衬线没有真斜体字形，合成斜体在这两处可接受）。
   */
  /* display：拉丁字符，不切分（Google 不给纯拉丁字体做 unicode-range） */
  { query: 'Manrope:wght@300;400;600;700;800', slug: 'manrope' },
  /* 品牌名与标题衬线斜体 */
  { query: 'Noto+Serif+SC:wght@500;700', slug: 'noto-serif-sc' },
  /* 正文字体 */
  { query: 'Noto+Sans+SC:wght@400;500;700', slug: 'noto-sans-sc' },
  /* 等宽：数字与代码 */
  { query: 'JetBrains+Mono:wght@400;500;700', slug: 'jetbrains-mono' },
];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** 极简 @font-face 解析：Google 的输出结构稳定，逐块正则足够且不引依赖。 */
function parseFaces(css) {
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  return blocks.map((block) => {
    const grab = (re) => (block.match(re) || [])[1]?.trim();
    return {
      family: grab(/font-family:\s*'([^']+)'/),
      weight: grab(/font-weight:\s*([^;]+);/),
      style: grab(/font-style:\s*([^;]+);/),
      range: grab(/unicode-range:\s*([^;]+);/),
      url: grab(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/),
    };
  }).filter((f) => f.url);
}

/**
 * 可变字体去重：Google 对可变字体的每个字重返回**同一个** woff2 URL。
 * 若逐字重各写一条 @font-face（各自不同的本地文件名），浏览器按 URL 缓存，
 * 同一组字形会按字重重复下载。这里按 (family, style, url) 合并，
 * font-weight 写成区间（如 `400 900`），一个分片只下载一次。
 */
function mergeVariableFaces(faces) {
  const groups = new Map();
  for (const f of faces) {
    const key = `${f.family}|${f.style}|${f.url}`;
    const w = Number.parseInt(f.weight || '400', 10);
    const g = groups.get(key);
    if (g) {
      g.min = Math.min(g.min, w);
      g.max = Math.max(g.max, w);
    } else {
      groups.set(key, { ...f, min: w, max: w });
    }
  }
  return [...groups.values()].map(({ min, max, ...f }) => ({
    ...f,
    weight: min === max ? String(min) : `${min} ${max}`,
  }));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++; // eslint-disable-line no-plusplus
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const faces = [];
  let counter = 0;

  for (const fam of FAMILIES) {
    const css = await fetchText(
      `https://fonts.googleapis.com/css2?family=${fam.query}&display=swap`,
    );
    const parsed = parseFaces(css);
    await mapLimit(parsed, 16, async (face) => {
      const idx = counter++; // eslint-disable-line no-plusplus
      const name = `${fam.slug}-${idx}.woff2`;
      await download(face.url, path.join(OUT_DIR, name));
      faces.push({ ...face, local: `/fonts/${name}`, order: idx });
      process.stdout.write(`\r下载中 ${faces.length}`);
    });
  }

  const header =
    '/* 由 tools/fetch-fonts.mjs 生成 —— 自托管字体，断网可用。\n' +
    '   字体文件在 web/public/fonts/；不要手改本文件，改 FAMILIES 后重跑脚本。 */\n\n';
  const body = faces
    .map(
      (f) =>
        `@font-face {\n` +
        `  font-family: '${f.family}';\n` +
        `  font-style: ${f.style || 'normal'};\n` +
        `  font-weight: ${f.weight || '400'};\n` +
        `  font-display: swap;\n` +
        `  src: url('${f.local}') format('woff2');\n` +
        (f.range ? `  unicode-range: ${f.range};\n` : '') +
        `}`,
    )
    .join('\n');

  await writeFile(CSS_OUT, header + body + '\n', 'utf8');
  console.log(`\n完成：${faces.length} 个 woff2 → ${OUT_DIR}`);
  console.log(`CSS → ${CSS_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
