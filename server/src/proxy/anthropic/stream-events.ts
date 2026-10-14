/**
 * OpenAI SSE chunk → Anthropic SSE 事件编码器（**流式** `POST /v1/messages`）。
 *
 * Anthropic 流**带 `event:` 行**，且顺序固定：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)+
 *   → message_delta → message_stop
 *
 * 本类把上游每个 OpenAI `chat.completion.chunk` 折叠成上述事件序列；工具调用走
 * `content_block_start{type:"tool_use"}` + `content_block_delta{delta:{type:"input_json_delta",
 * partial_json}}` 分段拼 JSON（与 Anthropic 规范一致）。
 *
 * 逐块透传：`push()` 每收到一个 chunk 就返回该产出的帧，调用方立即 flush —— 不缓冲。
 */

import type { ChatChunk, ToolCallDelta, Usage } from '../types';
import { mapStopReason } from './translate-response';

/** 组装一个 Anthropic SSE 事件帧（`event:` 行 + `data:` 行 + 空行分隔）。 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface OpenBlock {
  kind: 'text' | 'tool';
  index: number;
}

export class AnthropicStreamEncoder {
  private blockIndex = 0;
  private open: OpenBlock | null = null;
  /** OpenAI 的 tool_calls[].index → 我们分配的内容块索引。 */
  private readonly toolBlocks = new Map<number, number>();
  private lastUsage: Usage | null = null;
  private finishReason: string | null = null;

  constructor(
    private readonly messageId: string,
    private readonly model: string,
  ) {}

  /** 首个事件：message_start。 */
  start(): string {
    return sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // ⚠️ input/output 此时**拿不到**（上游要流结束才有 usage）：以 0 占位并随后在
        //    message_delta 给出权威值。Anthropic 自身在 message_start 也用 output_tokens:0。
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** 折叠一个上游 chunk，返回该 chunk 产出的 SSE 帧（可能为空串）。 */
  push(chunk: ChatChunk): string {
    if (!chunk || typeof chunk !== 'object') return '';
    let out = '';
    if (chunk.usage && typeof chunk.usage === 'object') this.lastUsage = chunk.usage;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          out += this.textDelta(delta.content);
        }
        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) out += this.toolDelta(call);
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
        this.finishReason = choice.finish_reason;
      }
    }
    return out;
  }

  /** 收尾：闭合打开的内容块，发 message_delta + message_stop。 */
  finish(): string {
    let out = this.closeOpen();
    const usage = this.lastUsage;
    out += sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    });
    out += sseFrame('message_stop', { type: 'message_stop' });
    return out;
  }

  private closeOpen(): string {
    if (!this.open) return '';
    const frame = sseFrame('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
    return frame;
  }

  private textDelta(text: string): string {
    let out = '';
    if (!this.open || this.open.kind !== 'text') {
      out += this.closeOpen();
      this.open = { kind: 'text', index: this.blockIndex++ };
      out += sseFrame('content_block_start', {
        type: 'content_block_start',
        index: this.open.index,
        content_block: { type: 'text', text: '' },
      });
    }
    out += sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: this.open.index,
      delta: { type: 'text_delta', text },
    });
    return out;
  }

  private toolDelta(call: ToolCallDelta): string {
    const toolIndex = typeof call.index === 'number' ? call.index : 0;
    let blockIndex = this.toolBlocks.get(toolIndex);
    let out = '';

    if (blockIndex === undefined) {
      out += this.closeOpen();
      blockIndex = this.blockIndex++;
      this.toolBlocks.set(toolIndex, blockIndex);
      this.open = { kind: 'tool', index: blockIndex };
      out += sseFrame('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: call.function?.name ?? '',
          input: {},
        },
      });
    } else if (!this.open || this.open.index !== blockIndex) {
      // 罕见：文本块与该工具块交错出现 → 先收口当前块，再继续该工具块（不重复发 start）
      out += this.closeOpen();
      this.open = { kind: 'tool', index: blockIndex };
    }

    const args = call.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      out += sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
    return out;
  }
}
