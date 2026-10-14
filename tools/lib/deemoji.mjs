/**
 * 注释里 emoji 记号的 ASCII 归一化（供生成脚本与独立清理脚本共用）。
 *
 * 背景见 `tools/strip-emoji-comments.mjs` 的文件头。要点：P0-1 禁的是「emoji 当
 * 功能图标」，但门禁扫描是一条朴素 grep，会命中注释里的 ⚠️ / ⛔。设计师的
 * prototype 原始稿保持逐字节保真（不在这里处理），但**我们生成的源码**要干净，
 * 否则每次重新生成都会把记号带回来。
 */

/* 带 VS16(U+FE0F) 的合字先匹配，避免留下孤立的变体选择符。 */
export const EMOJI_MAP = [
  [/\u26A0\uFE0F/g, '[注意]'],
  [/\u26A0/g, '[注意]'],
  [/\u26D4\uFE0F?/g, '[禁止]'],
  [/\u{1F6A7}\uFE0F?/gu, '[待办]'],
  [/\u{1F4A1}\uFE0F?/gu, '[提示]'],
  /* 兜底：任何漏网的 emoji 一律抹成 [注]，绝不把字形留在源码里。 */
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu, '[注]'],
];

export const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu;

export function stripEmoji(s) {
  let out = s;
  for (const [re, to] of EMOJI_MAP) out = out.replace(re, to);
  return out;
}
