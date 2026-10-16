/**
 * CatalogSyncService 单测（[v1.5.0] 纯接口口径：目录 = 上游清单接口，替换式）。
 *
 * 覆盖「写错了会静默坏掉」的地方：
 *   ① 上游目录拉到 → 该清单**替换**本分区（旧行清掉，manual 保留）
 *   ② 上游失败 → **保留旧目录不动**（不倒退、不回落种子/observed）
 *   ③ observed 机制已废除：请求过的模型不再自动进目录（含 MiniMax 幽灵行事故的根治）
 *   ④ 拉到的清单就是全部（不并种子、不并 observed）——"客户端没给就是没有"
 *   ⑤ 冷却中 → 429；未配置凭证 → 400
 *   ⑥ manual 行在替换中保留（用户显式登记的，自动流程不冲掉）
 *   ⑦ /v3/config 倍率权威；其降级（models:null）不拦替换（倍率沿清单 null/旧值）
 *   ⑧ MiniMax（anthropic）例外：上游无清单端点 → 种子落库（唯一合法种子路径）
 *
 * 策略：内存库 + 真实 schema + 真实仓库；`globalThis.fetch` 用替身（不真打上游、不烧积分）。
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogSyncService } from './catalog-sync';
import { ModelProbeService } from './probe';
import { fakeWbOauth, fakeWbOauthMissing } from '../proxy/openai-upstream/wb-oauth.harness';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { seedDefaultModels } from './seed-models';
import { runMigrations } from '../store/migrate';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError } from '../common/errors';

let db: Database.Database;
let catalog: ModelCatalogRepository;
let requests: RequestsRepository;
let prefs: ProviderModelPrefsRepository;
/** [v0.5.1] 统一测试提供商 id（目录按提供商分区）。 */
const PID = 'p_test';

function makeConfig(key = 'ck_current_current_current_key'): RelayConfigService {
  return {
    get: () => ({ upstream: { baseUrl: 'https://copilot.example.com' } }),
    upstreamKey: key,
    upstreamConfigured: () => key.length > 0,
  } as unknown as RelayConfigService;
}

function makeSync(cfg: RelayConfigService): CatalogSyncService {
  const probe = new ModelProbeService(cfg);
  const providers = new ProvidersRepository(db);
  if (!providers.findById(PID)) {
    providers.create({ id: PID, name: 'TestUpstream', baseUrl: 'https://copilot.example.com', active: true });
  }
  // 间隔传 0：这些用例只关心落库语义，不关心契约要求的 200ms 节流
  /* [v1.6.11] 第 7 参 = WorkBuddy OAuth 替身（openai 凭证已改走 OAuth）。 */
  return new CatalogSyncService(cfg, catalog, probe, prefs, 0, providers, fakeWbOauth('ck_current_current_current_key'));
}

/**
 * 造上游 fetch 替身：目录 GET 返回给定信封，chat POST 返回 200。
 * `configBody` 是 /v3/config 的响应体；null → 返回 `models:null`（身份被上游降级）。
 */
function stubUpstream(catalogBody: unknown | null, catalogStatus = 200, configBody: unknown | null = null) {
  return vi.fn(async (url: string) => {
    if (url.includes('/v2/enterprises/personal/models')) {
      if (catalogBody === null) return new Response('nope', { status: catalogStatus });
      return new Response(JSON.stringify(catalogBody), { status: catalogStatus, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v3/config')) {
      return new Response(JSON.stringify(configBody ?? { code: 0, msg: 'OK', data: { models: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // chat/completions 探测
    return new Response('', { status: 200 }) as unknown as Response;
  });
}

function seedRequest(model: string, status = 200) {
  requests.log({
    ts: Date.now(),
    traceId: `t-${Math.random().toString(36).slice(2)}`,
    clientId: 'k1',
    client: 'C',
    clientRule: 2,
    keyId: null,
    keyHint: null,
    model,
    modelDisplay: null,
    status,
    upstreamCode: null,
    ms: 1,
    queuedMs: 0,
    firstByteMs: 1,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    cachedTokens: 0,
    credits: 0,
    stream: true,
    retryCount: 0,
    note: '',
    remoteIp: null,
    ua: null,
    requestBody: null,
    responseBody: null,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  catalog = new ModelCatalogRepository(db);
  /* schema 静态种子已移除（provider_id NOT NULL）——按生产时序补：建提供商行 + 种内置清单。 */
  const seedProviders = new ProvidersRepository(db);
  if (!seedProviders.findById(PID)) {
    seedProviders.create({ id: PID, name: 'TestUpstream', baseUrl: 'https://copilot.example.com', active: true });
  }
  seedDefaultModels(catalog, PID);
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  prefs = new ProviderModelPrefsRepository(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('CatalogSyncService.refresh（v1.5.0 替换式）', () => {
  it('① 上游清单 ≈ 目录全集：拉到的在、没拉到的不在（种子不兜底）', async () => {
    vi.stubGlobal(
      'fetch',
      stubUpstream({
        code: 0,
        msg: 'OK',
        requestId: 'x',
        data: [{ id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' }, { id: 'brand-new', name: 'Brand New' }],
      }),
    );
    const sync = makeSync(makeConfig());

    const result = await sync.refresh();

    expect(result.pulled).toBe(true);
    expect(result.source).toBe('upstream');
    const ids = catalog.all(PID).map((r) => r.id);
    expect(ids).toContain('kimi-k2.7');
    expect(ids).toContain('brand-new');
    /* 替换式：种子行里**没在本轮清单中的**被清掉（"客户端没给就是没有"）。 */
    expect(ids).not.toContain('space-bunny');
    expect(catalog.all(PID).find((r) => r.id === 'brand-new')?.source).toBe('upstream');
    // 新模型倍率未知（上游不给倍率）——绝不编造
    expect(catalog.all(PID).find((r) => r.id === 'brand-new')?.multiplier).toBeNull();
  });

  it('② ★ 上游失败 → 保留旧目录原地不动（不倒退、不清空、不回落种子）', async () => {
    const before = catalog.all(PID).map((r) => r.id).sort();
    seedRequest('observed-x');
    vi.stubGlobal('fetch', stubUpstream(null, 404));
    const sync = makeSync(makeConfig());

    const result = await sync.refresh();

    expect(result.pulled).toBe(false);
    expect(result.source).not.toBe('upstream');
    /* 旧目录一条不丢、一条不加（observed 也不再并入）。 */
    expect(catalog.all(PID).map((r) => r.id).sort()).toEqual(before);
    expect(catalog.all(PID).find((r) => r.id === 'observed-x')).toBeUndefined();
  });

  it('③ ★ observed 机制已废除：请求过的模型不会自动进目录（幽灵行事故根治）', async () => {
    seedRequest('ok-model', 200);
    seedRequest('failed-model', 502);
    vi.stubGlobal('fetch', stubUpstream(null, 404));
    await makeSync(makeConfig()).refresh();

    expect(catalog.all(PID).find((r) => r.id === 'ok-model')).toBeUndefined();
    expect(catalog.all(PID).find((r) => r.id === 'failed-model')).toBeUndefined();
  });

  it('③b ★ 历史 observed 行被 purgeObserved 清掉（启动幂等清理）', () => {
    catalog.mergeSync(PID, [{ id: 'legacy-obs', displayName: 'Legacy', source: 'observed', multiplier: null, tag: null }]);
    expect(catalog.all(PID).find((r) => r.id === 'legacy-obs')).toBeDefined();

    const purged = catalog.purgeObserved();

    expect(purged).toBe(1);
    expect(catalog.all(PID).find((r) => r.id === 'legacy-obs')).toBeUndefined();
  });

  it('⑥a ★ 用户的停用选择跨替换存活（v1.5.1 回归网：先 DELETE 再 INSERT 会重置 enabled）', async () => {
    catalog.setEnabled(PID, 'kimi-k2.7', false); // 用户手动停用
    db.prepare("UPDATE model_catalog SET source = 'upstream' WHERE id = ?").run('kimi-k2.7');
    vi.stubGlobal('fetch', stubUpstream({ data: [{ id: 'kimi-k2.7', name: 'Kimi' }, { id: 'new-one', name: 'New' }] }));
    const sync = makeSync(makeConfig());

    await sync.refresh();

    const rows = catalog.all(PID);
    expect(rows.find((r) => r.id === 'kimi-k2.7')?.enabled).toBe(0); // ★ 停用被保留
    expect(rows.find((r) => r.id === 'new-one')?.enabled).toBe(1); // 新模型默认启用
  });

  it('⑥ ★ manual 行在替换中保留（用户显式登记的，自动流程不冲掉；倍率也不被接口覆盖）', async () => {
    catalog.setEnabled(PID, 'kimi-k2.7', false);
    db.prepare("UPDATE model_catalog SET multiplier = 0, source = 'manual' WHERE id = ?").run('kimi-k2.7');
    vi.stubGlobal('fetch', stubUpstream({ data: [{ id: 'other-model', name: 'Other' }] }));
    const sync = makeSync(makeConfig());

    await sync.refresh();

    const manual = catalog.all(PID).find((r) => r.id === 'kimi-k2.7');
    expect(manual?.source).toBe('manual');
    expect(manual?.multiplier).toBe(0);
    expect(manual?.enabled).toBe(0);
  });

  it('⑥b ★ 实测结论（verified/last_verified_at）跨替换存活（v1.5.3 回归网）', async () => {
    /* 模拟：手动刷新实测过（verified=1），随后 safeDailySync 的 replaceSync 不应抹掉它。 */
    db.prepare("UPDATE model_catalog SET source='upstream' WHERE provider_id=? AND id=?").run(PID, 'kimi-k2.7');
    catalog.setVerified(PID, 'kimi-k2.7', true);
    catalog.setVerified(PID, 'unverified-x', false);
    vi.stubGlobal('fetch', stubUpstream({ data: [{ id: 'kimi-k2.7', name: 'Kimi' }, { id: 'brand-new', name: 'New' }] }));
    await makeSync(makeConfig()).refresh();

    const rows = catalog.all(PID);
    const kept = rows.find((r) => r.id === 'kimi-k2.7');
    expect(kept?.verified).toBe(1); // ★ 实测结论被保留
    expect(kept?.last_verified_at).not.toBeNull();
    expect(rows.find((r) => r.id === 'brand-new')?.verified).toBe(1); // 本轮实测通过（stub 全 200）
  });

  it('⑦ ★ /v3/config 倍率权威：覆盖旧快照（0.03→0.08），并如实上报口径', async () => {
    db.prepare('UPDATE model_catalog SET multiplier = 0.03 WHERE id = ?').run('space-bunny');
    vi.stubGlobal(
      'fetch',
      stubUpstream(
        { data: [{ id: 'space-bunny', name: 'Space-Bunny' }] },
        200,
        { code: 0, data: { models: [{ id: 'space-bunny', name: 'Space-Bunny', credits: 'x0.08 credits' }] } },
      ),
    );
    const sync = makeSync(makeConfig());

    const result = await sync.refresh();

    expect(result.configPulled).toBe(true);
    expect(result.multipliersUpdated).toBeGreaterThanOrEqual(1);
    expect(catalog.all(PID).find((r) => r.id === 'space-bunny')?.multiplier).toBe(0.08);
  });

  it('⑦b ★ /v3/config 降级（models:null）不拦替换：清单落库、倍率留空', async () => {
    vi.stubGlobal('fetch', stubUpstream({ data: [{ id: 'space-bunny', name: 'Space-Bunny' }] }));
    const sync = makeSync(makeConfig());

    const result = await sync.refresh();

    expect(result.configPulled).toBe(false);
    expect(result.pulled).toBe(true);
    expect(catalog.all(PID).find((r) => r.id === 'space-bunny')?.multiplier).toBeNull();
  });

  it('①b ★ 接口返回空列表 → 视为拉取失败，保留旧目录（防上游异常清空）', async () => {
    const before = catalog.all(PID).map((r) => r.id).sort();
    vi.stubGlobal('fetch', stubUpstream({ data: [] }));
    const sync = makeSync(makeConfig());

    const result = await sync.refresh();

    /* 空清单在上游多半意味着异常（而非"真没有模型"）—— 拉取层 parseUpstreamModels
       把 [] 判为无效（返回 null），于是保留旧目录。这是安全侧默认。 */
    expect(result.pulled).toBe(false);
    expect(catalog.all(PID).map((r) => r.id).sort()).toEqual(before);
  });

  it('①c ★ 只有 manual 行时的替换：manual 留下、自动行清空', async () => {
    catalog.mergeSync(PID, [{ id: 'my-custom', displayName: 'Custom', source: 'manual', multiplier: 5, tag: null }]);
    vi.stubGlobal('fetch', stubUpstream({ data: [{ id: 'from-api', name: 'From API' }] }));
    const sync = makeSync(makeConfig());

    await sync.refresh();

    const ids = catalog.all(PID).map((r) => r.id);
    expect(ids).toContain('my-custom'); // manual 保留
    expect(ids).toContain('from-api');
    expect(ids).not.toContain('kimi-k2.7'); // 旧种子行被清（不在接口清单里）
  });

  it('⑤ 冷却中 → 429（同一分钟内只生效一次）', async () => {
    vi.stubGlobal('fetch', stubUpstream({ data: [] }));
    const sync = makeSync(makeConfig());
    await sync.refresh();

    await expect(sync.refresh()).rejects.toMatchObject({ httpStatus: 429 });
  });

  it('⑤b 未导入授权 → 400 upstream_credential_missing', async () => {
    /* [v1.6.11] openai 凭证来自 OAuth 槽：用「未授权」替身复现该分支。 */
    const cfg = makeConfig('');
    const probe = new ModelProbeService(cfg);
    const providers = new ProvidersRepository(db);
    const sync = new CatalogSyncService(cfg, catalog, probe, prefs, 0, providers, fakeWbOauthMissing());
    await expect(sync.refresh()).rejects.toBeInstanceOf(RelayHttpError);
  });
});

/**
 * 提供商切换的启停偏好（2026-10-09 · 迁移 008）。
 *
 * 场景：用户在提供商 A 下停用了两个模型；切到 B（A 的选择被快照，目录清空重建）；
 * 再切回 A —— **A 的启停选择必须自动恢复**。
 */
describe('CatalogSyncService.syncProviderOnEnable · 多生效分区同步', () => {
  const CATALOG_A = { code: 0, msg: 'OK', requestId: 'x', data: [
    { id: 'm-keep', name: 'Keep' }, { id: 'm-off-1', name: 'Off One' }, { id: 'm-off-2', name: 'Off Two' },
  ] };
  const CATALOG_B = { code: 0, msg: 'OK', requestId: 'x', data: [{ id: 'other', name: 'Other' }] };

  it('★ A 启用时同步 → 只写 A 的分区；启用 B（A 不停用）→ B 分区拿到自己的清单，A 的原样保留', async () => {
    vi.stubGlobal('fetch', stubUpstream(CATALOG_A));
    await makeSync(makeConfig()).refresh();
    catalog.setEnabled(PID, 'm-off-1', false);

    const providers = new ProvidersRepository(db);
    providers.create({ id: 'p_b', name: 'Upstream-B', baseUrl: 'https://b.example.com', active: true });
    vi.stubGlobal('fetch', stubUpstream(CATALOG_B));
    await makeSync(makeConfig()).syncProviderOnEnable('p_b');

    expect(catalog.all('p_b').map((r) => r.id)).toEqual(['other']);
    const byId = new Map(catalog.all(PID).map((r) => [r.id, r.enabled]));
    expect(byId.get('m-keep')).toBe(1);
    expect(byId.get('m-off-1')).toBe(0);
  });

  it('★ 启停偏好恢复：启用时把历史快照应用回该分区（上游下线的模型 UPDATE 落空不报错）', async () => {
    vi.stubGlobal('fetch', stubUpstream(CATALOG_A));
    await makeSync(makeConfig()).refresh();
    catalog.setEnabled(PID, 'm-off-1', false);
    prefs.save(PID, catalog.all(PID).map((r) => ({ modelId: r.id, enabled: r.enabled === 1 })));

    catalog.clearProvider(PID);
    vi.stubGlobal('fetch', stubUpstream(CATALOG_A));
    await makeSync(makeConfig()).syncProviderOnEnable(PID);
    const byId = new Map(catalog.all(PID).map((r) => [r.id, r.enabled]));
    expect(byId.get('m-off-1')).toBe(0);
    expect(byId.get('m-keep')).toBe(1);
  });
});
