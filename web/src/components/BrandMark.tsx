/** 品牌标记（Waygate）：五面折角宝石。
 *
 * [v5] 几何完全未动（六个 polygon 的 points 与原版逐字相同），只换配色：
 *   · 原版用 --brand-500/400/450 + --accent-blue 四个色，紫蓝相间；
 *   · 新方案是单色品牌 —— 朱砂 + 五档透明度分面。
 *
 * 为什么单色而不是六面各一色：
 *   试过光谱六色（与棱镜装置同源），30px 下六个色块会碎成一堆色点，
 *   读不出"一颗折角宝石"的轮廓；而且与全站"只有一个强调色"的规则打架。
 *   单色 + 透明度照样能读出折面（相邻面的明度差 ≥0.12），
 *   同时保持标识该有的干净 —— 标识不是插画，它要在 16px 下仍认得出。
 */
export function BrandMark({ size = 26 }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" fill="none" role="img" aria-label="Waygate">
      <polygon points="80,8 148,48 128,125 50,151 12,78" fill="var(--brand-500)" opacity=".12" />
      <polygon points="80,8 80,94 12,78" fill="var(--brand-500)" opacity=".56" />
      <polygon points="80,8 148,48 80,94" fill="var(--brand-500)" />
      <polygon points="148,48 128,125 80,94" fill="var(--brand-500)" opacity=".78" />
      <polygon points="12,78 80,94 50,151" fill="var(--brand-500)" opacity=".68" />
      <polygon points="80,94 128,125 50,151" fill="var(--brand-500)" opacity=".44" />
    </svg>
  );
}
