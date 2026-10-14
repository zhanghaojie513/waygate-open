/**
 * 记住控制台最后停留的视图（AC-10：`/` 与 `/console` 来回切，视图状态不能丢）。
 *
 * 为什么需要：从控制台点品牌 logo 回官网、再点「打开控制台」时，
 * 若链接只写 `/console`，hash 路由会落回 `overview` —— 用户刚才在「请求日志」页
 * 这件事实就丢了。这里把最后的路由记在 **sessionStorage**（同一个标签页内有效，
 * 关掉标签即忘），官网侧的「打开控制台」链接据此补上 `#/xxx`。
 *
 * `useHashRoute` 的语义**不改**（§2.4）—— 记录动作由 AppShell 的 effect 完成。
 */
import { ROUTES } from '../hooks/useHashRoute';
import type { Route } from '../hooks/useHashRoute';

const KEY = 'relay.console.route';

export function rememberConsoleRoute(route: Route): void {
  try {
    window.sessionStorage.setItem(KEY, route);
  } catch {
    /* 隐私模式 / 禁用存储：记不住就落回 overview，不报错。 */
  }
}

export function lastConsoleRoute(): Route {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw && (ROUTES as string[]).includes(raw)) return raw as Route;
  } catch {
    /* 同上 */
  }
  return 'overview';
}

/** 官网侧「打开控制台」的 href：带上上次停留的视图。 */
export function consoleHref(route?: Route): string {
  return `/console#/${route ?? lastConsoleRoute()}`;
}
// @zbiti-ai:f:37:abc4bbd2
