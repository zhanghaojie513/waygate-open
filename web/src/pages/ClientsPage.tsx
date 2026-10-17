import { useState } from 'react';
import type { TimeWindow } from '../types/api';
import { readSharedWindow, writeSharedWindow } from '../lib/sharedWindow';
import { Topbar } from '../components/ui/Topbar';
import { Select } from '../components/ui/Select';
import { ProvidersPanel } from '../components/clients/ProvidersPanel';
import { WINDOW_OPTIONS } from '../lib/console';

/**
 * 提供商管理 —— **一张表**：提供商行 = 汇总，其下嵌套客户端行 = 明细。
 *
 * [2026-10-09] 本页原先有两张表（客户端用量 + 提供商），合并成一张：
 * 这个部署是**反代一个客户端订阅**，提供商本身就是"某个客户端的订阅"，
 * 两者是同一件事的两端；各只有一行时，两张表看着就是重复。
 * 表结构与提供商行的用量归属规则写在 `ProviderTable.tsx`。
 *
 * 顶栏的窗口选择器仍在 —— 它决定客户端行报的用量窗口（`api.clients(window)`）。
 */
export function ClientsPage() {
  const [win, setWin] = useState<TimeWindow>(() => readSharedWindow() ?? 'today');

  return (
    <div className="view on">
      <Topbar
        title="提供商管理"
        actions={<Select value={win} options={WINDOW_OPTIONS} onChange={(v) => { writeSharedWindow(v); setWin(v); }} width={148} />}
      />
      <div className="view-body stack">
        <ProvidersPanel window={win} />
      </div>
    </div>
  );
}
