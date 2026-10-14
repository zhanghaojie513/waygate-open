/**
 * `POST /v1/messages` 端到端（续）：④ 工具调用、⑤ tool_result、⑥ 上游错误翻 Anthropic 形状、
 * ⑦ 审计不变式。脚手架见 `controller.harness.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DONE, TEXT_1, TEXT_2, failSse, frameJson, invoke, makeHarness, okSse } from './controller.harness';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /v1/messages · 工具与错误', () => {
  it('④ tool_use：非流式 input 被 JSON.parse', async () => {
    const h = makeHarness();
    const toolFrame = frameJson({
      id: 'x',
      model: 'kimi-k2.7',
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"深圳"}' } }],
          },
          finish_reason: null,
        },
      ],
    });
    const finish = frameJson({ id: 'x', model: 'kimi-k2.7', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 6 } });
    await invoke(h, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: '天气' }] }, okSse([toolFrame, finish, DONE]));
    await h.ended;

    const body = h.state.body as Record<string, unknown>;
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '深圳' } }]);
  });

  it('④ tool_use：流式 input_json_delta 分段拼装', async () => {
    const h = makeHarness();
    const t1 = frameJson({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] });
    const t2 = frameJson({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] });
    const t3 = frameJson({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"深圳"}' } }] }, finish_reason: null }] });
    const t4 = frameJson({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 3 } });
    await invoke(
      h,
      { model: 'kimi-k2.7', max_tokens: 50, stream: true, messages: [{ role: 'user', content: '天气' }] },
      okSse([t1, t2, t3, t4, DONE]),
    );
    await h.ended;

    const sse = h.state.rawWrites.join('');
    const start = /event: content_block_start\ndata: (.+)/.exec(sse);
    expect(JSON.parse(start![1]).content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });
    const partials = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]).delta.partial_json as string);
    expect(partials.join('')).toBe('{"city":"深圳"}');
    expect(JSON.parse(partials.join(''))).toEqual({ city: '深圳' });
  });

  it('⑤ tool_result → 上游请求体出现 role:tool 且带 tool_call_id', async () => {
    const h = makeHarness();
    await invoke(
      h,
      {
        model: 'kimi-k2.7',
        max_tokens: 50,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '深圳 26℃' }] },
        ],
      },
      okSse([TEXT_1, TEXT_2, DONE]),
    );
    await h.ended;
    const msgs = h.captured.body!.messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', content: '深圳 26℃', tool_call_id: 'call_1' });
  });

  it('⑥ 上游 429 → Anthropic rate_limit_error；上游 401 → 502 api_error', async () => {
    const h429 = makeHarness();
    await invoke(h429, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, failSse(429, 'too many requests'));
    await h429.ended;
    expect(h429.state.status).toBe(429);
    expect(h429.state.body).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });

    const h401 = makeHarness();
    await invoke(h401, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, failSse(401, ''));
    await h401.ended;
    // 上游 401 按 §2.1.5 映射成 502，Anthropic 侧归为 api_error
    expect(h401.state.status).toBe(502);
    expect(h401.state.body).toMatchObject({ type: 'error', error: { type: 'api_error' } });
  });

  it('⑦ 审计不变式：成功 / 本地拒绝 / 上游失败 各自恰好一行', async () => {
    // 成功
    const ok = makeHarness();
    await invoke(ok, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, okSse([TEXT_1, TEXT_2, DONE]));
    await ok.ended;
    expect(ok.count()).toBe(1);

    // 本地拒绝（翻译校验失败：缺 max_tokens）→ 也落一行 400
    const bad = makeHarness();
    await invoke(bad, { model: 'kimi-k2.7', messages: [{ role: 'user', content: 'hi' }] }, okSse([DONE]));
    await bad.ended;
    expect(bad.count()).toBe(1);
    expect(bad.latest()!.status).toBe(400);

    // 上游失败 → 一行
    const up = makeHarness();
    await invoke(up, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, failSse(500, ''));
    await up.ended;
    expect(up.count()).toBe(1);
    expect(up.latest()!.status).toBe(502);
  });
});
