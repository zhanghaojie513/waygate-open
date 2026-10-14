/**
 * `POST /v1/messages` —— Anthropic Messages 协议的翻译层。
 *
 * ⚠️ 上游**只讲 OpenAI Chat Completions**（`/v2/messages` 实测 404）。本端点把
 * Anthropic 请求翻成 OpenAI 请求，复用既有代理管线（`ProxyService`：并发闸 / 首字超时 /
 * 上游错误映射；`ClientKeyGuard`：鉴权；`ProxyLogger`：审计落库），再把响应翻回 Anthropic 形状。
 *
 * 审计不变式（契约 §6）：凡经代理层处理并归属到某个 client 的请求，必有且仅有一行
 * `requests` 记录 —— 由复用 `beginContext` / `persist` / `persistFailure` / `persistGuard` 保证，
 * 本文件不另写落库路径。
 */

import {
  Body,
  Controller,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RelayHttpError } from '../../common/errors';
import { clientIpOf } from '../../common/client-ip';
import { beginContext } from '../proxy-log';
import { ProxyService } from '../proxy.service';
import { AnthropicExceptionFilter } from './anthropic.filter';
import { AnthropicKeyGuard } from './anthropic-key.guard';
import { pipeAnthropicSse, sendAnthropicNonStream, sendJsonError } from './respond';
import { toOpenAIChatBody } from './translate-request';
import type { RequestWithKeyContext } from '../../auth/key.guard';
import type { AnthropicRequest } from './types';

interface V1MessagesRequest extends RequestWithKeyContext {
  body?: AnthropicRequest;
}

@Controller('v1')
@UseGuards(AnthropicKeyGuard)
@UseFilters(AnthropicExceptionFilter)
export class AnthropicController {
  constructor(@Inject(ProxyService) private readonly proxy: ProxyService) {}

  @Post('messages')
  async messages(
    @Req() req: V1MessagesRequest,
    @Res() reply: FastifyReply,
    @Body() body: AnthropicRequest,
  ): Promise<void> {
    // 落库上下文在「翻译 + 调上游之前」就建好 —— 失败路径手上也有 ctx。
    const ctx = beginContext({
      keyContext: req.keyContext,
      remoteIp: clientIpOf(req), // [B6] XFF 末段提取，同 proxy.controller（此前恒 127.0.0.1）
      ua: this.header(req, 'user-agent'),
      originalStream: body?.stream === true,
    });

    try {
      const openai = toOpenAIChatBody(body);
      this.proxy.assertBodyShape(openai);

      const upstream = await this.proxy.callUpstream(ctx, req.headers, openai);
      if (!upstream.events) {
        // 失败行已由 service 落库；这里只把 Anthropic 形状的错误写回客户端
        sendJsonError(reply, upstream.failure!);
        return;
      }

      if (ctx.originalStream) {
        pipeAnthropicSse(reply, upstream.events, upstream.traceId, upstream.model);
      } else {
        await sendAnthropicNonStream(reply, upstream.events, upstream.model);
      }
    } catch (err) {
      // 本地拒绝（翻译校验 / 模型越权 / 并发闸）也必须有界面痕迹：先落一行再回响应
      const relay = this.toRelayError(err);
      this.proxy.logRejection(ctx, relay);
      sendJsonError(reply, relay);
    }
  }

  private header(req: V1MessagesRequest, name: string): string | null {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === 'string' ? value : null;
  }

  private toRelayError(err: unknown): RelayHttpError {
    if (err instanceof RelayHttpError) return err;
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return new RelayHttpError({
        httpStatus: status,
        code: 'internal_error',
        message: status === 429 ? '请求过于频繁。' : '服务端未分类异常。',
      });
    }
    return new RelayHttpError({
      httpStatus: 500,
      code: 'internal_error',
      message: '服务端未分类异常，请把 x-trace-id 提供给维护者排障。',
    });
  }
}
