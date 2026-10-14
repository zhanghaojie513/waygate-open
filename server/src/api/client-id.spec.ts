/**
 * client_id 契约（spec-v4-client-id 方案 A）——**分组 / 过滤 / 聚合的正确性**。
 *
 * 覆盖：
 *   AC-C08 ★ 改名后走**生产路径**重算，客户端列表/概览/日志过滤的**数字一字不变**，只有显示名变
 *   AC-C02   rule-2 -> key_id / rule-4 -> 'unidentified'（含写侧 ProxyLogger 的映射）
 *   外加：概览口径断言 creditsUsed === ΣbyModel === ΣbyClient 仍然成立（免费的回归网）
 *
 * 显示名的回落与「改名后凡展示处都是新名」的断言在 `client-display.spec.ts`。
 *
 * ★ 测试纪律：断言的是**结果**（同一批数据在改名前后各生产读口算出的数字），
 *   不在测试里重抄一遍过滤/分组条件 —— 复制一份逻辑的测试等于没有测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHarness, type Harness } from './client-harness';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProxyLogger } from '../proxy/proxy-log';
import type { StreamContext } from '../proxy/proxy-log';
import type { Accumulator } from '../proxy/types';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.db.close();
});

const clientOf = (id: string) => h.clients.list(h.spec).items.find((i) => i.clientId === id);
const ovClientOf = (id: string) => h.overview.build(h.spec).byClient.find((c) => c.clientId === id);

describe('AC-C08 · 改名不改变任何数字（走生产路径重算）', () => {
  it('改绑定名后：客户端列表 / 概览 byClient / 日志过滤的 requests 与 credits 全等，只有显示名变', () => {
    h.makeKey('k_a', 'Claude Code', 'sk-waygate-aaaa…0001');
    for (let i = 0; i < 3; i++) {
      h.log({ clientId: 'k_a', client: 'Claude Code', clientRule: 2, keyId: 'k_a', keyHint: 'sk-waygate-aaaa…0001', credits: 2 });
    }
    h.log({ clientId: 'unidentified', client: '未识别', clientRule: 4, credits: 7 }); // 兜底客户端

    const snapshot = () => ({
      list: clientOf('k_a'),
      ov: ovClientOf('k_a'),
      logTotal: h.requestSvc.list({ page: 1, limit: 50, clientId: 'k_a' }).total,
    });

    const before = snapshot();
    expect(before.list?.client).toBe('Claude Code');
    expect(before.list?.requests).toBe(3);
    expect(before.list?.credits).toBe(6);
    expect(before.ov?.requests).toBe(3);
    expect(before.ov?.credits).toBe(6);
    expect(before.logTotal).toBe(3);

    // 用户把密钥的绑定名改了 —— 旧实现从此会「静默失配」
    h.keysRepo.patch('k_a', { client: 'Renamed Client' });

    const after = snapshot();
    // ★ 数字一字不变
    expect(after.list?.requests).toBe(before.list?.requests);
    expect(after.list?.credits).toBe(before.list?.credits);
    expect(after.ov?.requests).toBe(before.ov?.requests);
    expect(after.ov?.credits).toBe(before.ov?.credits);
    expect(after.logTotal).toBe(before.logTotal);
    // clientId 稳定；显示名跟进新名字
    expect(after.list?.clientId).toBe('k_a');
    expect(after.ov?.clientId).toBe('k_a');
    expect(after.list?.client).toBe('Renamed Client');
    expect(after.ov?.client).toBe('Renamed Client');

    // 改回：数字仍与最初一致
    h.keysRepo.patch('k_a', { client: 'Claude Code' });
    const back = snapshot();
    expect(back.list?.requests).toBe(before.list?.requests);
    expect(back.list?.credits).toBe(before.list?.credits);
    expect(back.list?.client).toBe('Claude Code');
  });

  it('分组键是 client_id 而非名字：两把「同名绑定」的密钥 = 两个客户端行，不会被合成一行', () => {
    h.makeKey('k_1', 'Same Name', 'sk-waygate-1111…aaaa');
    h.makeKey('k_2', 'Same Name', 'sk-waygate-2222…bbbb');
    h.log({ clientId: 'k_1', client: 'Same Name', clientRule: 2, keyId: 'k_1', credits: 1 });
    h.log({ clientId: 'k_2', client: 'Same Name', clientRule: 2, keyId: 'k_2', credits: 1 });

    const items = h.clients.list(h.spec).items.filter((i) => i.client === 'Same Name');
    // 旧实现（GROUP BY client 名字）会把这两把密钥合成一行、requests=2；
    // 新实现按 client_id 分组，是两行、各 requests=1。
    expect(items.length).toBe(2);
    expect(new Set(items.map((i) => i.clientId))).toEqual(new Set(['k_1', 'k_2']));
    expect(items.every((i) => i.requests === 1)).toBe(true);
  });
});

describe('AC-C02 · client_id 取值语义（含写侧映射）', () => {
  it('rule-2 行 client_id = key_id；rule-4 行 = unidentified', () => {
    h.makeKey('k_x', 'X', 'sk-waygate-xxxx…yyyy');
    h.log({ clientId: 'k_x', client: 'X', clientRule: 2, keyId: 'k_x', keyHint: 'h' });
    h.log({ clientId: 'unidentified', client: '未识别', clientRule: 4 });

    const rows = h.db
      .prepare('SELECT client_rule, client_id, key_id FROM requests ORDER BY id')
      .all() as Array<{ client_rule: number; client_id: string; key_id: string | null }>;
    for (const r of rows) {
      if (r.client_rule === 2) expect(r.client_id).toBe(r.key_id);
      if (r.client_rule === 4) expect(r.client_id).toBe('unidentified');
    }
  });

  it('写侧 ProxyLogger：有 keyContext -> client_id=keyId/rule2；无 -> unidentified/rule4', async () => {
    h.makeKey('k_ctx', 'Claude Code', 'sk-waygate-cccc…dddd'); // key_id 有 FK，先落库
    const proxyLogger = new ProxyLogger(h.requestsRepo, new ModelCatalogRepository(h.db));
    const acc: Accumulator = {
      id: null,
      model: 'kimi-k3',
      created: null,
      role: 'assistant',
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      finishReason: null,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      chunkCount: 1,
      emptyChunkCount: 0,
    };
    const baseCtx = {
      started: Date.now(),
      modelId: 'kimi-k3',
      modelDisplay: 'Kimi-K3',
      notes: [] as string[],
      remoteIp: null,
      ua: null,
      originalStream: true,
      release: () => undefined,
    };

    await proxyLogger.persist(
      {
        ...baseCtx,
        // 这是两个**不同的**请求，各带一个独立的落库守卫（共享守卫会让第 2 个被幂等去重）
        persistGuard: { done: false },
        traceId: 'trace-with-key',
        keyContext: { keyId: 'k_ctx', keyHint: 'sk-waygate-cccc…dddd', client: 'Claude Code', scope: { type: 'all' } },
      } as StreamContext,
      { status: 200, upstreamCode: null, acc, firstByteMs: 40, note: '' },
    );
    await proxyLogger.persist(
      {
        ...baseCtx,
        persistGuard: { done: false },
        traceId: 'trace-no-key',
        keyContext: undefined,
      } as StreamContext,
      { status: 200, upstreamCode: null, acc, firstByteMs: 40, note: '' },
    );

    const rows = h.db
      .prepare('SELECT client_rule, client_id, client, key_id FROM requests ORDER BY id')
      .all() as Array<{ client_rule: number; client_id: string; client: string; key_id: string | null }>;
    expect(rows[0]).toMatchObject({ client_rule: 2, client_id: 'k_ctx', key_id: 'k_ctx', client: 'Claude Code' });
    expect(rows[1]).toMatchObject({ client_rule: 4, client_id: 'unidentified', key_id: null, client: '未识别' });
  });
});

describe('概览口径断言（回归网）', () => {
  it('creditsUsed === ΣbyModel === ΣbyClient，且不触发不一致告警', () => {
    h.makeKey('k_a', 'A', 'sk-waygate-aaaa…0001');
    h.makeKey('k_b', 'B', 'sk-waygate-bbbb…0002');
    h.log({ clientId: 'k_a', client: 'A', clientRule: 2, keyId: 'k_a', model: 'kimi-k3', credits: 2 });
    h.log({ clientId: 'k_b', client: 'B', clientRule: 2, keyId: 'k_b', model: 'glm-5.3', credits: 3 });
    h.log({ clientId: 'unidentified', client: '未识别', clientRule: 4, model: 'kimi-k3', credits: 5 });

    const warn = vi.spyOn(h.overview['logger'], 'warn').mockImplementation(() => undefined);
    const ov = h.overview.build(h.spec);

    expect(ov.metrics.creditsUsed).toBe(10);
    expect(ov.byModel.reduce((s, m) => s + (m.credits ?? 0), 0)).toBe(10);
    expect(ov.byClient.reduce((s, c) => s + c.credits, 0)).toBe(10);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
