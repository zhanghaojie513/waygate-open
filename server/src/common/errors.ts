import { randomUUID } from 'node:crypto';

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string; param: string | null };
}

export interface RelayErrorOptions {
  httpStatus: number;
  /** `/v1/*` 的 OpenAI error.code */
  code: string;
  message: string;
  /** `/api/*` 统一信封的数字 code，缺省时按 httpStatus 推导 */
  apiCode?: number;
  /** 覆盖 OpenAI error.type（默认按 httpStatus 推导） */
  type?: string;
  upstreamCode?: number | null;
  headers?: Record<string, string>;
  traceId?: string;
  /** `/api/*` 错误响应里附加的 data（如限流的 retryAfterSeconds） */
  data?: unknown;
}

export class RelayHttpError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly apiCode: number;
  readonly type: string;
  readonly upstreamCode: number | null;
  readonly headers: Record<string, string> | undefined;
  readonly traceId: string;
  readonly data: unknown;

  constructor(options: RelayErrorOptions) {
    super(options.message);
    this.name = 'RelayHttpError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.apiCode = options.apiCode ?? defaultApiCode(options.httpStatus);
    this.type = options.type ?? defaultErrorType(options.httpStatus);
    this.upstreamCode = options.upstreamCode ?? null;
    this.headers = options.headers;
    this.traceId = options.traceId ?? randomUUID();
    this.data = options.data;
  }
}

function defaultApiCode(status: number): number {
  if (status === 400) return 40001;
  if (status === 401) return 40102;
  if (status === 403) return 40302;
  if (status === 404) return 40401;
  if (status === 409) return 40901;
  if (status === 429) return 40290;
  if (status === 503) return 50301;
  return 50001;
}

function defaultErrorType(status: number): string {
  if (status === 401) return 'invalid_request_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

/** `/v1/*` 用 OpenAI 原生错误形状，禁止返回统一信封。 */
export function toOpenAIErrorBody(err: RelayHttpError): OpenAIErrorBody {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.code,
      param: null,
    },
  };
}

export interface Envelope<T> {
  code: number;
  data: T | null;
  message: string;
}

export function ok<T>(data: T): Envelope<T> {
  return { code: 0, data, message: '' };
}

export function fail(apiCode: number, message: string, data: unknown = null): Envelope<unknown> {
  return { code: apiCode, data, message };
}

export const ApiCode = {
  BAD_PARAM: 40001,
  DANGER_CONFIRM: 40002,
  BAD_PASSWORD: 40101,
  NO_SESSION: 40102,
  BAD_ORIGIN: 40301,
  FORBIDDEN: 40302,
  NOT_FOUND: 40401,
  CONFLICT: 40901,
  RATE_LIMITED: 40290,
  INTERNAL: 50001,
  DB_UNAVAILABLE: 50301,
} as const;

export function newTraceId(): string {
  return randomUUID();
}
