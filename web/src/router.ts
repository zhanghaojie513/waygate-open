/**
 * 路径分流（契约见 spec-v4-landing-integration §2）。
 *
 * 官网与控制台**必须**用两套不同的东西定位，否则会互相打架：
 *   · 官网  → 原生页内锚点（`/` + `#ways`）
 *   · 控制台 → hash 路由（`/console` + `#/overview`）
 * 二者靠 **pathname** 隔离：pathname 决定渲染哪一页，hash 只在控制台页内有意义。
 * 这样在官网点 `#ways` 不会触发控制台路由，在控制台切 `#/requests` 也不会掉出控制台。
 *
 * `base: './'` 与 Nginx `try_files` 都不动（§2.3）。
 */

export type AppPath = 'landing' | 'console';

/** pathname → 该渲染哪一页。未匹配的 path 一律回官网（§2.2：不要直接进控制台）。 */
export function resolvePath(pathname: string = window.location.pathname): AppPath {
  /* 去掉尾斜杠，`/console/` 与 `/console` 等价；根路径归一成 `'/'`。 */
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/console' || p.startsWith('/console/') ? 'console' : 'landing';
}

/**
 * 旧书签兼容：`/#/overview` → `/console#/overview`（§2 表格第三行）。
 *
 * 两种进入方式都要接住，否则 AC-03 只在「冷启动」时成立：
 *   ① **冷启动**（书签 / 直接粘贴地址）→ 文档还没渲染，用 `replaceState` 就地
 *      改 URL 并保留 hash，App 一上来就判定为控制台，不会先闪一下官网。
 *      用 replace 而非 push —— 旧地址不该留在历史里，否则返回又回到会自动跳转的地址。
 *   ② **同文档改 hash**（已经停在 `/` 的人手动把地址改成 `#/overview`）
 *      → 只有 hash 变、文档不重载，`replaceState` 不会让 React 重跑分流；
 *      这里必须走一次**真实跳转**（`location.replace`）才能把控制台挂起来。
 */
export function redirectLegacyHash(hard = false): void {
  const { pathname, hash } = window.location;
  if (resolvePath(pathname) === 'console') return;
  /* 只接管控制台式 hash（`#/x`）；官网锚点（`#ways`）原样放行。 */
  if (!hash.startsWith('#/')) return;
  const target = `/console${hash}`;
  if (hard) window.location.replace(target);
  else window.history.replaceState(null, '', target);
}

/** 同文档 hash 变化的兜底（②）。只注册一次。 */
export function watchLegacyHash(): void {
  window.addEventListener('hashchange', () => redirectLegacyHash(true));
}
// @zbiti-ai:f:46:937605cb
