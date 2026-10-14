/**
 * 错误 → Anthropic 错误形状。
 *
 * Anthropic 的错误体与 OpenAI **不同**：
 *   Anthropic：`{"type":"error","error":{"type":"…","message":"…"}}`
 *   OpenAI   ：`{"error":{"message":"…","type":"…","code":"…"}}`
 * 因此 `/v1/messages` 的所有错误出口（含 `ClientKeyGuard` 抛出的 401）都必须重写成 Anthropic 形状。
 */

import { HttpException } from '@nestjs/common';
import { newTraceId, RelayHttpError } from '../../common/errors';
import type { AnthropicErrorBody } from './types';

export interface AnthropicErrorResult {
  status: number;
  headers?: Record<string, string>;
  body: AnthropicErrorBody;
}

/** HTTP 状态 → Anthropic `error.type`。 */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

function extractHttpMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const obj = body as { error?: { message?: unknown }; message?: unknown };
    if (obj.error && typeof obj.error.message === 'string') return obj.error.message;
    if (typeof obj.message === 'string') return obj.message;
  }
  return fallback;
}

/** 把任意异常翻译成 Anthropic 错误响应。 */
export function mapAnthropicError(err: unknown): AnthropicErrorResult {
  if (err instanceof RelayHttpError) {
    return {
      status: err.httpStatus,
      headers: err.headers,
      body: { type: 'error', error: { type: anthropicErrorType(err.httpStatus), message: err.message } },
    };
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    return {
      status,
      body: {
        type: 'error',
        error: { type: anthropicErrorType(status), message: extractHttpMessage(err.getResponse(), err.message) },
      },
    };
  }

  return {
    status: 500,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message: `服务端未分类异常，请把 x-trace-id 提供给维护者排障。traceId=${newTraceId()}`,
      },
    },
  };
}
