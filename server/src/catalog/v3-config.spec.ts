import { describe, expect, it, vi } from 'vitest';
import { fetchV3ConfigModels, parseConfigModels, parseCreditsMultiplier } from './v3-config';

/** 服务器实测形状（2026-10-08）：{code:0,msg:'OK',data:{models:[{id,name,credits,…}]}}。 */
const REAL_ENVELOPE = {
  code: 0,
  msg: 'OK',
  requestId: 'r-1',
  data: {
    agent: { agents: null },
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11 credits' },
      { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits', tags: ['badge:限时折扣:#FF0000'] },
      { id: 'default', name: 'Default', credits: 'x2.00 credits' },
      { id: 'hunyuan-image-alpha', name: 'Image', credits: '' },
      { id: 'no-credits-field', name: 'No Credits' },
    ],
    mcp: { enableFilterCount: 0 },
  },
};

describe('parseCreditsMultiplier', () => {
  it('"x0.11 credits" → 0.11；"x0.00" → 0（真实免费≠未知）', () => {
    expect(parseCreditsMultiplier('x0.11 credits')).toBe(0.11);
    expect(parseCreditsMultiplier('x0.00')).toBe(0);
    expect(parseCreditsMultiplier('x2.00 credits')).toBe(2);
    expect(parseCreditsMultiplier('x1.5 credits')).toBe(1.5);
  });

  it('空串/无 x 前缀/非字符串 → null（倍率未知，不编造）', () => {
    expect(parseCreditsMultiplier('')).toBeNull();
    expect(parseCreditsMultiplier('credits')).toBeNull();
    expect(parseCreditsMultiplier(undefined)).toBeNull();
    expect(parseCreditsMultiplier(0.11)).toBeNull();
  });
});

describe('parseConfigModels', () => {
  it('真信封能解析：id/name/credits → multiplier，source=upstream', () => {
    const out = parseConfigModels(REAL_ENVELOPE);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(5);
    const ds = out?.find((e) => e.id === 'deepseek-v4.1-flash');
    expect(ds?.multiplier).toBe(0.11);
    expect(ds?.displayName).toBe('Deepseek-V4.1-Flash');
    expect(ds?.source).toBe('upstream');
    expect(out?.find((e) => e.id === 'hy3')?.multiplier).toBe(0);
    // credits 为空/缺失 → multiplier=null（合并时只补不覆盖）
    expect(out?.find((e) => e.id === 'hunyuan-image-alpha')?.multiplier).toBeNull();
    expect(out?.find((e) => e.id === 'no-credits-field')?.multiplier).toBeNull();
  });

  it('models:null（身份被降级，实测缺 X-User-Id 即如此）→ null 交回落', () => {
    expect(parseConfigModels({ code: 0, msg: 'OK', data: { models: null } })).toBeNull();
  });

  it('非对象 / 缺 data / 空 models 数组 → null，不抛', () => {
    expect(parseConfigModels(null)).toBeNull();
    expect(parseConfigModels('x')).toBeNull();
    expect(parseConfigModels({ data: {} })).toBeNull();
    expect(parseConfigModels({ data: { models: [] } })).toBeNull();
  });

  it('缺 name 的条目 displayName 回落为 id；缺 id 的条目跳过', () => {
    const out = parseConfigModels({ data: { models: [{ id: 'bare', credits: 'x0.5' }, { name: 'NoId' }] } });
    expect(out).toHaveLength(1);
    expect(out?.[0].displayName).toBe('bare');
    expect(out?.[0].multiplier).toBe(0.5);
  });
});

describe('fetchV3ConfigModels', () => {
  const OPTS = { baseUrl: 'https://copilot.tencent.com/', upstreamKey: 'ck_x', timeoutMs: 1000 };

  it('成功：GET <base>/v3/config，带 CLI UA 与 X-User-Id（缺任一上游即降级）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(REAL_ENVELOPE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await fetchV3ConfigModels({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(5);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://copilot.tencent.com/v3/config');
    const h = init.headers as Record<string, string>;
    expect(h['user-agent']).toMatch(/^CLI\//);
    expect(h['user-agent']).toMatch(/CodeBuddy\//);
    expect(h['x-user-id']).toBeTruthy();
    expect(h['authorization']).toBe('Bearer ck_x');
  });

  it('未配置 key：ok=false 人话原因，不发请求', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchV3ConfigModels({ ...OPTS, upstreamKey: '', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('快照');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx / 200 但 models:null / 网络异常：一律 ok=false 静默回落，不抛', async () => {
    const notOk = vi.fn().mockResolvedValue(new Response('x', { status: 401 }));
    expect((await fetchV3ConfigModels({ ...OPTS, fetchImpl: notOk as unknown as typeof fetch })).ok).toBe(false);

    const nulled = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, data: { models: null } }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const r2 = await fetchV3ConfigModels({ ...OPTS, fetchImpl: nulled as unknown as typeof fetch });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('models:null');

    const boom = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const r3 = await fetchV3ConfigModels({ ...OPTS, fetchImpl: boom as unknown as typeof fetch });
    expect(r3.ok).toBe(false);
    expect(r3.reason).toContain('快照');
  });
});
