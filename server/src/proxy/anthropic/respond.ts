/**
 * `/v1/messages` 的响应出口（唯一写原始 HTTP 的层）。
 *
 * SSE 必须手动 flush（Nest 序列化会缓冲），所以这里直接操作 `reply.raw`。
 * 与 OpenAI 侧 `proxy.controller.ts` 的分工一致：翻译/编码在别处，本文件只负责
 * 「把事件序列写成 Anthropic SSE 帧」与「把错误写成 Anthropic JSON」。
 */

import type { FastifyReply } from 'fastify';
import { ApiCode, RelayHttpError } from '../../common/errors';
import { accumulate, createAccumulator, finalize } from '../accumulate';
import type { StreamEvent } from '../proxy.service';
import type { ChatChunk } from '../types';
import { mapAnthropicError } from './errors';
import { AnthropicStreamEncoder, sseFrame } from './stream-events';
import { newMessageId, toAnthropicMessage } from './translate-response';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/** 一次性写回 Anthropic 形状的错误 JSON（含 x-trace-id）。 */
export function sendJsonError(reply: FastifyReply, err: RelayHttpError): void {
  const mapped = mapAnthropicError(err);
  if (mapped.headers) {
    for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
  }
  void reply
    .code(mapped.status)
    .header('content-type', 'application/json; charset=utf-8')
    .header('x-trace-id', err.traceId)
    .send(mapped.body);
}

/** 非流式：上游照样走 SSE，聚合完成后一次性返回单个 Anthropic `message`。 */
export async function sendAnthropicNonStream(
  reply: FastifyReply,
  events: AsyncGenerator<StreamEvent>,
  model: string,
): Promise<void> {
  const acc = createAccumulator();
  let failed = false;
  let completed = false;

  for await (const ev of events) {
    if (ev.type === 'chunk') {
      try {
        accumulate(acc, ev.parsed ?? (JSON.parse(ev.data) as ChatChunk));
      } catch {
        /* 坏帧跳过 */
      }
    } else if (ev.type === 'done') {
      completed = true;
    } else if (ev.type === 'error') {
      failed = true;
    }
  }

  // ★ 中途断开或上游报错 → 整体失败，绝不返回半截 message（与 OpenAI 侧同口径）
  if (failed || !completed) {
    sendJsonError(
      reply,
      new RelayHttpError({
        httpStatus: 502,
        code: 'upstream_error',
        apiCode: ApiCode.INTERNAL,
        message: '上游流未正常完成，本次请求按失败处理（不返回半截结果）。',
      }),
    );
    return;
  }

  const fin = finalize(acc, true);
  const body = toAnthropicMessage({
    id: newMessageId(),
    model,
    message: fin.message,
    finishReason: fin.finishReason,
    usage: fin.usage,
  });
  void reply.code(200).header('content-type', 'application/json; charset=utf-8').send(body);
}

/**
 * 流式：把上游 `StreamEvent` 逐块翻成 Anthropic SSE 事件并 flush。
 *
 * `message_start` 在**第一个事件**到达时才发（避免上游一上来就失败时已写 200）。
 * 客户端断开时 `events.return()` 会提前终止上游生成器，其 `finally` 仍会落审计行。
 */
export function pipeAnthropicSse(
  reply: FastifyReply,
  events: AsyncGenerator<StreamEvent>,
  traceId: string,
  model: string,
): void {
  const encoder = new AnthropicStreamEncoder(newMessageId(), model);
  let started = false; // 是否已 writeHead(200)
  let messageStarted = false; // 是否已发 message_start
  let responded = false; // 是否已用 reply.*.send() 发完整个响应（错误 JSON）

  const writeHead = (): void => {
    if (started) return;
    started = true;
    reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-trace-id': traceId });
  };
  const write = (frame: string): void => {
    writeHead();
    reply.raw.write(frame);
  };
  const ensureMessageStart = (): void => {
    writeHead();
    if (!messageStarted) {
      messageStarted = true;
      reply.raw.write(encoder.start());
    }
  };

  reply.raw.on('close', () => {
    void events.return(undefined);
  });

  void (async () => {
    try {
      for await (const ev of events) {
        if (ev.type === 'ping') {
          write(': ping\n\n');
          continue;
        }
        if (ev.type === 'chunk') {
          ensureMessageStart();
          let chunk: ChatChunk | null = null;
          try {
            chunk = ev.parsed ?? (JSON.parse(ev.data) as ChatChunk);
          } catch {
            chunk = null;
          }
          if (chunk) write(encoder.push(chunk));
          continue;
        }
        if (ev.type === 'done') {
          ensureMessageStart();
          write(encoder.finish());
          continue;
        }
        // ev.type === 'error'
        if (!started) {
          // 一个字节都还没写：按标准 HTTP 错误返回（Anthropic 形状）
          responded = true;
          sendJsonError(reply, ev.error);
        } else {
          write(sseFrame('error', mapAnthropicError(ev.error).body));
        }
      }
    } finally {
      if (!started && !responded) {
        sendJsonError(
          reply,
          new RelayHttpError({
            httpStatus: 502,
            code: 'upstream_error',
            apiCode: ApiCode.INTERNAL,
            message: '上游未返回任何数据即结束。',
          }),
        );
      } else if (started) {
        reply.raw.end();
      }
    }
  })();
}
