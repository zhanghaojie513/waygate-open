import type { ReactNode } from 'react';
import ConfigProvider from '@arco-design/web-react/es/ConfigProvider';
import '@arco-design/web-react/es/ConfigProvider/style/css.js';
/* React 19 适配：Arco 内部的挂载（Message/Modal 的 portal 等）用旧版
 * React API；这个副作用 import 把 createRoot 注入给它。
 * 2.66 的 peer 是 react>=16（没声明 19），不引入这行在 19 下会炸。 */
import '@arco-design/web-react/es/_util/react-19-adapter';
import { useTheme } from '../../hooks/useTheme';

/**
 * Arco 组件的主题桥。
 *
 * ## 为什么需要它
 *
 * Arco 有自己的色板体系（--color-primary-1..10 / --color-bg-1..5 / …），
 * 默认是 Arco 蓝 + 冷灰白。本项目是朱砂 + 暖象牙 —— 不映射的话，
 * 控制台里混进来的 Arco 组件会像贴上去的补丁。
 *
 * ConfigProvider 的 `theme` 会把变量写到运行时的 :root 上。
 *
 * ## 色值不写在本地 —— 读 --arco-* 令牌
 *
 * 映射值定义在 tokens.css（深色侧）与 theme.css（浅色侧）的 --arco-* 一组里：
 * 那两个文件是色板的赋值处，字面量在那里是本分；TSX 里出现字面量会被
 * AC-11 门禁拦下。这里读计算值组装（Canvas 式组件同理，见 chartTheme.ts）。
 *
 * ## 明暗联动
 *
 * `useTheme()` 是订阅式的（lib/theme.ts 的 store）：侧栏开关切极性时，
 * ConfigProvider 随快照重渲染、重读一组令牌 —— Arco 组件不需要知道
 * 项目的主题系统存在。
 *
 * ## 只包局部，不挂 AppShell
 *
 * ConfigProvider 会把 Arco 的基础设施（locale/context）拉进所在 chunk。
 * 挂在 AppShell（首屏静态）实测把 index 主包从 42KB 撑到 219KB ——
 * 所以它跟着实际用到 Arco 组件的页面走（如请求日志的分页器）。
 */
const KEYS = [
  'primary-5', 'primary-6', 'primary-7',
  'bg-2', 'bg-3',
  'text-1', 'text-2', 'text-3',
  'border-2',
  'fill-2', 'fill-3',
] as const;

function readArcoTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const k of KEYS) {
    theme[`--color-${k}`] = cs.getPropertyValue(`--arco-${k}`).trim();
  }
  return theme;
}

export function ArcoProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  /* theme 只作依赖：极性变了才重读令牌（读操作本身与极性绑定，
     直接在渲染期读即可，无需 effect + state 的一跳）。 */
  void theme;
  return <ConfigProvider theme={readArcoTheme()}>{children}</ConfigProvider>;
}
