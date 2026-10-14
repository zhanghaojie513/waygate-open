import { describe, expect, it } from 'vitest';
import { accumulate, createAccumulator, finalize } from './accumulate';
import type { ChatChunk } from './types';

/**
 * ADR-004 指定的五条必测用例 —— 这是全项目最容易写错的地方。
 * 每条用例都对应一个"编译通过、跑得动、结果错"的沉默逻辑错误。
 */

describe('accumulate —— ADR-004 五条必测用例', () => {
  it('① 空 chunk：null / undefined / choices 缺失 / choices 为空数组都不崩，且不计入内容', () => {
    const acc = createAccumulator();
    accumulate(acc, null);
    accumulate(acc, undefined);
    accumulate(acc, {} as ChatChunk);
    accumulate(acc, { choices: [] } as ChatChunk);
    accumulate(acc, { choices: null } as unknown as ChatChunk);

    expect(acc.content).toBe('');
    expect(acc.chunkCount).toBe(5);
    expect(acc.emptyChunkCount).toBe(5);
    expect(acc.finishReason).toBeNull();
    expect(acc.usage).toBeNull();
  });

  it('② 只有 usage 的帧（choices 为空）不被当成错误，且 usage 被接住', () => {
    const acc = createAccumulator();
    accumulate(acc, {
      id: 'x',
      choices: [],
      usage: { prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 },
    } as ChatChunk);

    expect(acc.emptyChunkCount).toBe(1);
    expect(acc.usage).toEqual({ prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 });
  });

  it('③ 分片 tool_calls：arguments 必须拼接，id/name 不能被后续空值覆盖', () => {
    const acc = createAccumulator();
    accumulate(acc, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } },
            ],
          },
        },
      ],
    } as ChatChunk);
    // 后续帧：带 index 但 id/name 为空；arguments 是续片
    accumulate(acc, {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: '', type: '', function: { name: '', arguments: 'ty":"' } }] } },
      ],
    } as ChatChunk);
    accumulate(acc, {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '北京"}' } }] } }],
    } as ChatChunk);

    const out = finalize(acc, true);
    expect(out.message.tool_calls).toHaveLength(1);
    expect(out.message.tool_calls?.[0].id).toBe('call_1');
    expect(out.message.tool_calls?.[0].function.name).toBe('get_weather');
    // ★ 拼接而不是覆盖 —— 覆盖会得到 '北京"}' 这种半截 JSON
    expect(out.message.tool_calls?.[0].function.arguments).toBe('{"city":"北京"}');
    expect(() => JSON.parse(out.message.tool_calls![0].function.arguments)).not.toThrow();
  });

  it('④ 多个 tool_calls 按 index 分别归并，不串味', () => {
    const acc = createAccumulator();
    accumulate(acc, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'f1', arguments: '{"x":' } },
              { index: 1, id: 'b', function: { name: 'f2', arguments: '{"y":' } },
            ],
          },
        },
      ],
    } as ChatChunk);
    accumulate(acc, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '1}' } },
              { index: 1, function: { arguments: '2}' } },
            ],
          },
        },
      ],
    } as ChatChunk);

    const out = finalize(acc, true);
    expect(out.message.tool_calls?.[0].function.arguments).toBe('{"x":1}');
    expect(out.message.tool_calls?.[1].function.arguments).toBe('{"y":2}');
  });

  it('⑤ 多个 finish_reason：取最后一个非空，先 length 后 stop 要拿 stop', () => {
    const acc = createAccumulator();
    accumulate(acc, { choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'length' }] } as ChatChunk);
    accumulate(acc, { choices: [{ index: 0, delta: {}, finish_reason: null }] } as ChatChunk);
    accumulate(acc, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as ChatChunk);

    expect(acc.finishReason).toBe('stop');
  });

  it('⑥ usage 出现在中间帧也要接住（不是只有末帧才有）', () => {
    const acc = createAccumulator();
    accumulate(acc, { choices: [{ index: 0, delta: { content: 'x' } }] } as ChatChunk);
    accumulate(acc, {
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 },
    } as ChatChunk);
    accumulate(acc, {
      choices: [{ index: 0, delta: { content: 'y' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
    } as ChatChunk);

    expect(acc.usage?.completion_tokens).toBe(7);
    expect(acc.content).toBe('xy');
  });

  it('⑦ 流中途断开：completed=false 时 ok=false，调用方据此整体失败', () => {
    const acc = createAccumulator();
    accumulate(acc, { id: 'c1', choices: [{ index: 0, delta: { content: '半截' } }] } as ChatChunk);
    // 上游连接被掐，此后没有 chunk 了

    const broken = finalize(acc, false);
    expect(broken.ok).toBe(false);
    expect(broken.finishReason).toBe('interrupted');
    // 内容本身仍可取出，但 ok=false 表示这份内容不可用
    expect(broken.message.content).toBe('半截');
  });

  it('⑧ reasoning_content 单独累计，不进 content', () => {
    const acc = createAccumulator();
    accumulate(acc, {
      choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: '想' } }],
    } as ChatChunk);
    accumulate(acc, { choices: [{ index: 0, delta: { content: '答', reasoning_content: '一下' } }] } as ChatChunk);

    expect(acc.content).toBe('答');
    expect(acc.reasoning).toBe('想一下');
  });

  it('⑨ 非流式断言：message.content === 所有 delta.content 之和', () => {
    const pieces = ['你', '好', '，', '世界'];
    const acc = createAccumulator();
    for (const p of pieces) {
      accumulate(acc, { choices: [{ index: 0, delta: { content: p } }] } as ChatChunk);
    }
    accumulate(acc, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    } as ChatChunk);

    const out = finalize(acc, true);
    expect(out.ok).toBe(true);
    expect(out.message.content).toBe(pieces.join(''));
    expect(out.finishReason).toBe('stop');
  });

  it('⑩ 上游 message 形态（非 delta）也能被折叠，容错不硬编码 delta 字段名', () => {
    const acc = createAccumulator();
    accumulate(acc, {
      choices: [{ index: 0, message: { role: 'assistant', content: '直接给完整消息' }, finish_reason: 'stop' }],
    } as ChatChunk);

    expect(acc.content).toBe('直接给完整消息');
    expect(finalize(acc, true).message.content).toBe('直接给完整消息');
  });
});
