/**
 * 提供商身份色 —— 光谱七色按 `id` 稳定映射。
 *
 * 为什么按 id 哈希而不是按数组下标：
 *   下标会随列表顺序变化（新建、删除、排序），用户的"红的那家"会突然变成橙色，
 *   那就不是身份色了，只是位置色。id 是稳定的，同一个提供商永远同一个颜色。
 *
 * 为什么用光谱色而不是品牌色：
 *   品牌色（朱砂）占着"当前选中 / 核心指标 / 主操作"这三个语义位，
 *   分给提供商就再也分不清"这是品牌还是某一家"。光谱七色是专职的编码色板，
 *   与官网棱镜装置同源 —— 装置里"光被分成七色"，这里"流量按来源分色"。
 *
 * 哈希函数用简单的 FNV-1a：足够散、无依赖、同输入同输出。
 */
const SPECTRUM = [
  'var(--spectrum-1)',
  'var(--spectrum-2)',
  'var(--spectrum-3)',
  'var(--spectrum-4)',
  'var(--spectrum-5)',
  'var(--spectrum-6)',
  'var(--spectrum-7)',
  /* [v1.10.3] 8-10 号补位：哈希 % 7 在 3+ 家时撞色概率很高（生日悖论，4 家 ~35%）,
     扩到 10 显著降低；图表内另按系列序分配（spectrumByIndex），哈希只服务跨页身份。 */
  'var(--spectrum-8)',
  'var(--spectrum-9)',
  'var(--spectrum-10)',
] as const;

/** [v1.10.3] 按序取色（循环）—— 图表专用：同屏系列各取各的序号，**同屏必不同色**。
 *  哈希法在同一页面撞色是用户报障根因（折线图 3+ 家出现同色）。
 *  序号 = 图表数据归并时的排名（tokens 降序），同页稳定；跨页身份仍走 providerColor(id)。 */
export function spectrumByIndex(i: number): string {
  return SPECTRUM[((i % SPECTRUM.length) + SPECTRUM.length) % SPECTRUM.length];
}

/** 稳定哈希 → 光谱色 CSS 变量引用。 */
export function providerColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SPECTRUM[(h >>> 0) % SPECTRUM.length];
}
