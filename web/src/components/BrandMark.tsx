/** 品牌标记（Waygate）：采用介绍片的紫色折面图形，按需缩放。
 *  [2026-10-17 修复] 各折面此前硬编码浅色品牌值（#5A48D6/#3F5FD8 是 theme.css
 *  浅色档），深色主题下不回退 —— 与 tokens.css 品牌标记令牌并行成两套值。
 *  现引用品牌令牌：SVG 属性 fill 支持 CSS 变量（内联 SVG 继承文档样式），
 *  深浅主题各自跟随。视觉基准：深色用 450-500 档（原深色版本的实际观感），
 *  浅色自动切到 theme.css 的浅色值。保留可选 id 参数兼容现有调用。 */
export function BrandMark({ size = 26 }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" fill="none" role="img" aria-label="Waygate">
      <polygon points="80,8 148,48 128,125 50,151 12,78" fill="var(--brand-500)" opacity=".12" />
      <polygon points="80,8 80,94 12,78" fill="var(--brand-400)" />
      <polygon points="80,8 148,48 80,94" fill="var(--brand-500)" />
      <polygon points="148,48 128,125 80,94" fill="var(--accent-blue)" />
      <polygon points="12,78 80,94 50,151" fill="var(--brand-450)" opacity=".85" />
      <polygon points="80,94 128,125 50,151" fill="var(--brand-450)" />
    </svg>
  );
}
// @zbiti-ai:f:22:fdc16102
