/**
 * 设置页元数据的类型（api-contract §3.8）。
 *
 * 从 `settings.catalog.ts` 拆出（task#37）：原文件 332 行越过单文件 300 行门禁。
 * 这里只放**类型**，各分组的 label/why/readonly 落在 `group-*.ts`，组装在 `index.ts`。
 */

export type SettingType = 'text' | 'number' | 'switch' | 'select' | 'badge' | 'action' | 'mapping';

export interface SettingItem {
  key: string;
  label: string;
  value?: unknown;
  type: SettingType;
  why: string;
  readonly?: boolean;
  requiresRestart?: boolean;
  options?: Array<{ value: string; label: string }>;
  tone?: string;
  /**
   * [2026-10-08] 这一项**当前不产生任何行为**（依赖的功能未实现，或上游接口未供货）。
   *
   * 为什么要有这个**结构化**字段，而不是只写在 `why` 里：
   * 原来的做法是把「此值当前不产生任何行为」写进说明句、靠人去读 —— 而设置页是
   * 十几项平铺的长列表，扫读时那半句会被完全跳过，于是用户改了它、然后等一个不会发生的变化。
   * 有了标志位，前端可以**机械地**把这些项收进「暂未生效」区，不依赖文案被读到。
   *
   * ⚠️ 它与 `readonly` **不是一回事**：`readonly` = 改不了；`noop` = 改了也白改。
   * 两者可并存（当前 4 项都是 `readonly + noop`），但语义各自独立 ——
   * 将来某个开关可改、只是其中一条分支还没接线时，那会是 `noop` 而非 `readonly`。
   */
  noop?: boolean;
}

export interface SettingGroup {
  id: string;
  label: string;
  items: SettingItem[];
}

export interface RuntimeInfo {
  /** 掩码后的上游访问密钥，如 `ck_x••••3f7a` 或 `未配置` */
  credentialSource: string;
  /** 上游访问密钥状态人话：有效 / 未配置 */
  credentialStatus: string;
}
