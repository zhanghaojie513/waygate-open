import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ClientKeyGuard, type RequestWithKeyContext } from '../auth/key.guard';
import { RelayHttpError, toOpenAIErrorBody } from '../common/errors';
import { clientIpOf } from '../common/client-ip';
import { ProxyService } from './proxy.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { beginContext } from './proxy-log';
import { arrivedAtOf, bodyReadyAtOf } from './arrival-clock';
import { VERSION } from '../version';
import type { ChatRequestBody } from './types';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

interface V1Request extends RequestWithKeyContext {
  body?: ChatRequestBody;
}

/**
 * `/v1/*` 对外端点（OpenAI 兼容）。
 *
 * 这里是唯一写原始 HTTP 响应的层：SSE 必须手动 flush，Nest 的序列化会缓冲。
 * 业务逻辑全在 ProxyService / ModelCatalogRepository，本类只做协议适配与错误形状选择。
 */
@Controller('v1')
@UseGuards(ClientKeyGuard)
export class ProxyController {
  constructor(
    private readonly proxy: ProxyService,
    @Inject(ModelCatalogRepository) private readonly catalog: ModelCatalogRepository,
    /* [v0.5.1] 多生效：/v1/models 取启用提供商目录的并集。显式注入同 harness 教训。 */
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
  ) {}

  @Post('chat/completions')
  async chatCompletions(
    @Req() req: V1Request,
    @Res() reply: FastifyReply,
    @Body() body: ChatRequestBody,
  ): Promise<void> {
    // ★ 落库上下文在「调上游之前」就建好 —— 这样失败路径手上也有 ctx（根因修复：
    //   旧实现把 ctx 建在 fetch 成功之后，失败分支无从落库）。
    const ctx = beginContext({
      keyContext: req.keyContext,
      // [2026-10-07 B6] 此前直接取 req.ip —— 本服务只监听回环，落库恒 127.0.0.1
      //   （task#79 排障被误导过，得去 nginx 日志交叉才有真实 IP）。改用 client-ip.ts
      //   的 XFF 末段提取（nginx 已覆写 XFF，末段即真实出口；论证见该文件头）。
      remoteIp: clientIpOf(req),
      ua: this.header(req, 'user-agent'),
      originalStream: (body as ChatRequestBody | undefined)?.stream === true,
    });
    /* [v1.7.2] 鉴权耗时 = 现在（controller 已进入 = guard 已通过）− 进门时刻。
       进门时刻由 main.ts 装的 onRequest 钩子写入；测试直构 controller 时没有它 →
       `arrivedAt` 为 undefined → `auth_ms` 落库 NULL（未知），不填 0 冒充。 */
    ctx.marks = { ...ctx.marks, authed: Date.now() };
    ctx.arrivedAt = arrivedAtOf(req);
    ctx.bodyReadyAt = bodyReadyAtOf(req);
    try {
      this.proxy.assertBodyShape(body);
      const upstream = await this.proxy.callUpstream(ctx, req.headers, body);

      if (!upstream.events) {
        // 失败行已由 service 落库；这里只负责把标准 JSON 错误写回客户端
        this.sendError(reply, upstream.failure!);
        return;
      }

      const events = upstream.events;
      if (ctx.originalStream) {
        this.pipeSse(reply, events, upstream.traceId);
      } else {
        await this.aggregateNonStream(reply, events);
      }
    } catch (err) {
      // 本地拒绝（body 形状不合法 / 模型越权 / 并发闸）也必须有界面痕迹：先落一行再回响应
      const relay = this.toRelayError(err);
      this.proxy.logRejection(ctx, relay);
      this.sendError(reply, relay);
    }
  }

  /** 流式透传：拿到第一个事件才写头，避免上游失败时已发出 200。 */
  private pipeSse(
    reply: FastifyReply,
    events: AsyncGenerator<import('./proxy.service').StreamEvent>,
    traceId: string,
  ): void {
    let started = false;
    reply.raw.on('close', () => {
      void events.return(undefined);
    });
    void (async () => {
      try {
        for await (const ev of events) {
          // 心跳：已写头后才发 SSE 注释保活；写头前不因心跳提前提交 200（与「拿到首个事件才写头」一致）
          if (ev.type === 'ping') {
            if (started) reply.raw.write(': ping\n\n');
            continue;
          }
          if (!started) {
            started = true;
            reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-trace-id': traceId });
          }
          if (ev.type === 'chunk') reply.raw.write(`data: ${ev.data}\n\n`);
          else if (ev.type === 'done') reply.raw.write('data: [DONE]\n\n');
          else if (ev.type === 'error') {
            reply.raw.write(`data: ${JSON.stringify(toOpenAIErrorBody(ev.error))}\n\n`);
            reply.raw.write('data: [DONE]\n\n');
          }
        }
      } finally {
        if (!started) {
          // 一个 chunk 都没有：此时还未写头，按失败返回标准 JSON 错误
          reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          reply.raw.end(
            JSON.stringify(
              toOpenAIErrorBody(
                new RelayHttpError({
                  httpStatus: 502,
                  code: 'upstream_error',
                  message: '上游未返回任何数据即结束。',
                }),
              ),
            ),
          );
        } else {
          reply.raw.end();
        }
      }
    })();
  }

  /** 非流式：内部照样走上游流式，聚合完成后一次性返回单个 chat.completion。 */
  private async aggregateNonStream(
    reply: FastifyReply,
    events: AsyncGenerator<import('./proxy.service').StreamEvent>,
  ): Promise<void> {
    const acc = (await import('./accumulate')).createAccumulator();
    const { accumulate: fold, finalize } = await import('./accumulate');
    let failed = false;
    let completed = false;

    for await (const ev of events) {
      if (ev.type === 'chunk') {
        try {
          fold(acc, ev.parsed ?? JSON.parse(ev.data));
        } catch {
          /* 坏帧跳过 */
        }
      } else if (ev.type === 'done') {
        completed = true;
      } else if (ev.type === 'error') {
        failed = true;
      }
    }

    // ★ 中途断开或上游报错 → 整体失败，绝不返回半截 completion
    if (failed || !completed) {
      reply
        .code(502)
        .header('content-type', 'application/json; charset=utf-8')
        .send(
          toOpenAIErrorBody(
            new RelayHttpError({
              httpStatus: 502,
              code: 'upstream_error',
              message: '上游流未正常完成，本次请求按失败处理（不返回半截结果）。',
            }),
          ),
        );
      return;
    }

    const fin = finalize(acc, true);
    const usage = fin.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const message: Record<string, unknown> = { role: fin.message.role, content: fin.message.content };
    if (fin.message.tool_calls) message.tool_calls = fin.message.tool_calls;
    if (!fin.message.content) message.content = '';

    reply
      .code(200)
      .header('content-type', 'application/json; charset=utf-8')
      .send({
        id: fin.id,
        object: 'chat.completion',
        created: fin.created,
        model: fin.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: fin.finishReason }],
        usage,
      });
  }

  @Get('models')
  listModels(): { object: 'list'; data: Array<Record<string, unknown>> } {
    const created = Math.floor(Date.now() / 1000);
    /* [v0.5.1] 多生效：启用提供商目录的并集，按 id 去重（客户端工具要唯一 id）。 */
    const seen = new Set<string>();
    const data = this.catalog
      .allAcross((this.providers?.listActive() ?? []).map((p) => p.id))
      .filter((m) => m.enabled === 1 && !seen.has(m.id) && seen.add(m.id))
      .map((m) => ({
        id: m.id,
        object: 'model',
        created,
        owned_by: 'relay',
        display_name: m.display_name,
        family: m.family,
        tag: m.tag,
        multiplier: m.multiplier,
        source: m.source,
        verified: m.verified,
      }));
    return { object: 'list', data };
  }

  private header(req: V1Request, name: string): string | null {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0] ?? null;
    return typeof v === 'string' ? v : null;
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

  private sendError(reply: FastifyReply, err: RelayHttpError): void {
    if (err.headers) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
    }
    reply
      .code(err.httpStatus)
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-trace-id', err.traceId)
      .send(toOpenAIErrorBody(err));
  }
}

/** 不鉴权、不碰数据库。 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  @Get('healthz')
  health(): { ok: true; version: string; uptime: number } {
    return {
      ok: true,
      // [v0.2.0] systemd 环境没有 npm_package_version —— 回落值改为代码侧单源 VERSION
      // （与 package.json 由 copy-assets 构建期校验一致，见 src/version.ts）。
      version: process.env.npm_package_version ?? VERSION,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}
