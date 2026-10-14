/** 品牌标记（Waygate）。原型侧栏那个渐变标记，按需缩放。
 *
 *  `id` 可传：同一个页面上出现两次（官网顶栏 + 页脚）时，两个 SVG 的
 *  `<linearGradient>` 不能共用同一个 id —— 重复 id 会让第二个引用到第一个，
 *  虽不报错，但在「只渲染其中一个」的场景下会拿到空渐变。 */
export function BrandMark({ size = 26, id = 'relay-mark' }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role="img" aria-label="Waygate">
      <defs>
        <linearGradient id={id} x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-stop-0)" />
          <stop offset=".5" stopColor="var(--brand-stop-1)" />
          <stop offset="1" stopColor="var(--brand-stop-2)" />
        </linearGradient>
      </defs>
      <path d="M4.5 27L14.9 16.6" stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="18.5" cy="14.5" r="5.4" fill={`url(#${id})`} />
      <path d="M21.8 11.2L27.9 5.1" stroke={`url(#${id})`} strokeWidth="4.6" strokeLinecap="round" />
      <path d="M22.1 17.9H28.1" stroke={`url(#${id})`} strokeWidth="4.6" strokeLinecap="round" />
    </svg>
  );
}
// @zbiti-ai:f:22:fdc16102
