import { describe, expect, it, vi } from 'vitest';
import {
  deriveFamily,
  extractBadgeTag,
  mergeCatalog,
  normalizeLocal,
  observedToEntries,
  parseUpstreamModels,
  pullUpstreamModels,
  type CatalogEntry,
} from './pull';

const LOCAL: CatalogEntry[] = [
  { id: 'kimi-k3', displayName: 'Kimi-K3', family: 'kimi', tag: '订阅优先', multiplier: 1.62, source: 'seed', verified: true, enabled: true },
  { id: 'kimi-k2.7', displayName: 'Kimi-K2.7-Code', family: 'kimi', tag: null, multiplier: 0.57, source: 'seed', verified: true, enabled: true },
  { id: 'glm-5.3', displayName: 'GLM-5.3', family: 'glm', tag: '订阅优先', multiplier: 0.79, source: 'seed', verified: true, enabled: true },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('deriveFamily', () => {
  it('取 id 第一个 - 前的段', () => {
    expect(deriveFamily('kimi-k3')).toBe('kimi');
    expect(deriveFamily('deepseek-v4-pro')).toBe('deepseek');
    expect(deriveFamily('hy4-preview')).toBe('hy4');
    expect(deriveFamily('standalone')).toBe('standalone');
  });
});

describe('parseUpstreamModels', () => {
  it('① 真信封 {code,msg,requestId,data:[{id,name}]} 能解析（国内版目录实测形状）', () => {
    const out = parseUpstreamModels({
      code: 0,
      msg: 'OK',
      requestId: 'x',
      data: [
        { id: 'kimi-k3-1', name: 'Kimi-K3', vendor: 'moonshot', tags: [] },
        { id: 'glm-5.3', name: 'GLM-5.3' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out?.[0].id).toBe('kimi-k3-1');
    expect(out?.[0].displayName).toBe('Kimi-K3');
    expect(out?.[0].source).toBe('upstream');
  });

  it('② OpenAI 形状 {data:[{id}]} 与非信封 {models:[...]} 都能解析', () => {
    expect(parseUpstreamModels({ data: [{ id: 'a' }] })?.[0].id).toBe('a');
    const out = parseUpstreamModels({ models: [{ id: 'a-1', display_name: 'A One' }] });
    expect(out?.[0].displayName).toBe('A One');
  });

  it('③ 不是清单形状时返回 null（交由回落），不抛异常', () => {
    expect(parseUpstreamModels(null)).toBeNull();
    expect(parseUpstreamModels('text')).toBeNull();
    expect(parseUpstreamModels({})).toBeNull();
    expect(parseUpstreamModels({ data: [] })).toBeNull();
    expect(parseUpstreamModels({ data: [{ noId: 1 }] })).toBeNull();
  });

  it('④ ★ name 缺失时回落用 id，且 multiplier 为 null（上游不给倍率，绝不编造）', () => {
    const out = parseUpstreamModels({ data: [{ id: 'x-1' }] });
    expect(out?.[0].displayName).toBe('x-1');
    expect(out?.[0].multiplier).toBeNull();
    expect(out?.[0].tag).toBeNull();
  });

  it('④b [v0.4.15] ★ 上游 tags 数组里的 badge: 条目映射为 tag，credits 映射为倍率（实测真实响应）', () => {
    /* 实测 copilot.tencent.com /v2/enterprises/personal/models 的真实条目：
       tags 里的 `badge:文字:颜色` 是 WorkBuddy 客户端同源的计价徽标。 */
    const out = parseUpstreamModels({
      data: [
        { id: 'hy3', name: 'Hy3', vendor: 'x', tags: ['craft', 'badge:限时免费:#FF0000'], credits: 'x0.00 credits' },
        { id: 'hy3-x', name: 'Hy3-X', vendor: 'x', tags: ['craft'], credits: 'x0.05' },
        { id: 'glm-5.2', name: 'GLM-5.2', vendor: 'x', tags: ['craft', 'badge:夜间折扣:#1E90FF'], credits: 'x0.79 credits' },
        { id: 'no-tags', name: 'No', vendor: 'x' },
      ],
    });
    expect(out).not.toBeNull();
    expect(out?.[0]).toMatchObject({ id: 'hy3', tag: '限时免费', multiplier: 0 });
    expect(out?.[1]).toMatchObject({ id: 'hy3-x', tag: null, multiplier: 0.05 });
    expect(out?.[2]).toMatchObject({ id: 'glm-5.2', tag: '夜间折扣', multiplier: 0.79 });
    expect(out?.[3]).toMatchObject({ id: 'no-tags', tag: null, multiplier: null });
  });
});

describe('extractBadgeTag', () => {
  it('从 badge:文字:颜色 条目提取文字；非徽标条目忽略', () => {
    expect(extractBadgeTag(['craft', 'badge:限时免费:#FF0000'])).toBe('限时免费');
    expect(extractBadgeTag(['badge:夜间折扣:#1E90FF'])).toBe('夜间折扣');
    expect(extractBadgeTag(['craft'])).toBeNull();
    expect(extractBadgeTag([])).toBeNull();
    expect(extractBadgeTag(null)).toBeNull();
    expect(extractBadgeTag(undefined)).toBeNull();
    expect(extractBadgeTag('not-array')).toBeNull();
    /* badge: 后面没有文字 → 不算有效徽标 */
    expect(extractBadgeTag(['badge::#FFF'])).toBeNull();
  });
});

describe('normalizeLocal', () => {
  it('⑤ 本地种子统一补齐 family / source / verified / enabled', () => {
    const out = normalizeLocal([{ id: 'some-new-model', displayName: 'Some New Model' }]);
    expect(out[0].family).toBe('some');
    expect(out[0].source).toBe('seed');
    expect(out[0].enabled).toBe(true);
    expect(out[0].multiplier).toBeNull(); // 无倍率 = 未知
  });
});

describe('observedToEntries', () => {
  it('⑥ observed 条目标 source=observed、倍率未知', () => {
    const out = observedToEntries([{ id: 'new-x', displayName: 'New X' }]);
    expect(out[0].source).toBe('observed');
    expect(out[0].multiplier).toBeNull();
    expect(out[0].family).toBe('new');
  });
});

describe('pullUpstreamModels —— 失败是常态，不是异常', () => {
  it('⑦ ★ 全部路径 404 → ok=false 且不回任何模型，不抛异常，reason 说清试过哪些路径', async () => {
    const fetchImpl = vi.fn(async () => new Response('404 page not found', { status: 404 }));
    const r = await pullUpstreamModels({
      baseUrl: 'https://copilot.tencent.com',
      upstreamKey: 'ck_test',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      paths: ['/v2/enterprises/personal/models', '/v2/models'],
    });

    expect(r.ok).toBe(false);
    expect(r.origin).toBe('local');
    expect(r.models).toEqual([]);
    expect(r.reason).toContain('/v2/enterprises/personal/models');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('⑧ 网络异常（DNS 失败）也不抛，继续回落', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const r = await pullUpstreamModels({
      baseUrl: 'https://nope.invalid',
      upstreamKey: 'ck_test',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r.ok).toBe(false);
    expect(r.origin).toBe('local');
  });

  it('⑨ ★ 首个路径 404、第二个路径拿到清单 → 用上游清单', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('404', { status: 404 });
      return jsonResponse({ code: 0, data: [{ id: 'kimi-k3-1', name: 'Kimi-K3' }, { id: 'brand-new-model', name: 'Brand New' }] });
    });
    const r = await pullUpstreamModels({
      baseUrl: 'https://copilot.tencent.com',
      upstreamKey: 'ck_test',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      paths: ['/v2/models', '/v2/enterprises/personal/models'],
    });

    expect(r.ok).toBe(true);
    expect(r.origin).toBe('upstream');
    expect(r.models.map((m) => m.id)).toContain('brand-new-model');
  });

  it('⑩ 未配置上游凭证时直接回落，且不发任何请求', async () => {
    const fetchImpl = vi.fn();
    const r = await pullUpstreamModels({
      baseUrl: 'https://copilot.tencent.com',
      upstreamKey: '',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r.origin).toBe('local');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('⑪ 请求头带的是上游凭证（Bearer）+ 伪装 UA，且不含本机 sk-waygate-', async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      Object.assign(seen, init.headers as Record<string, string>);
      return jsonResponse({ data: [{ id: 'kimi-k3' }] });
    });
    await pullUpstreamModels({
      baseUrl: 'https://copilot.tencent.com',
      upstreamKey: 'ck_upstream_only',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seen['authorization']).toBe('Bearer ck_upstream_only');
    expect(seen['user-agent']).toBe('WorkBuddy/5.8.0');
    expect(JSON.stringify(seen)).not.toContain('sk-waygate-');
    expect(JSON.stringify(seen)).not.toContain('sk-relay-');
  });
});

describe('mergeCatalog —— 三路合并，只增不减', () => {
  it('⑫ ★ 上游没有的本地模型被保留，绝不删除（订阅后可能再开）', () => {
    const upstream: CatalogEntry[] = [
      { id: 'kimi-k3', displayName: 'Kimi-K3 官方', family: 'kimi', tag: null, multiplier: 1.62, source: 'upstream', verified: true, enabled: true },
    ];
    const merged = mergeCatalog(LOCAL, upstream);

    expect(merged).toHaveLength(3); // 一条没少
    expect(merged.map((m) => m.id).sort()).toEqual(['glm-5.3', 'kimi-k2.7', 'kimi-k3']);
    const k3 = merged.find((m) => m.id === 'kimi-k3');
    expect(k3?.displayName).toBe('Kimi-K3 官方'); // 上游显示名权威
    expect(k3?.source).toBe('upstream');
  });

  it('⑬ 上游新增的模型被追加，且倍率未知（null）', () => {
    const upstream: CatalogEntry[] = [
      { id: 'new-model', displayName: 'New', family: 'new', tag: null, multiplier: null, source: 'upstream', verified: true, enabled: true },
    ];
    const merged = mergeCatalog(LOCAL, upstream);
    expect(merged).toHaveLength(4);
    expect(merged.map((m) => m.id)).toContain('new-model');
    expect(merged.find((m) => m.id === 'new-model')?.multiplier).toBeNull();
  });

  it('⑭ ★ 合并时保留用户改过的 enabled（tag 不保留：反代决定不了标签，按真实来）', () => {
    /* [v0.4.16 用户拍板] tag 没有「用户改的」概念 —— 这只是反代，标签跟着上游走。
       enabled 仍保留（启停是本地运营决策）。 */
    const tuned: CatalogEntry[] = [
      { ...LOCAL[0], enabled: false, tag: '我手动调的', source: 'manual' as const },
    ];
    const upstream: CatalogEntry[] = [
      { id: 'kimi-k3', displayName: 'Kimi-K3 官方', family: 'kimi', tag: null, multiplier: 1.62, source: 'upstream', verified: true, enabled: true },
    ];
    const merged = mergeCatalog(tuned, upstream);
    const k3 = merged.find((m) => m.id === 'kimi-k3');
    expect(k3?.enabled).toBe(false);
    /* tag 跟随上游 —— 上游无徽标（null），本地手写的标签被覆盖 */
    expect(k3?.tag).toBeNull();
  });

  it('⑭b [v0.4.15] 上游 badge 徽标覆盖 seed 行的过期标签；上游无徽标时清空 seed 标签', () => {
    const local: CatalogEntry[] = [
      { id: 'hy3', displayName: 'Hy3', family: 'hy', tag: '订阅优先', multiplier: 0, source: 'seed', verified: true, enabled: true },
      { id: 'glm-5.2', displayName: 'GLM-5.2', family: 'glm', tag: null, multiplier: 0.79, source: 'seed', verified: true, enabled: true },
    ];
    const upstream: CatalogEntry[] = [
      /* hy3 上游有 badge → 覆盖 seed 的过期标签 */
      { id: 'hy3', displayName: 'Hy3', family: 'hy', tag: '限时免费', multiplier: 0, source: 'upstream', verified: true, enabled: true },
      /* glm-5.2 上游有 badge → 补上 */
      { id: 'glm-5.2', displayName: 'GLM-5.2', family: 'glm', tag: '夜间折扣', multiplier: 0.79, source: 'upstream', verified: true, enabled: true },
    ];
    const merged = mergeCatalog(local, upstream);
    expect(merged.find((m) => m.id === 'hy3')?.tag).toBe('限时免费');
    expect(merged.find((m) => m.id === 'glm-5.2')?.tag).toBe('夜间折扣');
    /* 上游无 badge 的模型 → seed 标签被清空（种子手写的会过期，上游没有就是真没有） */
    const upstreamNoBadge: CatalogEntry[] = [
      { id: 'hy3', displayName: 'Hy3', family: 'hy', tag: null, multiplier: 0, source: 'upstream', verified: true, enabled: true },
    ];
    expect(mergeCatalog(local, upstreamNoBadge).find((m) => m.id === 'hy3')?.tag).toBeNull();
  });

  it('⑱ ★ /v3/config 接口倍率权威：覆盖 seed 行的过期快照（space-bunny 0.03→0.08 实例）', () => {
    const local: CatalogEntry[] = [
      { id: 'space-bunny', displayName: 'Space-Bunny', family: 'space', tag: '限时折扣', multiplier: 0.03, source: 'seed', verified: true, enabled: true },
    ];
    const config: CatalogEntry[] = [
      { id: 'space-bunny', displayName: 'Space-Bunny', family: 'space', tag: null, multiplier: 0.08, source: 'upstream', verified: true, enabled: true },
    ];
    expect(mergeCatalog(local, config).find((m) => m.id === 'space-bunny')?.multiplier).toBe(0.08);
  });

  it('⑲ ★ source=manual（用户手填，历史保留）的倍率不被接口覆盖', () => {
    const local: CatalogEntry[] = [
      { id: 'my-model', displayName: 'My', family: 'my', tag: null, multiplier: 0.5, source: 'manual', verified: true, enabled: true },
    ];
    const config: CatalogEntry[] = [
      { id: 'my-model', displayName: 'My', family: 'my', tag: null, multiplier: 9.99, source: 'upstream', verified: true, enabled: true },
    ];
    expect(mergeCatalog(local, config).find((m) => m.id === 'my-model')?.multiplier).toBe(0.5);
  });

  it('⑮ ★ observed 一路：只被观测到的模型进清单，来源标 observed（不伪装成订阅）', () => {
    const observed = observedToEntries([{ id: 'observed-only', displayName: 'Observed Only' }]);
    const merged = mergeCatalog(LOCAL, [], observed);
    const row = merged.find((m) => m.id === 'observed-only');
    expect(row?.source).toBe('observed');
    expect(merged).toHaveLength(4);
  });

  it('⑯ ★ 同一 id 既 observed 又 upstream → 取更硬的 upstream 来源', () => {
    const observed = observedToEntries([{ id: 'kimi-k3', displayName: null }]);
    const upstream: CatalogEntry[] = [
      { id: 'kimi-k3', displayName: 'Kimi-K3', family: 'kimi', tag: null, multiplier: null, source: 'upstream', verified: true, enabled: true },
    ];
    const merged = mergeCatalog(LOCAL, upstream, observed);
    expect(merged.find((m) => m.id === 'kimi-k3')?.source).toBe('upstream');
  });

  it('⑰ ★ 本地未知倍率（null）可被上游/观测的已知值补齐，但已知值不被覆盖为 null', () => {
    const local: CatalogEntry[] = [
      { id: 'm1', displayName: 'M1', family: 'm', tag: null, multiplier: null, source: 'upstream', verified: true, enabled: true },
    ];
    const observed = observedToEntries([{ id: 'm1', displayName: null }]);
    const merged = mergeCatalog(local, [], observed);
    // observed 也不提供倍率 → 仍为 null（不编造）
    expect(merged.find((m) => m.id === 'm1')?.multiplier).toBeNull();
  });
});
