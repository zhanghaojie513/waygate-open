/** 品牌标记（Waygate）：采用介绍片的紫色折面图形，按需缩放。
 *  固定各折面的配色，确保明暗主题下保持同一品牌形象。
 *  保留可选 id 参数，兼容官网顶栏、页脚等现有调用。 */
export function BrandMark({ size = 26 }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" fill="none" role="img" aria-label="Waygate">
      <polygon points="80,8 148,48 128,125 50,151 12,78" fill="#5A48D6" opacity=".12" />
      <polygon points="80,8 80,94 12,78" fill="#8774E8" />
      <polygon points="80,8 148,48 80,94" fill="#5A48D6" />
      <polygon points="148,48 128,125 80,94" fill="#3F5FD8" />
      <polygon points="12,78 80,94 50,151" fill="#B3A5F3" />
      <polygon points="80,94 128,125 50,151" fill="#7562D4" />
    </svg>
  );
}
// @zbiti-ai:f:22:fdc16102
