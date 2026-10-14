/**
 * OpenAI 响应 → Anthropic 响应（翻译层，纯函数）。
 *
 * 用于**非流式** `POST /v1/messages`：先把上游 SSE 聚合成 OpenAI 的
 * `chat.completion` 形态（复用 `accumulate.ts`），再翻译成 Anthropic `message` 对象。
 */

import { randomBytes } from 'node:crypto';
import type { FinalizedMessage } from '../accumulate';
import type { Usage } from '../types';
import type { AnthropicMessageResponse } from './types';

/** 生成本服务自己的 Anthropic 消息 id（`msg_` 前缀，是**我们**产出的响应 id）。 */
export function newMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/**
 * OpenAI `finish_reason` → Anthropic `stop_reason`。
 *
 * 任务口径（映射关系为契约的一部分，改动要同步契约）：
 *   stop → end_turn、length → max_tokens、tool_calls → tool_use。
 * `content_filter` 归为 `refusal`，其余未识别值归为 `end_turn`。
 */
export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** `tool_calls[].function.arguments`（JSON 串）→ Anthropic `input` 对象。 */
export function parseToolInput(argumentsJson: string | undefined): unknown {
  if (!argumentsJson) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    // 上游给了坏 JSON：不编造，退化为空对象（Anthropic 要求 input 是对象）
    return {};
  }
}

export interface BuildMessageParams {
  id: string;
  model: string;
  message: FinalizedMessage;
  finishReason: string;
  usage: Usage | null;
}

/** 组装 Anthropic 非流式 `message` 响应体。 */
export function toAnthropicMessage(params: BuildMessageParams): AnthropicMessageResponse {
  const content: AnthropicMessageResponse['content'] = [];
  if (typeof params.message.content === 'string' && params.message.content.length > 0) {
    content.push({ type: 'text', text: params.message.content });
  }
  for (const call of params.message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    });
  }

  return {
    id: params.id,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content,
    stop_reason: mapStopReason(params.finishReason),
    stop_sequence: null,
    usage: {
      // usage 缺失时以 0 占位（Anthropic 结构要求该字段存在）；非静默——由审计行
      // 的 `usage_missing` 标记体现。权威口径见契约 §2.1.6。
      input_tokens: params.usage?.prompt_tokens ?? 0,
      output_tokens: params.usage?.completion_tokens ?? 0,
    },
  };
}
