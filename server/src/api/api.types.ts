/**
 * `/api/*` 层的共享类型。
 *
 * 与 `/v1/*` 分开是有意的：两套端点的鉴权来源、响应形状、错误形状都不同
 * （契约 §0.1：`/api/*` 用统一信封，`/v1/*` 用 OpenAI 形状，绝不混）。
 */

import type { AdminContext } from './auth/session.guard';

/** Fastify 请求在本层用到的最小形状。 */
export interface BaseRequest {
  method: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/** 经过 SessionGuard 之后的最小请求形状。 */
export interface ApiRequest extends BaseRequest {
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  admin?: AdminContext;
}

/** SessionGuard 在挂上 admin 之前看到的请求形状（可选字段）。 */
export type RelayRequest = ApiRequest;

/** 统一信封。`ok()` / `fail()` 在 common/errors.ts，这里只给形状。 */
export interface ApiEnvelope<T> {
  code: number;
  data: T | null;
  message: string;
}

/** 取查询串里的单个值（Fastify 可能把重复参数给成数组）。 */
export function queryString(
  query: Record<string, string | string[] | undefined> | undefined,
  key: string,
): string | undefined {
  const v = query?.[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** 取查询串里的整数，非法时回退默认值。 */
export function queryInt(
  query: Record<string, string | string[] | undefined> | undefined,
  key: string,
  fallback: number,
): number {
  const raw = queryString(query, key);
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
