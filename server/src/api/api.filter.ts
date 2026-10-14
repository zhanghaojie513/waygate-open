/**
 * `/api/*` 的统一错误信封转换（api-contract §0.1 / §5.2）。
 *
 * ## 为什么是「按 HTTP 宿主判断」而不是「全局兜底后 rethrow」
 * 第一版实现把本过滤器注册为全局（`app.useGlobalFilters`），并在非 `/api` 路径上
 * `throw` 回原异常，想把处理权交还 Nest 默认过滤器。**这是错的**：
 * 异常一旦进入过滤器，就已经脱离了 Nest 的默认处理链，再次抛出只会被
 * Fastify 适配层接住并序列化成通用的 `{"statusCode":401,"message":"Unauthorized"}` ——
 * 于是 `ClientKeyGuard` 精心构造的 OpenAI 形状错误体（`error.code = invalid_api_key`）
 * 被替换成了无信息的默认文案。这个回归是冒烟脚本实测抓出来的（§2 用例）。
 *
 * 正确做法：过滤器**只处理 `/api/*`**，其余路径在 `catch` 里直接用原始 response
 * 把状态与已序列化的 body 写回去（见 `passthrough`），**不抛异常**。
 *
 * ⚠️ `ClientKeyGuard` 抛的 `UnauthorizedException` 携带的是 OpenAI 错误体，
 *    必须原样透传，绝不能套 `/api/*` 的信封（契约 §0.1 明令禁止混用两套形状）。
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { fail, newTraceId, RelayHttpError, toOpenAIErrorBody, ApiCode } from '../common/errors';

/** http 状态 → 契约数字码（契约 §5.2 表格）。 */
function apiCodeForStatus(status: number): number {
  switch (status) {
    case 400:
      return ApiCode.BAD_PARAM;
    case 401:
      return ApiCode.NO_SESSION;
    case 403:
      return ApiCode.FORBIDDEN;
    case 404:
      return ApiCode.NOT_FOUND;
    case 409:
      return ApiCode.CONFLICT;
    case 429:
      return ApiCode.RATE_LIMITED;
    case 503:
      return ApiCode.DB_UNAVAILABLE;
    default:
      return status >= 500 ? ApiCode.INTERNAL : ApiCode.BAD_PARAM;
  }
}

interface NormalizedError {
  status: number;
  apiCode: number;
  message: string;
  data: unknown;
  headers?: Record<string, string>;
  /** 非 /api 路径要原样回吐的 body（OpenAI 形状等）。 */
  rawBody?: unknown;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<{ url?: string; method?: string }>();

    const isApi = (request.url ?? '').startsWith('/api');
    const info = this.classify(exception, isApi);

    if (info.status >= 500) {
      this.logger.error(
        `${request.method ?? '?'} ${request.url ?? '?'} → ${info.status}/${info.apiCode}: ${info.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    if (info.headers) {
      for (const [k, v] of Object.entries(info.headers)) reply.header(k, v);
    }

    // 非 /api（`/v1/*`、`/healthz`）：原样回吐
    if (!isApi) {
      void reply.status(info.status).send(info.rawBody ?? { message: info.message });
      return;
    }

    // /api/*：统一信封
    void reply.status(info.status).send(fail(info.apiCode, info.message, info.data));
  }

  private classify(exception: unknown, isApi: boolean): NormalizedError {
    if (exception instanceof RelayHttpError) {
      return {
        status: exception.httpStatus,
        apiCode: exception.apiCode,
        message: exception.message,
        data: exception.data ?? null,
        headers: exception.headers,
        rawBody: toOpenAIErrorBody(exception),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : typeof (body as { message?: unknown })?.message === 'string'
            ? (body as { message: string }).message
            : exception.message;

      return {
        status,
        // 非 /api 时 apiCode 用不到，但仍给个合理值便于日志
        apiCode: apiCodeForStatus(status),
        message,
        data: null,
        // `ClientKeyGuard` 把 OpenAI 形状塞进了 response，这里原样带出去
        rawBody: body,
      };
    }

    const traceId = newTraceId();
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      apiCode: ApiCode.INTERNAL,
      message: isApi
        ? `服务端未分类异常，请把 traceId 提供给维护者以便定位。traceId=${traceId}`
        : 'Internal server error',
      data: isApi ? { traceId } : null,
      rawBody: { message: 'Internal server error' },
    };
  }
}
