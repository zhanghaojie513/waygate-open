import { describe, expect, it } from 'vitest';
import type { ChatChunk } from '../types';
import { AnthropicStreamEncoder, sseFrame } from './stream-events';

/** 从一段拼接后的 SSE 文本里抽出所有 `event:` 名（断言序列用）。 */
function eventNames(sse: string): string[] {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]!);
}

/** 抽出某个事件的 data JSON。 */
function dataOf(sse: string, event: string): Record<string, unknown> {
  const re = new RegExp(`event: ${event}\\ndata: (.+)`);
  const m = re.exec(sse);
  if (!m) throw new Error(`未找到事件 ${event}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

function chunk(obj: Record<string, unknown>): ChatChunk {
  return obj as unknown as ChatChunk;
}

describe('AnthropicStreamEncoder · 文本流（②）', () => {
  it('事件序列完整且顺序正确', () => {
    const enc = new AnthropicStreamEncoder('msg_test', 'kimi-k2.7');
    let sse = enc.start();
    sse += enc.push(chunk({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }));
    sse += enc.push(chunk({ choices: [{ delta: { content: 'lo' } }] }));
    sse += enc.push(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
    sse += enc.finish();

    expect(eventNames(sse)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // message_start 的 message 骨架
    const start = dataOf(sse, 'message_start').message as Record<string, unknown>;
    expect(start.role).toBe('assistant');
    expect(start.model).toBe('kimi-k2.7');
    expect(start.content).toEqual([]);

    // 两个 text_delta 的内容
    const deltas = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]!));
    expect(deltas[0].delta).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(deltas[1].delta).toEqual({ type: 'text_delta', text: 'lo' });

    // message_delta 带 stop_reason 与权威 usage
    const md = dataOf(sse, 'message_delta');
    expect(md.delta).toEqual({ stop_reason: 'end_turn', stop_sequence: null });
    expect(md.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
  });

  it('message_start 的 usage 为 0 占位（权威值在 message_delta）——文档化行为', () => {
    const enc = new AnthropicStreamEncoder('msg_test', 'm');
    const sse = enc.start();
    const start = dataOf(sse, 'message_start').message as Record<string, unknown>;
    expect(start.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('AnthropicStreamEncoder · 工具流（④）', () => {
  it('tool_use 走 content_block_start + input_json_delta 分段拼 JSON', () => {
    const enc = new AnthropicStreamEncoder('msg_test', 'kimi-k2.7');
    let sse = enc.start();
    sse += enc.push(
      chunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } },
        ],
      }),
    );
    sse += enc.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } }] }));
    sse += enc.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"深圳"}' } }] } }] }));
    sse += enc.push(chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 9 } }));
    sse += enc.finish();

    expect(eventNames(sse)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = dataOf(sse, 'content_block_start');
    expect(start.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });

    const partials = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)].map(
      (m) => (JSON.parse(m[1]!).delta as Record<string, unknown>).partial_json as string,
    );
    expect(partials.join('')).toBe('{"location":"深圳"}');
    expect(JSON.parse(partials.join(''))).toEqual({ location: '深圳' });

    const md = dataOf(sse, 'message_delta');
    expect(md.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null });
  });

  it('文本 + 工具混排 → 两个内容块索引 0/1，先文本后工具', () => {
    const enc = new AnthropicStreamEncoder('msg_test', 'm');
    let sse = enc.start();
    sse += enc.push(chunk({ choices: [{ delta: { content: '思考中' } }] }));
    sse += enc.push(
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'do_it', arguments: '{}' } }] } }] }),
    );
    sse += enc.finish();

    const starts = [...sse.matchAll(/event: content_block_start\ndata: (.+)/g)].map((m) => JSON.parse(m[1]!));
    expect(starts[0].index).toBe(0);
    expect((starts[0].content_block as Record<string, unknown>).type).toBe('text');
    expect(starts[1].index).toBe(1);
    expect((starts[1].content_block as Record<string, unknown>).type).toBe('tool_use');
  });
});

describe('sseFrame', () => {
  it('格式为 `event: x\\ndata: {...}\\n\\n`', () => {
    expect(sseFrame('message_stop', { type: 'message_stop' })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });
});
