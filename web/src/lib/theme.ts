/**
 * 主题（明暗）—— 纯逻辑，不依赖 React。
 *
 * 为什么单独一个模块而不是塞进 hook：**首帧脚本要用它**。
 * index.html 里有一段内联脚本，在样式表解析前就把 `data-theme` 写到 <html> 上，
 * 否则会先画一帧默认色再跳到目标色 —— 用户看到的是「闪一下」。
 * 内联脚本不能 import，所以它复刻这里的判定，而这里的函数保证
 * 应用运行时与那段脚本**判定一致**（改一处必须改两处，见 index.html 注释）。
 *
 * ── 偏好是**三态**，不是两态 ─────────────────────────────────────────────
 *   偏好（用户选的）  : 'system' | 'light' | 'dark'   —— 存 localStorage
 *   生效（实际渲染的）: 'dark'   | 'light'            —— 写到 <html>
 *
 * 为什么必须有 'system'：默认要「跟随系统」。两态模型做不到这件事 ——
 * 一旦用户点过开关，偏好就被钉死成一个具体值，系统在日落时切到深色，页面不会跟。
 * 'system' 是**默认值**，也是用户随时可以退回来的状态。
 *
 * ── [v0.4.22] 官网也跟随主题 ────────────────────────────────────────────
 * 此前官网恒深色（品牌门面 = 深色折面棱镜，浅色要重新设计）。
 * 现在官网与控制台**同一套判定**：偏好 'system' 时两边都跟随系统，用户显式选了
 * light/dark 则两边都跟随该选择。
 *
 * 官网浅色不是"把深色取反"——棱镜场景在浅底上的处理见 landing 侧样式
 * （theme.css 里 `.relay-landing` 的浅色块）。原先的两层保险（这里按路径返回 dark +
 * theme.css 的 `:not(.relay-landing)`）都已撤除。
 */
export type Theme = 'dark' | 'light';
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'relay.theme';

/** 默认偏好 = 跟随系统。见文件头「偏好是三态」的说明。 */
export const DEFAULT_PREFERENCE: ThemePreference = 'system';

/** 系统当前偏好的极性。`matchMedia` 不存在时（老环境）保守取深色 —— 深色是
 *  官网的基线，也是控制台在「读不到系统偏好」时最不容易出错的选择。 */
export function systemTheme(): Theme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 当前路径是不是控制台。与控制台路由（router.ts 的 resolvePath）同判据，
 *  另加旧书签形式 `#/x`（冷启动会被 redirectLegacyHash 改写成 /console#/x）。 */
export function isConsolePath(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/console' || p.startsWith('/console/') || hash.startsWith('#/');
}

/** 用户偏好 + 系统极性 → **实际生效**的主题（v0.4.22：官网与控制台同判据）。 */
export function resolveTheme(
  pref: ThemePreference,
  _pathname: string = window.location.pathname,
  _hash: string = window.location.hash,
): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

/** 读用户偏好。`localStorage` 可能被禁用 / 抛异常（隐私模式），一律兜底默认值。 */
export function readStoredPreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** 把主题写到 <html>：CSS 与首帧脚本都只看这一个属性。 */
export function applyThemeAttr(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/* -------------------------------------------------------------------------
   极小的外部 store：让「同一份偏好」在多个订阅点之间同步。
   订阅式写法比 useState 更稳 —— 将来若侧栏再多一个入口，两处不会各持一份
   互不同步的 state。

   [注意] 快照必须是 `{ preference, theme }` **两个值一起**，不能只暴露 theme。
   快照决定 React 是否重渲染（`Object.is` 比较），只放 theme 会漏掉一种真实情况：
   用户从「浅色」点回「跟随系统」，而此时系统本来就是浅色 ——
   生效主题仍是 'light'，快照没变，React 直接跳过重渲染，
   于是分段控件的**选中态停在上一个选项**，显示与实际偏好不符。
   把 preference 一起放进快照，这种"偏好变了但极性没变"的切换才会正确刷新。
   ------------------------------------------------------------------------- */
export interface ThemeSnapshot {
  /** 实际生效的极性（官网恒 'dark'）。 */
  theme: Theme;
  /** 用户选的那一项（'system' | 'light' | 'dark'）。 */
  preference: ThemePreference;
}

let snapshot: ThemeSnapshot | null = null;
const listeners = new Set<() => void>();

/** 当前快照（惰性初始化：首次读取时对齐 <html> 上的既有值）。 */
export function getSnapshot(): ThemeSnapshot {
  if (snapshot === null) {
    const attr = document.documentElement.dataset.theme;
    const pref = readStoredPreference();
    snapshot = {
      theme: attr === 'light' || attr === 'dark' ? attr : resolveTheme(pref),
      preference: pref,
    };
  }
  return snapshot;
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 用户改偏好：写偏好 + 立即重算生效值 + 通知订阅者。 */
export function setThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* 存不下就算了 —— 本次会话仍然生效，只是下次打开回到默认。 */
  }
  syncTheme();
}

/** 按当前路径与偏好重算生效主题（路由变化后调用）。
    快照对象**每次新建**（不是原地改字段）—— useSyncExternalStore 靠引用比较，
    原地改会让它读到同一个引用而不重渲染。 */
export function syncTheme(): void {
  const pref = readStoredPreference();
  const theme = resolveTheme(pref);
  applyThemeAttr(theme);
  snapshot = { theme, preference: pref };
  listeners.forEach((fn) => fn());
}

/* -------------------------------------------------------------------------
   跟随系统的两种「外部变化」监听。
   ------------------------------------------------------------------------- */

if (typeof window !== 'undefined') {
  /* ① 系统极性变化（用户在系统设置里切了深/浅，或系统按日落自动切）。
        只在偏好是 'system' 时才有影响 —— syncTheme 内部会重新判定，
        所以这里无需先读偏好，直接同步即可（非 system 时结果不变）。 */
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (readStoredPreference() === 'system') syncTheme();
  });

  /* ② 跨标签页：`storage` 事件只在**其它**标签页改动时触发（本页改动不会收到，
        符合预期）。控制台常开两个标签很常见，不接这一条就会出现
        "一个标签切了浅色、另一个还是深色"。 */
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEY) syncTheme();
  });
}
