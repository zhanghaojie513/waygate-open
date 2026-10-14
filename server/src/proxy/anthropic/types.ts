/**
 * Anthropic Messages 协议形状（`POST /v1/messages`）。
 *
 * ⚠️ 重要事实：**上游订阅侧只讲 OpenAI Chat Completions**（`/v2/chat/completions`，
 * 且实测只接受流式）。`/v2/messages` 与 `/v2/responses` 实测 **404 不存在**。
 * 因此本目录是**我方新增的协议翻译层**：Anthropic 形状 → OpenAI 形状 → 打唯一的上游
 * 流式端点 → 响应再翻回 Anthropic 形状。**不要**以为上游原生支持 Anthropic。
 *
 * 这里只声明本翻译层真正读写到的字段。
 */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type?: string; data: string }
    | { type: 'url'; url: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

/** 未识别块类型也一并接纳（未知字段/块按忽略处理，不报错）。 */
export interface AnthropicUnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicUnknownBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant' | string;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export type AnthropicToolChoiceType = 'auto' | 'any' | 'tool' | 'none';

export interface AnthropicToolChoice {
  type: AnthropicToolChoiceType;
  /** `type:"tool"` 时指定工具名。 */
  name?: string;
}

/** 入站请求体。未列出的字段一律忽略（不报错、也不塞给上游）。 */
export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicToolUseOut {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicTextOut {
  type: 'text';
  text: string;
}

/** 非流式响应体（Anthropic `message` 对象）。 */
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextOut | AnthropicToolUseOut>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Anthropic 错误形状（与 OpenAI 的 `{error:{...}}` **不同**）。 */
export interface AnthropicErrorBody {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}
