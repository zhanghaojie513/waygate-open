/**
 * /api/* 统一信封的取数层。
 * 契约：design/api-contract.md §0.1 —— {code, data, message}，code=0 为成功。
 * 只做三件事：发请求、拆信封、把失败翻译成可渲染的错误对象。
 */

import type { ApiEnvelope } from '../types/api';

export class ApiError extends Error {
  /** /api/* 业务码（40101 / 40102 / 40290 …）；网络失败时为 0 */
  readonly code: number;
  /** HTTP 状态码；网络失败时为 0 */
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: number, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** 会话缺失或过期 —— 前端据此回登录页 */
  get isSessionExpired(): boolean {
    return this.code === 40102;
  }
}

type UnauthorizedHandler = (err: ApiError) => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

function notifyUnauthorized(err: ApiError): void {
  unauthorizedHandlers.forEach((h) => h(err));
}

export const MOCKS_ENABLED = import.meta.env.VITE_ENABLE_MOCKS === '1';

async function parseEnvelope<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: ApiEnvelope<T> | null = null;
  try {
    body = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
  } catch {
    throw new ApiError(`服务端返回了非 JSON 响应（HTTP ${res.status}）`, 0, res.status);
  }
  if (!body || typeof body.code !== 'number') {
    throw new ApiError(`响应缺少统一信封（HTTP ${res.status}）`, 0, res.status);
  }
  if (body.code === 0) return body.data;

  const retry = (body.data as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
  throw new ApiError(body.message || `请求失败（code ${body.code}）`, body.code, res.status, retry);
}

/**
 * 读请求（GET）默认超时。后端卡住时页面不能永远停在骨架屏。
 * 只对 GET 生效：写操作 / 上游探测（refreshCatalog、testProvider）超时了服务端仍在执行，
 * 前端提前放弃只会让界面与真实状态不一致，所以它们不设默认超时。
 */
const READ_TIMEOUT_MS = 20_000;

/** 把调用方的 signal 与超时合成一个 signal（手动转发，不依赖 AbortSignal.any 的浏览器支持度） */
function withTimeout(outer: AbortSignal | null | undefined, ms: number | null) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms === null ? undefined : setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  return {
    signal: ctrl.signal,
    isTimedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** 判断是不是主动取消（组件卸载 / 参数变化）—— 这类错误调用方应静默丢弃 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** 发一次 /api/* 请求并拆信封。失败一律抛 ApiError，调用方决定怎么渲染；主动取消原样抛 AbortError。 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const guard = withTimeout(init?.signal, method === 'GET' ? READ_TIMEOUT_MS : null);
  /* ★ 头必须用 `Headers` 合并：它按**大小写不敏感**去重。
     此前用普通对象字面量展开 —— 调用方写 `'content-type'`（小写）而这里默认给
     `'Content-Type'`，两个键在 JS 里不相等 → 都被保留 → `fetch` 归一化后
     **拼接**成 `application/json, application/json` → Fastify 无法解析该媒体类型，
     在**进入路由前**就抛 415（前端只看到 `40001 Unsupported Media Type`，
     且 SessionGuard 都来不及跑 —— 所以是 415 而不是 403）。
     实测复现：`-H "content-type: application/json, application/json"` → 415。 */
  const headers = new Headers(init?.headers);
  if (!headers.has('accept')) headers.set('Accept', 'application/json');
  if (init?.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: guard.signal,
      credentials: 'same-origin',
      headers,
    });
  } catch (err) {
    guard.dispose();
    if (guard.isTimedOut()) {
      throw new ApiError(`请求超时（${READ_TIMEOUT_MS / 1000}s 无响应），稍后重试。`, 0, 0);
    }
    if (isAbortError(err)) throw err; // 主动取消：不翻译成"连不上"
    throw new ApiError('连不上本机服务。确认后端已在 127.0.0.1:8787 启动。', 0, 0);
  }

  try {
    const data = await parseEnvelope<T>(res);
    if (!res.ok) {
      // 信封里 code 非 0 时 parseEnvelope 已抛；这里兜住 code=0 但 HTTP 非 2xx 的异常情况
      throw new ApiError(`请求失败（HTTP ${res.status}）`, 0, res.status);
    }
    return data;
  } catch (err) {
    if (guard.isTimedOut()) {
      throw new ApiError(`请求超时（${READ_TIMEOUT_MS / 1000}s 无响应），稍后重试。`, 0, 0);
    }
    throw err;
  } finally {
    guard.dispose(); // 响应体读完才清计时器：body 传输卡住同样算超时
  }
}

/** 会话过期由这里统一广播，页面不需要各自判断 40102 */
export async function apiRequestGuarded<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiRequest<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.isSessionExpired) notifyUnauthorized(err);
    throw err;
  }
}

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    usp.set(k, String(v));
  });
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}
