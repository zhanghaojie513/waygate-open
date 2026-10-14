import type { Accumulator, ChatChunk, ToolCallDelta, Usage } from './types';

/**
 * 非流式聚合器（ADR-004）。
 *
 * 语义说明：`accumulate` 就地修改并返回同一个 acc（热路径，避免每帧新建 Map）。
 * 需要"不可变"语义的调用方请自己 `structuredClone`，本项目不为此付出每帧拷贝的代价。
 *
 * 这是全项目最容易写错的地方，五条必测用例见 accumulate.spec.ts：
 *   ① 空 chunk  ② 分片 tool_calls  ③ 多个 finish_reason
 *   ④ usage 出现在中间帧  ⑤ 流中途断开
 */
export function createAccumulator(): Accumulator {
  return {
    id: null,
    model: null,
    created: null,
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    chunkCount: 0,
    emptyChunkCount: 0,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** usage 判空：全 0 的 usage 视为有效（上游可能真的返回 0 token）。 */
function pickUsage(usage: Usage | null | undefined): Usage | null {
  if (!usage || typeof usage !== 'object') return null;
  return usage;
}

function mergeToolCalls(
  acc: Map<number, { id: string; type: string; name: string; arguments: string }>,
  deltas: ToolCallDelta[] | undefined,
): void {
  if (!Array.isArray(deltas)) return;
  for (const d of deltas) {
    if (!d || typeof d !== 'object') continue;
    // index 缺失时按 0 处理：上游部分模型（首帧）不重复带 index
    const index = typeof d.index === 'number' ? d.index : 0;
    const prev = acc.get(index) ?? { id: '', type: 'function', name: '', arguments: '' };
    acc.set(index, {
      // id / name 只在首帧出现，后续帧为空字符串；空值绝不覆盖已有值
      id: isNonEmptyString(d.id) ? d.id : prev.id,
      type: isNonEmptyString(d.type) ? d.type : prev.type,
      name: isNonEmptyString(d.function?.name) ? (d.function?.name as string) : prev.name,
      // ★ arguments 是分片字符串，必须拼接。覆盖写法会让多轮工具调用拿到半截 JSON
      arguments: prev.arguments + (isNonEmptyString(d.function?.arguments) ? (d.function?.arguments as string) : ''),
    });
  }
}

/** 折叠一个 chunk。返回同一个 acc（热路径，避免每帧新建 Map）。 */
export function accumulate(acc: Accumulator, chunk: ChatChunk | null | undefined): Accumulator {
  acc.chunkCount += 1;
  if (!chunk || typeof chunk !== 'object') {
    acc.emptyChunkCount += 1;
    return acc;
  }

  if (isNonEmptyString(chunk.id)) acc.id = chunk.id;
  if (isNonEmptyString(chunk.model)) acc.model = chunk.model;
  if (typeof chunk.created === 'number') acc.created = chunk.created;

  // usage 取最后一个非空：不仅末帧才有，中间帧也可能出现
  const usage = pickUsage(chunk.usage);
  if (usage) acc.usage = usage;

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  if (choices.length === 0) {
    // 有些上游会单独发一个只有 usage 的帧，这不是错误
    acc.emptyChunkCount += 1;
    return acc;
  }

  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;

    const delta = choice.delta ?? (choice.message ? { ...choice.message } : undefined);
    if (delta) {
      if (isNonEmptyString(delta.role)) acc.role = delta.role as string;
      if (typeof delta.content === 'string') acc.content += delta.content;
      if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content;
      mergeToolCalls(acc.toolCalls, delta.tool_calls);
    }

    // ★ finish_reason 取最后一个非空：上游可能先发 'length' 再发 'stop'
    if (isNonEmptyString(choice.finish_reason)) acc.finishReason = choice.finish_reason as string;
  }

  return acc;
}

export interface FinalizedMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

/**
 * 折叠成最终响应体。
 *
 * `completed` 为 false 表示流中途断开 —— 调用方**必须**整体失败（ADR-004 §5.3），
 * 绝不返回半截 chat.completion。
 */
export function finalize(acc: Accumulator, completed: boolean): {
  ok: boolean;
  id: string;
  model: string;
  created: number;
  message: FinalizedMessage;
  finishReason: string;
  usage: Usage | null;
} {
  const message: FinalizedMessage = { role: acc.role, content: acc.content };
  if (acc.toolCalls.size > 0) {
    message.tool_calls = [...acc.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: v.type,
        function: { name: v.name, arguments: v.arguments },
      }));
  }
  return {
    ok: completed,
    id: acc.id ?? '',
    model: acc.model ?? '',
    created: acc.created ?? Math.floor(Date.now() / 1000),
    message,
    finishReason: acc.finishReason ?? (completed ? 'stop' : 'interrupted'),
    usage: acc.usage,
  };
}
