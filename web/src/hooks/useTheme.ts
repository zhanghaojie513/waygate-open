import { useSyncExternalStore } from 'react';
import {
  getSnapshot,
  subscribeTheme,
  setThemePreference,
  type ThemePreference,
  type ThemeSnapshot,
} from '../lib/theme';

/**
 * 订阅主题快照 `{ theme, preference }` + 写偏好。
 *
 * 为什么要订阅而不是 useState：同一份偏好可能被多个入口消费
 * （侧栏开关、将来的设置页……），订阅式 store 保证它们永远一致。
 *
 * `theme` 与 `preference` 是**两个不同的值**，别混用：
 *   · `theme`       = 实际渲染的极性（官网恒 'dark'；控制台由偏好 + 系统决定）
 *   · `preference`  = 用户选的那一项（'system' | 'light' | 'dark'）
 * 控件的**选中态**读 preference，页面观感读 theme。
 *
 * [注意] 两者必须来自**同一个快照对象**，不能一个订阅、一个现读 ——
 * 见 lib/theme.ts 里 ThemeSnapshot 的说明：只订阅 theme 会让"偏好变了、
 * 但极性没变"的切换（浅色 → 跟随系统，而系统恰好也是浅色）漏掉重渲染。
 */
export function useTheme(): ThemeSnapshot & { setPreference: (p: ThemePreference) => void } {
  const snap = useSyncExternalStore(
    subscribeTheme,
    getSnapshot,
    /* SSR 兜底（本项目不 SSR）：给一个确定的初始值，避免服务端/客户端首帧不一致。 */
    () => ({ theme: 'dark', preference: 'system' }) as ThemeSnapshot,
  );
  return { ...snap, setPreference: setThemePreference };
}
