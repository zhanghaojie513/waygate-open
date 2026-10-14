import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { ApiError, onUnauthorized } from '../services/http';
import { clearResourceCache } from './useResource';

export type SessionStatus = 'loading' | 'anon' | 'authed';

export interface Session {
  status: SessionStatus;
  expiresAt: string | null;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * 首屏调 GET /api/auth/session；authenticated:false 不报错、不闪红，只是进登录页。
 * 任何接口返回 40102 都会把会话打回 anon。
 */
export function useSession(): Session {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .session()
      .then((s) => {
        if (!alive) return;
        setStatus(s.authenticated ? 'authed' : 'anon');
        setExpiresAt(s.expiresAt);
      })
      .catch(() => {
        if (!alive) return;
        setStatus('anon');
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 退出流程标志：logout 让 session 失效后，页面上其余在途/轮询请求会成批 401 回来。
     若不拦，这些 401 会先把页面切到登录页、随后 assign('/') 才整页跳官网 ——
     用户看到「先登录页再官网」的闪现。退出中的 401 直接忽略（整页跳转自会清一切）。 */
  const loggingOutRef = useRef(false);

  /* 会话失效：除了回到登录态，还要丢弃跨页缓存，避免重新登录后先看到上一会话的数据 */
  useEffect(
    () =>
      onUnauthorized(() => {
        if (loggingOutRef.current) return;
        clearResourceCache();
        setStatus('anon');
      }),
    [],
  );

  const login = useCallback(async (password: string) => {
    const res = await api.login(password);
    clearResourceCache();
    setStatus('authed');
    setExpiresAt(res.expiresAt);
  }, []);

  const logout = useCallback(async () => {
    loggingOutRef.current = true;
    try {
      await api.logout();
    } catch (err) {
      if (!(err instanceof ApiError)) {
        loggingOutRef.current = false; // 没能退出：状态机照常工作
        throw err;
      }
      /* ApiError（如网络断）也继续跳转 —— 客户端 session cookie 随整页跳转丢弃 */
    }
    setStatus('anon');
    setExpiresAt(null);
    /* 退出后回**官网**（`/`），而不是停在控制台的登录页。
       用整页跳转（assign）而非 hash 路由：这会丢弃整棵控制台的 React 状态与
       内存缓存，保证下一个访客不会从上一个会话里捡到任何残留。 */
    window.location.assign('/');
  }, []);

  return { status, expiresAt, login, logout };
}
// @zbiti-ai:f:63:be7ec259
