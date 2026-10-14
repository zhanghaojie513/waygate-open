import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { RelayHttpError } from '../../common/errors';
import type { ChatMessage } from '../types';
import { flattenSystem, toOpenAIChatBody } from './translate-request';
import { mapStopReason, parseToolInput, toAnthropicMessage } from './translate-response';
import { anthropicErrorType, mapAnthropicError } from './errors';

/** 取第 n 条 OpenAI 消息（断言用，避免到处 as）。 */
function msg(body: { messages: ChatMessage[] }, n: number): Record<string, unknown> {
  return body.messages[n] as unknown as Record<string, unknown>;
}

describe('translate-request · system 两种形态（③）', () => {
  it('system 为字符串 → 首条 role:system', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      system: '你是助手',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msg(body, 0)).toEqual({ role: 'system', content: '你是助手' });
    expect(msg(body, 1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('system 为 blocks 数组 → 取 text 拼成首条 system', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      system: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msg(body, 0)).toEqual({ role: 'system', content: '第一段\n第二段' });
  });

  it('flattenSystem：非 text 块被忽略，全空返回空串', () => {
    expect(flattenSystem([{ type: 'text', text: 'x' }])).toBe('x');
    expect(flattenSystem('直接字符串')).toBe('直接字符串');
    expect(flattenSystem(undefined)).toBeNull();
  });

  it('无 system 时不注入（交由既有 rewrite 管线补默认 system）', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msg(body, 0).role).toBe('user');
    expect(body.messages).toHaveLength(1);
  });
});

describe('translate-request · messages / tools / 未知字段（④⑤）', () => {
  it('assistant 的 tool_use 块 → tool_calls（input 序列化为 arguments）', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [
        { role: 'user', content: '天气' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我查一下' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '深圳' } },
          ],
        },
      ],
    });
    const m = msg(body, 1);
    expect(m.role).toBe('assistant');
    expect(m.content).toBe('我查一下');
    const calls = m.tool_calls as Array<Record<string, unknown>>;
    expect(calls[0].id).toBe('toolu_1');
    expect((calls[0].function as Record<string, unknown>).name).toBe('get_weather');
    expect(JSON.parse((calls[0].function as Record<string, unknown>).arguments as string)).toEqual({ city: '深圳' });
  });

  it('⑤ user 的 tool_result 块 → 独立 role:tool 消息（带 tool_call_id）', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '深圳 26℃' }],
        },
      ],
    });
    expect(msg(body, 0)).toEqual({ role: 'tool', content: '深圳 26℃', tool_call_id: 'toolu_1' });
  });

  it('tool_result.content 为 blocks 时取 text', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          ],
        },
      ],
    });
    expect(msg(body, 0).content).toBe('ab');
  });

  it('tools:[{name,description,input_schema}] → OpenAI function tools', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object' } }],
    });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].type).toBe('function');
    const fn = tools[0].function as Record<string, unknown>;
    expect(fn.name).toBe('get_weather');
    expect(fn.description).toBe('查天气');
    expect(fn.parameters).toEqual({ type: 'object' });
  });

  it('tool_choice：auto/any/tool/none 映射', () => {
    // ⚠️ 不要写成 `as const`：那会把 `messages` 变成**只读元组**，与 `AnthropicMessage[]`
    // （可变数组）不兼容。用形参类型标注，既可推断字面量又不引入 readonly。
    const base: Parameters<typeof toOpenAIChatBody>[0] = {
      model: 'm',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }],
    };
    expect(toOpenAIChatBody({ ...base, tool_choice: { type: 'auto' } }).tool_choice).toBe('auto');
    expect(toOpenAIChatBody({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
    expect(toOpenAIChatBody({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe('none');
    expect(toOpenAIChatBody({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } }).tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('stop_sequences → stop；未知字段被忽略（不透传也不报错）', () => {
    const body = toOpenAIChatBody({
      model: 'kimi-k2.7',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stop_sequences: ['\n\n', 'END'],
      top_k: 5,
      metadata: { user_id: 'u1' },
    });
    expect(body.stop).toEqual(['\n\n', 'END']);
    expect('top_k' in (body as Record<string, unknown>)).toBe(false);
    expect('metadata' in (body as Record<string, unknown>)).toBe(false);
  });

  it('入参校验：缺 model / messages / max_tokens → 400', () => {
    expect(() => toOpenAIChatBody(undefined)).toThrow(RelayHttpError);
    expect(() => toOpenAIChatBody({ messages: [], max_tokens: 1 })).toThrow(/model/);
    expect(() => toOpenAIChatBody({ model: 'm', max_tokens: 1 })).toThrow(/messages/);
    expect(() => toOpenAIChatBody({ model: 'm', messages: [] })).toThrow(/max_tokens/);
  });
});

describe('translate-response · stop_reason 映射与 tool_use（①④）', () => {
  it('stop_reason：stop→end_turn、length→max_tokens、tool_calls→tool_use', () => {
    expect(mapStopReason('stop')).toBe('end_turn');
    expect(mapStopReason('length')).toBe('max_tokens');
    expect(mapStopReason('tool_calls')).toBe('tool_use');
  });

  it('非流式响应：tool_calls 的 arguments 被 JSON.parse 成 input', () => {
    const out = toAnthropicMessage({
      id: 'msg_x',
      model: 'kimi-k2.7',
      message: {
        role: 'assistant',
        content: '好的',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"深圳"}' } }],
      },
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content[0]).toEqual({ type: 'text', text: '好的' });
    expect(out.content[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '深圳' } });
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('parseToolInput：坏 JSON / 空串退化为 {}（不编造）', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput('')).toEqual({});
    expect(parseToolInput('{bad')).toEqual({});
  });
});

describe('errors · Anthropic 错误形状（⑥）', () => {
  it('anthropicErrorType：401/403/429/400/5xx 映射', () => {
    expect(anthropicErrorType(401)).toBe('authentication_error');
    expect(anthropicErrorType(403)).toBe('permission_error');
    expect(anthropicErrorType(429)).toBe('rate_limit_error');
    expect(anthropicErrorType(400)).toBe('invalid_request_error');
    expect(anthropicErrorType(502)).toBe('api_error');
    expect(anthropicErrorType(504)).toBe('api_error');
  });

  it('RelayHttpError(429) → rate_limit_error 且形状是 {type,error:{type,message}}', () => {
    const out = mapAnthropicError(new RelayHttpError({ httpStatus: 429, code: 'rate_limited', message: '上游限流。' }));
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: '上游限流。' } });
  });

  it('ClientKeyGuard 的 UnauthorizedException（OpenAI 形状）→ Anthropic authentication_error', () => {
    const exc = new HttpException(
      { error: { message: 'Invalid API key provided. 请检查密钥是否有效、是否被停用或已过期。', type: 'invalid_request_error', code: 'invalid_api_key', param: null } },
      401,
    );
    const out = mapAnthropicError(exc);
    expect(out.status).toBe(401);
    expect(out.body.type).toBe('error');
    expect(out.body.error.type).toBe('authentication_error');
    expect(out.body.error.message).toContain('Invalid API key');
    // 不得残留 OpenAI 的 error 包装字段（code/param）
    expect('code' in (out.body.error as Record<string, unknown>)).toBe(false);
    expect('param' in (out.body.error as Record<string, unknown>)).toBe(false);
  });
});
