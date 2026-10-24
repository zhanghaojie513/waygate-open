import type { ReactNode } from 'react';

/** 顶栏右侧的状态胶囊：live 在线 / amber 待处理 / cyan 数据源 / ghost 中性 */
export function Pill({
  tone = 'ghost',
  dot = false,
  children,
}: {
  tone?: 'live' | 'amber' | 'cyan' | 'ghost';
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot ? <span className="dot dot-live" /> : null}
      {children}
    </span>
  );
}

/** 表格里的状态标签：live 启用 / off 已停用 / exp 已过期 / amber 警示 */
export function Tag({
  tone = 'off',
  children,
}: {
  tone?: 'live' | 'off' | 'exp' | 'amber';
  children: ReactNode;
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

/**
 * Chip —— 带圆点的语义标签。`Tag` 的继任者。
 *
 * [v5] 为什么再起一个而不是改 `Tag`：
 *   `Tag` 在 6 个表格里被用来表达「启用 / 停用 / 过期」这类**行状态**，
 *   带底色的 `.tag-*` 样式是它的既有契约。而新方案需要的是
 *   「可用 / 降级 / 未通过 / 待验证」这组**健康语义** —— 两者会同时出现在
 *   同一行（一个提供商既"已启用"又"降级中"），必须能视觉区分。
 *
 * 圆点不是装饰：它是「这个状态有一个实时来源」的信号，与纯文字的 Tag 拉开
 * 认知层级 —— 读的人不用读文字就知道"这个会变"。
 */
export function Chip({
  tone = 'mute',
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'mute';
  children: ReactNode;
}) {
  return (
    <span className={`chip chip-${tone}`}>
      <i />
      {children}
    </span>
  );
}
