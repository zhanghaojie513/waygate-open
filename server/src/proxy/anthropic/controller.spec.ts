/**
 * `POST /v1/messages` 端到端（走 controller 公共边界，复用真实 ProxyService / ProxyLogger / SQLite）。
 *
 * 本文件：① 非流式文本、② 流式文本事件序列、③ system 两种形态。
 * 工具/错误/审计见 `controller-flow.spec.ts`；脚手架见 `controller.harness.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DONE, TEXT_1, TEXT_2, invoke, makeHarness, okSse } from './controller.harness';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /v1/messages · 基础', () => {
  it('① 非流式文本 → Anthropic message（text / stop_reason / usage）且落一行审计', async () => {
    const h = makeHarness();
    await invoke(h, { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, okSse([TEXT_1, TEXT_2, DONE]));
    await h.ended;

    expect(h.state.status).toBe(200);
    const body = h.state.body as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('kimi-k2.7');
    expect(body.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2 });

    expect(h.count()).toBe(1);
    const row = h.latest()!;
    expect(row.status).toBe(200);
    expect(row.model).toBe('kimi-k2.7');
    expect(row.stream).toBe(0);
    expect(row.client_id).toBe('k_anth');
  });

  it('② 流式文本 → 事件序列完整且逐块到达', async () => {
    const h = makeHarness();
    await invoke(
      h,
      { model: 'kimi-k2.7', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      okSse([TEXT_1, TEXT_2, DONE]),
    );
    await h.ended;

    expect(h.state.rawHead).toBe(200);
    const sse = h.state.rawWrites.join('');
    const names = [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    // 逐块到达：message_start 与 content 增量各自独立写出（不是攒到最后一次性 flush）
    expect(h.state.rawWrites.length).toBeGreaterThanOrEqual(3);

    expect(h.count()).toBe(1);
    expect(h.latest()!.stream).toBe(1);
    expect(h.latest()!.status).toBe(200);
  });

  it('③ system 两种形态都翻成首条 role:system', async () => {
    const h = makeHarness();
    await invoke(
      h,
      { model: 'kimi-k2.7', max_tokens: 50, system: '你是助手', messages: [{ role: 'user', content: 'hi' }] },
      okSse([TEXT_1, TEXT_2, DONE]),
    );
    await h.ended;
    const msgs1 = h.captured.body!.messages as Array<Record<string, unknown>>;
    expect(msgs1[0]).toEqual({ role: 'system', content: '你是助手' });

    const h2 = makeHarness();
    await invoke(
      h2,
      {
        model: 'kimi-k2.7',
        max_tokens: 50,
        system: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      okSse([TEXT_1, TEXT_2, DONE]),
    );
    await h2.ended;
    const msgs2 = h2.captured.body!.messages as Array<Record<string, unknown>>;
    expect(msgs2[0]).toEqual({ role: 'system', content: '甲\n乙' });
  });
});
