import { useState } from 'react';
import type { TimeWindow } from '../types/api';
import { readSharedWindow, writeSharedWindow } from '../lib/sharedWindow';
import { Topbar } from '../components/ui/Topbar';
import { ProvidersPanel } from '../components/clients/ProvidersPanel';

/**
 * 提供商管理 —— **一张表**：提供商行 = 汇总，其下嵌套客户端行 = 明细。
 *
 * [2026-10-09] 本页原先有两张表（客户端用量 + 提供商），合并成一张：
 * 这个部署是**反代一个客户端订阅**，提供商本身就是"某个客户端的订阅"，
 * 两者是同一件事的两端；各只有一行时，两张表看着就是重复。
 * 表结构与提供商行的用量归属规则写在 `ProviderTable.tsx`。
 *
 * [v1.10.3] 窗口选择从下拉改为**与概览/用量页同款四段平铺**（用户裁决）：
 * 同一语义的控件跨页长得一样，且档位一次可见一次可点；选择仍写入共享窗口。
 */
export function ClientsPage() {
  const [win, setWin] = useState<TimeWindow>(() => readSharedWindow() ?? 'today');

  return (
    <div className="view on">
      <Topbar
        title="提供商管理"
        actions={
          <span className="win-seg" role="group" aria-label="时间窗口">
            {(['today', '24h', '7d', '30d'] as TimeWindow[]).map((w) => (
              <button
                key={w}
                type="button"
                className={win === w ? 'on' : ''}
                aria-pressed={win === w}
                onClick={() => { writeSharedWindow(w); setWin(w); }}
              >
                {w === 'today' ? '今日' : w === '24h' ? '24 小时' : w === '7d' ? '7 天' : '30 天'}
              </button>
            ))}
          </span>
        }
      />
      <div className="view-body stack">
        <ProvidersPanel window={win} />
      </div>
    </div>
  );
}
