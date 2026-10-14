import { useEffect, useState } from 'react';

/** 防抖值：搜索框输入用它，避免每敲一个字都发一次请求。 */
export function useDebounced<T>(value: T, delay = 320): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return v;
}
