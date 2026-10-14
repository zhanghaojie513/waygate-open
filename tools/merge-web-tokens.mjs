/**
 * 令牌合并器（一次性工具，可重入）
 * ===========================================================================
 * 目的（Spec §3）：把官网的 v4 令牌（`prototype/v4/tokens.css`，107 个）
 * 作为**唯一来源**写进 `web/src/styles/vendor/tokens.css`，供官网与控制台共用。
 *
 * 三件事：
 *   ① 用 v4 的 `:root` 正文替换 web 的旧 `:root`（v2.1，61 个）
 *   ② 回填「v4 未定义、但 web 代码确实引用」的令牌（下表 BACKFILL）
 *   ③ 保留 web tokens.css 里 `:root` **之后**的组件层（控制台样式）原样不动
 *
 * 为什么不做成「手改一次」：令牌合并会重跑（v4 动一次就同步一次），
 * 而手改不可复现、也会把组件层抄坏。这里组件层是**从现有文件里切出来的**，
 * 逐字节保留 —— 重入安全（第二遍结果与第一遍相同）。
 *
 * ⛔ `--ease-spring`（弹性/过冲缓动，违反 P0-3）**不回填**；
 *    控制台里对它的两处引用改指 `--ease-out`（见 console-fx.css）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripEmoji } from './lib/deemoji.mjs';

const V4 = 'relay-station-design/prototype/v4/tokens.css';
const WEB = 'web/src/styles/vendor/tokens.css';

/* v4 里没有名字、却在 web/src 里被引用的令牌。来源为对 web/src 全量
   `var(--…)` 扫描（见报告证据），所以比 Spec §3 的 6 个多 4 个 ——
   少的这 4 个若缺失，控制台侧栏宽度/胶囊圆角等会静默失效。 */
const BACKFILL = `
  /* ==========================================================================
     12 · 回填：v4 未定义、但 web 代码在引用（Spec §3 + 全量扫描补全）
     每一行都写明「谁在用」。缺一个的后果不是报错，而是该声明静默失效。
     注意：旧的弹性/过冲缓动令牌（cubic-bezier(0.34,1.56,0.64,1)）**不在此列**,
     它违反 P0-3「禁止弹跳缓动」，已被删除；控制台那两处引用改指 --ease-out。
     ========================================================================== */
  /* 品牌标记三停：BrandMark.tsx 的 SVG <stop>（SVG 无法直接用渐变）。 */
  --brand-stop-0: var(--brand-450);
  --brand-stop-1: #4D7CFF;   /* = --gradient-brand 中点，同源 */
  --brand-stop-2: #35DCE8;   /* = --gradient-brand 终点，同源 */
  /* 柱状图纵向渐变顶端（app.css .bars30 .b.today）。 */
  --signal-live-lt: #6BF0AC;
  --danger-red-lt: #FFB4B4;
  /* 揭示动画时长：映射到 v4 的 --d-panel（420ms）。不要写死，让它跟 v4 一起动。 */
  --d-reveal: var(--d-panel);
  /* 卡片栅格间距：tokens.css 自身的 .grid-* 在用。 */
  --card-gap: 24px;
  /* 控制台布局三件（tokens.css / app.css 在用）。 */
  --content-width: 1200px;
  --page-gutter: 120px;
  --dashboard-sidebar: 248px;
  /* 胶囊圆角：.pill / .tag 在用；v4 只给了 xs…2xl 阶梯，pill 是单独一档。 */
  --radius-pill: 999px;
`;

const HEADER = `/* ==========================================================================
   驿站 · Relay — 设计令牌（单一来源）
   ==========================================================================

   本文件的 \`:root\` 正文 = **官网 v4 令牌**（\`prototype/v4/tokens.css\`，权威）
   + 一组「v4 未定义但 web 在用」的回填（见正文 §12）。
   来源与拆分规则见 design/spec-v4-landing-integration.md §3。

   \`:root\` 之后的**组件层**（控制台样式）保持原样 —— 它不参与合并。
   字体不在这里：已自托管，见 \`web/src/styles/vendor/fonts.css\`。

   ⚠️ 本文件由 tools/merge-web-tokens.mjs 生成。要改令牌，改 v4 原型稿后重跑。
   ========================================================================== */

`;

/** 在 v4 的 :root 块内、闭合 `}` 之前插入 backfill 文本 */
function withBackfill(body) {
  const open = body.indexOf(':root {');
  if (open < 0) throw new Error('v4 tokens.css 里找不到 `:root {`');
  // 找 :root 块的行首闭合括号
  const close = body.indexOf('\n}', open);
  if (close < 0) throw new Error('v4 tokens.css 里找不到 :root 的闭合括号');
  return body.slice(0, close) + '\n' + BACKFILL + body.slice(close);
}

async function main() {
  const v4 = await readFile(V4, 'utf8');
  const web = await readFile(WEB, 'utf8');

  // 去掉 v4 的 Google Fonts @import（字体已自托管）
  const v4NoImport = v4.replace(/@import url\("https:\/\/fonts\.googleapis\.com[^\n]*\n/, '');
  if (v4NoImport.includes('fonts.googleapis.com')) {
    throw new Error('v4 tokens.css 里仍残留 Google Fonts @import');
  }

  const body = withBackfill(v4NoImport);

  // 切出组件层：从 `* { box-sizing` 开始（控制台样式），逐字节保留
  const marker = '* { box-sizing';
  const at = web.indexOf(marker);
  if (at < 0) throw new Error('现有 tokens.css 里找不到组件层起点（`* { box-sizing`）');
  const componentLayer = web.slice(at);

  await writeFile(WEB, stripEmoji(HEADER + body.trimEnd() + '\n\n' + componentLayer), 'utf8');

  const tokens = (body.match(/^\s*--[a-z0-9-]+\s*:/gm) || []).length;
  console.log(`[OK] 合并完成：令牌 ${tokens} 行 + 组件层 ${componentLayer.split('\n').length} 行`);
  console.log('[注意] --ease-spring 未回填（弹性缓动，见 console-fx.css）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
