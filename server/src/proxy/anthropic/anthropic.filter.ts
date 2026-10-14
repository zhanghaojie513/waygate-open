/**
 * `/v1/messages` 的错误出口过滤器。
 *
 * 必要性：`ClientKeyGuard` 抛的是**OpenAI 形状**的 `UnauthorizedException`（它是为
 * `/v1/chat/completions` 设计的）。守卫在 controller 之前执行，其异常不会进 controller
 * 的 `catch`，必须由**控制器级**过滤器接住并重写成 Anthropic 形状
 * （`{"type":"error","error":{...}}`），否则客户端会收到 OpenAI 形状的 401。
 *
 * 控制器级过滤器先于 `main.ts` 里注册的全局 `ApiExceptionFilter` 生效。
 */

import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { mapAnthropicError } from './errors';

@Catch()
export class AnthropicExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const mapped = mapAnthropicError(exception);
    if (mapped.headers) {
      for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
    }
    void reply
      .code(mapped.status)
      .header('content-type', 'application/json; charset=utf-8')
      .send(mapped.body);
  }
}
