import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import type { ThemePreference } from '../lib/theme';
import { Tooltip } from './ui/Tooltip';

/**
 * 主题开关：**三态**分段控件（跟随系统 / 浅色 / 深色）。
 *
 * 为什么不是两态开关：默认是「跟随系统」，而两态表达不了这一态 ——
 * 用户一点开关，偏好就被钉死成具体极性，系统日落时切深色页面不跟，
 * 而且再也回不到"跟随系统"。三态是这类需求的正确模型。
 *
 * 为什么用 radiogroup 而不是三个 toggle button：三个选项互斥且需要"当前选中哪一个"
 * 的语义。`role=radio` + `aria-checked` 正是这个语义；读屏会念
 * 「外观，跟随系统，单选按钮，已选中」。键盘走原生 radio 习惯（←→ 切换）。
 * 只保留一个 Tab 停靠点（未选中项 tabIndex=-1），与原生单选组一致。
 *
 * 图标用 lucide 矢量（Monitor / Sun / Moon），不用 emoji —— 项目纪律。
 * 说明由 Portal Tooltip 提供，aria-label 保留给读屏。
 */
const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  /* ←→ 在组内移动选中项（原生 radio 的键盘习惯）。 */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = OPTIONS.findIndex((o) => o.value === preference);
    const next = e.key === 'ArrowRight' ? (i + 1) % OPTIONS.length : (i - 1 + OPTIONS.length) % OPTIONS.length;
    setPreference(OPTIONS[next].value);
  };

  return (
    <div className="theme-seg" role="radiogroup" aria-label="外观" onKeyDown={onKeyDown}>
      {OPTIONS.map(({ value, label, Icon }) => {
        const on = preference === value;
        return (
          <Tooltip key={value} content={label}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              /* roving tabindex：只有选中项可 Tab 到，组内用 ←→ 移动 */
              tabIndex={on ? 0 : -1}
              className={`theme-seg-i${on ? ' on' : ''}`}
              aria-label={label}
              onClick={() => setPreference(value)}
            >
              <Icon size={14} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
