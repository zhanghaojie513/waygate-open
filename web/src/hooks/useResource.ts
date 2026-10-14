import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../services/http';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** 首次加载完成前为 true，用于区分「骨架」与「刷新中」 */
  initial: boolean;
  reload: () => void;
}

export interface ResourceOptions {
  /**
   * 为 false 时不发请求，并把状态复位成「未加载」（data/error 清空、initial 回到 true）。
   * 用于依赖尚未就绪的场景（如详情抽屉未打开时 id 为 null）——
   * 否则会发出 `/api/requests/null` 这类注定失败的请求，还会让下次打开先闪一下旧数据/旧错误。
   */
  enabled?: boolean;
  /**
   * 跨页缓存键（stale-while-revalidate）。**必须包含所有影响结果的参数**，如 `overview:24h`。
   *
   * 给了键：挂载时先用上次成功的结果直接渲染（不出骨架），同时照常后台重拉、到达后替换；
   * 同一键的并发请求（多个组件同时挂载、StrictMode 双发）合并成一次网络请求。
   * 不给键：行为与原先完全一致。只缓存成功结果，错误不缓存。
   */
  cacheKey?: string;
}

/* 模块级缓存：跨组件、跨页面共享，生命周期 = 本次页面会话。 */
const resultCache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

/** 会话失效 / 重新登录时调用：丢弃上一会话的全部缓存数据。 */
export function clearResourceCache(): void {
  resultCache.clear();
  inflight.clear();
}

/** 写穿（write-through）：写操作成功后立刻修正缓存里同键的旧值。
 *
 * 「自己的操作在别的页先闪一下旧状态」的最后一类口子（如在请求页开了取证、
 * 走到设置页先看到「关」）来自这里：挂载时先渲染缓存，缓存还停留在写之前。
 * 写穿让缓存与刚写成功的服务端状态对齐，目标页挂载第一帧就是新值。
 *
 * 边界刻意收窄：
 *   · 只在键**已存在**时更新 —— 没缓存=本会话还没看过该页，下次挂载走网络拿
 *     新值，不存在旧值可闪；凭一次写操作的局部数据凭空造整份缓存反而危险。
 *   · 只改缓存、不通知已挂载组件 —— 本应用一次只挂一个页面，跨页场景的目标页
 *     必然未挂载，挂载时自然读到修正后的值。
 */
export function patchResourceCache<T>(key: string, patch: (cached: T) => T): void {
  if (!resultCache.has(key)) return;
  resultCache.set(key, patch(resultCache.get(key) as T));
}

/**
 * 同键请求合并：已有在途请求则复用，结束后（无论成败）移除，成功结果写入缓存。
 * `force`：不复用在途请求（reload 场景 —— 写操作之后的刷新必须拿到写之后的数据，
 * 而在途的那个请求可能是写之前发出的）。
 */
function loadShared<T>(key: string, loader: () => Promise<T>, force: boolean): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending && !force) return pending;
  const p = loader().then(
    (result) => {
      // 会话被清空后才返回的旧请求不回写（inflight 里已不是它）
      if (inflight.get(key) === p) resultCache.set(key, result);
      return result;
    },
  );
  inflight.set(key, p);
  // finally 只做清理；rejection 由调用方处理，这里吞掉派生 Promise 的拒绝避免未处理告警
  p.finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  }).catch(() => {});
  return p;
}

/**
 * 拉一份数据，带 loading / error / 竞态保护；可选跨页缓存（见 ResourceOptions.cacheKey）。
 * loader 用 useCallback 包裹或放进 deps，避免每次渲染都重拉。
 */
export function useResource<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: ResourceOptions = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const cacheKey = options.cacheKey;
  const cachedAtMount = enabled && cacheKey !== undefined && resultCache.has(cacheKey);
  const [data, setData] = useState<T | null>(() => (cachedAtMount ? (resultCache.get(cacheKey as string) as T) : null));
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  // 命中缓存时直接是「已加载」态：页面不出骨架，后台刷新只体现为 loading
  const [initial, setInitial] = useState(!cachedAtMount);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;

  const run = useCallback((force: boolean) => {
    const id = ++seq.current;
    const key = keyRef.current;
    setLoading(true);
    const promise = key !== undefined ? loadShared(key, () => loaderRef.current(), force) : loaderRef.current();
    promise.then(
      (result) => {
        if (id !== seq.current) return; // 丢弃过期响应，避免旧数据盖新数据
        setData(result);
        setError(null);
        setLoading(false);
        setInitial(false);
      },
      (err: unknown) => {
        if (id !== seq.current || isAbortError(err)) return; // 过期或主动取消：静默丢弃
        setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
        setLoading(false);
        setInitial(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      // 禁用：作废在途请求并复位，下次启用时重新走骨架/加载态
      seq.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      setInitial(true);
      return;
    }
    // 参数变化（如切换时间窗）且新键有缓存：先换成缓存结果，避免旧窗口的数据挂着等新请求
    if (cacheKey !== undefined && resultCache.has(cacheKey)) {
      setData(resultCache.get(cacheKey) as T);
      setError(null);
      setInitial(false);
    }
    run(false);
  }, [enabled, cacheKey, ...deps]);

  // reload 强制重拉（不复用在途请求），供写操作后刷新
  const reload = useCallback(() => run(true), [run]);

  return { data, error, loading, initial, reload };
}
