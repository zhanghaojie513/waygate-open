/**
 * Anthropic 请求 → OpenAI Chat Completions 请求（翻译层，纯函数）。
 *
 * 只做翻译与最必要的入参校验；**未识别字段一律忽略**（不报错、也不透传给上游）——
 * 与 `/v1/chat/completions` 的「静默丢弃未知字段」口径一致，避免客户端带一个新字段
 * 就把整个请求打挂。
 */

import { ApiCode, RelayHttpError } from '../../common/errors';
import type { ChatMessage, ChatRequestBody } from '../types';
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

function badRequest(message: string): RelayHttpError {
  return new RelayHttpError({
    httpStatus: 400,
    code: 'invalid_request_body',
    apiCode: ApiCode.BAD_PARAM,
    message,
  });
}

/** content 允许 string 或 parts 数组，这里统一按「对象数组」处理。 */
function asMessage(obj: Record<string, unknown>): ChatMessage {
  return obj as unknown as ChatMessage;
}

/** `system`（string 或 text blocks）→ 单段文本；无 system 时返回 null。 */
export function flattenSystem(system: AnthropicRequest['system']): string | null {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts = system
      .map((b) => (b && b.type === 'text' && typeof (b as AnthropicTextBlock).text === 'string' ? (b as AnthropicTextBlock).text : ''))
      .filter((t) => t.length > 0);
    return parts.length > 0 ? parts.join('\n') : '';
  }
  return null;
}

/** Anthropic image block → OpenAI `image_url` part。识别不了则返回 null（忽略）。 */
function imageToPart(block: AnthropicImageBlock): Record<string, unknown> | null {
  const src = block.source;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  if (src.type === 'url' && typeof src.url === 'string') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/** `tool_result.content`（string 或 text blocks）→ 纯文本。 */
function toolResultText(content: AnthropicToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

/** assistant 的一条消息：text 拼成 content，tool_use 变成 tool_calls。 */
function convertAssistant(content: string | AnthropicContentBlock[]): ChatMessage {
  if (typeof content === 'string') return asMessage({ role: 'assistant', content });
  const texts: string[] = [];
  const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      const b = block as AnthropicToolUseBlock;
      calls.push({
        id: typeof b.id === 'string' ? b.id : '',
        type: 'function',
        function: {
          name: typeof b.name === 'string' ? b.name : '',
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const out: Record<string, unknown> = { role: 'assistant', content: texts.length > 0 ? texts.join('') : null };
  if (calls.length > 0) out.tool_calls = calls;
  return asMessage(out);
}

/**
 * 一条 user 消息可能带 tool_result（前端把工具结果回传）。
 * OpenAI 要求 tool_result 落成独立的 `role:"tool"` 消息；其余文本/图片落成一条 `role:"user"`。
 */
function convertUser(content: string | AnthropicContentBlock[]): ChatMessage[] {
  if (typeof content === 'string') return [asMessage({ role: 'user', content })];
  const parts: Array<Record<string, unknown>> = [];
  const toolMsgs: ChatMessage[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const p = imageToPart(block as AnthropicImageBlock);
      if (p) parts.push(p);
      continue;
    }
    if (block.type === 'tool_result') {
      const b = block as AnthropicToolResultBlock;
      toolMsgs.push(
        asMessage({
          role: 'tool',
          content: toolResultText(b.content),
          tool_call_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
        }),
      );
    }
  }
  const out: ChatMessage[] = [...toolMsgs];
  if (parts.length > 0) {
    const onlyText = parts.every((p) => p.type === 'text');
    out.push(asMessage({ role: 'user', content: onlyText ? parts.map((p) => String(p.text)).join('') : parts }));
  }
  return out.length > 0 ? out : [asMessage({ role: 'user', content: '' })];
}

/** `tools:[{name,description,input_schema}]` → OpenAI function tools。 */
function convertTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools
    .filter((t) => t && typeof t === 'object' && typeof t.name === 'string')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}

/** `tool_choice` → OpenAI（auto / required / none / {function:{name}}）。 */
function convertToolChoice(choice: AnthropicRequest['tool_choice']): unknown {
  if (!choice || typeof choice !== 'object') return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any': // Anthropic「必须用某个工具」≈ OpenAI「required」
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name ?? '' } };
    default:
      return undefined;
  }
}

/**
 * 翻译入口。校验：body 为对象、`model` 非空、`messages` 为数组、`max_tokens` 为数字。
 * 返回可直接交给 `ProxyService.callUpstream` 的 OpenAI 形状请求体。
 */
export function toOpenAIChatBody(input: AnthropicRequest | undefined): ChatRequestBody {
  if (!input || typeof input !== 'object') {
    throw badRequest('请求体必须是 JSON 对象。');
  }
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    throw badRequest('model 为必填项，且必须是非空字符串。');
  }
  if (!Array.isArray(input.messages)) {
    throw badRequest('messages 字段缺失或不是数组。');
  }
  if (typeof input.max_tokens !== 'number' || !Number.isFinite(input.max_tokens)) {
    throw badRequest('max_tokens 为必填项，且必须是数字。');
  }

  const messages: ChatMessage[] = [];
  const system = flattenSystem(input.system);
  if (typeof system === 'string' && system.trim() !== '') {
    messages.push(asMessage({ role: 'system', content: system }));
  }

  for (const msg of input.messages as AnthropicMessage[]) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant') messages.push(convertAssistant(msg.content));
    else messages.push(...convertUser(msg.content));
  }

  const body: ChatRequestBody = {
    model: input.model,
    messages,
    max_tokens: input.max_tokens,
  };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (typeof input.top_p === 'number') body.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) {
    body.stop = input.stop_sequences.filter((s) => typeof s === 'string');
  }
  if (Array.isArray(input.tools) && input.tools.length > 0) body.tools = convertTools(input.tools);
  const toolChoice = convertToolChoice(input.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  return body;
}
