/** 上游 / 客户端共用的 OpenAI 兼容形状（只声明本项目实际读写的字段）。 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | null;
  [key: string]: unknown;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChunkDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
  [key: string]: unknown;
}

export interface ChunkChoice {
  index?: number;
  delta?: ChunkDelta;
  message?: { role?: string; content?: string | null; tool_calls?: ToolCallDelta[] };
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChunkChoice[];
  usage?: Usage | null;
  [key: string]: unknown;
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  stream_options?: unknown;
  [key: string]: unknown;
}

/** 累加器：把一串 chunk 折叠成单个非流式响应所需的状态。 */
export interface Accumulator {
  id: string | null;
  model: string | null;
  created: number | null;
  role: string;
  /** 所有 delta.content 按序拼接 —— 必须等于非流式响应的 message.content */
  content: string;
  /** 思考链，单独保存不透传给非流式客户端（客户端不认这个字段） */
  reasoning: string;
  /** index -> 已合并的 tool_call（arguments 分片拼接，不是覆盖） */
  toolCalls: Map<number, { id: string; type: string; name: string; arguments: string }>;
  /** 取最后一个非空 finish_reason，而不是第一个 */
  finishReason: string | null;
  /** usage 可能出现在首帧、中间帧或末帧，取最后一个非空 */
  usage: Usage | null;
  /** 收到的 chunk 数（含空 chunk，用于日志与断流判定） */
  chunkCount: number;
  /** 空 chunk 数（choices 缺失或为空数组） */
  emptyChunkCount: number;
}
