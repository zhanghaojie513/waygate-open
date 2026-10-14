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
