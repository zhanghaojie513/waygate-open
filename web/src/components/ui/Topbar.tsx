/** 顶栏：左侧标题 + 状态胶囊，右侧操作区。对应原型 .topbar。 */
import type { ReactNode } from 'react';
import { Pill } from './Pill';

export function Topbar({
  title,
  status,
  actions,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <h1>{title}</h1>
        {status}
      </div>
      {actions ? <div className="topbar-right">{actions}</div> : null}
    </div>
  );
}

export { Pill };
