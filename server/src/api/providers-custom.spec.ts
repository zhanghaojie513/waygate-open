/**
 * 自定义提供商（v1.7.0，protocol='custom'）的服务层行为。
 *
 * 钉的是几件**加一个协议值就会静默错**的事：
 *   ① toItem 的 isOpenai 推导 —— 旧实现「非 anthropic/qoder 即 openai」会把 custom
 *      误判成 WorkBuddy OAuth 形态（configured 恒 false、掩码「未配置」）；
 *   ② 激活/改址**不碰全局设置位** —— settings.upstream.baseUrl 是内置链路的，
 *      被自定义端点覆盖等于 WorkBuddy 的目录拉取悄悄换了目标；
 *   ③ 凭证格式分支 —— custom 收任意 ≥8 位可打印 key（API key 形态随端点），
 *      而 openai 的 ck_ 卫语句必须**继续**拦（回归守卫）；
 *   ④ 手动补模型端点只对 custom 开放（内置三家清单是权威，手填=混入猜测）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersService } from './providers.service';
import { ModelsService } from './models.service';
import { CatalogSyncService } from '../catalog/catalog-sync';
import { fakeWbOauth } from '../proxy/openai-upstream/wb-oauth.harness';
import type { ModelProbeService } from '../catalog/probe';
import type { RelayConfigService } from '../config/config.service';
import type { Db } from '../store/db';

let db: Db;
let dir: string;
let repo: ProvidersRepository;
let catalog: ModelCatalogRepository;
let svc: ProvidersService;
let models: ModelsService;
let configSet: { baseUrl: string[]; key: string[] };
let probes: Array<{ model: string; key: string; baseUrl: string; url?: string }>;

function makeService() {
  configSet = { baseUrl: [], key: [] };
  const config = {
    get: () => ({ upstream: { baseUrl: 'https://copilot.tencent.com' } }),
    get upstreamKey() {
      return 'ck_seed0000000000.zzz';
    },
    setUpstreamKey: (k: string) => {
      configSet.key.push(k);
    },
    applyInternal: (entries: Array<{ key: string; value: unknown }>) => {
      configSet.baseUrl.push(String(e2s(entries)));
      function e2s(es: typeof entries): string {
        return String(es[0]?.value ?? '');
      }
    },
    upstreamConfigured: () => true,
  } as unknown as RelayConfigService;
  const sync = { syncProviderOnEnable: async () => undefined } as unknown as CatalogSyncService;
  probes = [];
  const probe = {
    probe: async (model: string, key?: string, baseUrl?: string, url?: string) => {
      probes.push({ model, key: key ?? '', baseUrl: baseUrl ?? '', url });
      return { id: model, ok: true, upstreamCode: null, httpStatus: 200, reason: null };
    },
  };
  svc = new ProvidersService(
    repo, config, sync, probe as unknown as ModelProbeService, prefs, catalog,
    undefined, fakeWbOauth('oauth-access-token-test', 'uidseed0000'),
  );
  svc.setProvidersDirForTest(join(dir, 'providers'));
  models = new ModelsService(config, catalog, probe as unknown as ModelProbeService, sync, repo);
  return { config };
}

let prefs: ProviderModelPrefsRepository;

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.exec(readFileSync(join(__dirname, '..', 'store', 'schema.sql'), 'utf8').replace(/^PRAGMA user_version.*$/m, ''));
  dir = mkdtempSync(join(tmpdir(), 'prov-custom-'));
  repo = new ProvidersRepository(db);
  catalog = new ModelCatalogRepository(db);
  prefs = new ProviderModelPrefsRepository(db);
  makeService();
});

afterEach(() => {
  (db as unknown as Database.Database).close();
});

const CUSTOM = { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', credential: 'sk-test1234567890abcdef' };

describe('providers · custom 创建', () => {
  it('★ 创建成功：行 + .key 文件 + toItem 三件套（protocol/configured/mask）', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: false });
    expect(item.protocol).toBe('custom'); // ← 旧 toItem 的三元兜底会把它折成 'openai'
    expect(item.configured).toBe(true); // ← 旧 isOpenai 推导会去看 OAuth 槽，恒 false
    expect(item.credentialMask).not.toBe('未配置');
    expect(item.credentialMask).toContain('••••');
    const key = readFileSync(join(dir, 'providers', `${item.id}.key`), 'utf8');
    expect(key).toBe(CUSTOM.credential);
  });

  it('★ chatPath 落库（非标布局覆盖），非法值 400', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', chatPath: '/openai/deployments/x/chat/completions' });
    expect(item.chatPath).toBe('/openai/deployments/x/chat/completions');
    expect(() => svc.create({ ...CUSTOM, protocol: 'custom', name: 'x2', chatPath: 'v1/chat' })).toThrow(/chatPath/);
    expect(() => svc.create({ ...CUSTOM, protocol: 'custom', name: 'x3', chatPath: '/a?b=1' })).toThrow(/chatPath/);
  });

  it('空凭证可先建后填（configured=false，不落空文件）', () => {
    const { item } = svc.create({ name: '先建', baseUrl: CUSTOM.baseUrl, credential: '', protocol: 'custom' });
    expect(item.configured).toBe(false);
    expect(item.credentialMask).toBe('未配置');
  });

  it('坏 key 400：过短的几乎必是手滑', () => {
    expect(() => svc.create({ ...CUSTOM, protocol: 'custom', name: '短key', credential: 'sk-123' })).toThrow(/API Key/);
  });

  it('★ 回归守卫：openai 仍然拒绝手填 ck_（custom 的放行不许把旧闸弄松）', () => {
    expect(() => svc.create({ ...CUSTOM, protocol: 'openai', name: 'wb' })).toThrow(/ck_/);
  });

  it('patch 换 key：写文件、不进全局位', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: true });
    configSet.key.length = 0;
    const after = svc.patch(item.id, { credential: 'sk-newkey000000000000xyz' });
    expect(after.configured).toBe(true);
    expect(readFileSync(join(dir, 'providers', `${item.id}.key`), 'utf8')).toBe('sk-newkey000000000000xyz');
    expect(configSet.key).toEqual([]); // ★ 不写 config.setUpstreamKey
  });
});

describe('providers · custom 激活隔离', () => {
  it('★ 激活 custom 不动 settings.upstream.baseUrl（全局位是内置链路的）', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: false });
    configSet.baseUrl.length = 0;
    svc.activate(item.id);
    expect(configSet.baseUrl).toEqual([]); // ★ 唯一断言：一次都不能写
  });

  it('对照：激活 openai 仍写全局位（既有行为不被 custom 分支误伤）', () => {
    repo.create({ id: 'p_wb1', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: false, protocol: 'openai', credKind: 'static' });
    configSet.baseUrl.length = 0;
    svc.activate('p_wb1');
    expect(configSet.baseUrl).toEqual(['https://copilot.tencent.com']);
  });
});

describe('providers · custom 试通', () => {
  it('★ 探针拿到智能解析后的完整 URL（试通与转发同一条 URL 规则）', async () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom' });
    await svc.test(item.id, undefined, 'deepseek-chat');
    expect(probes[0]).toMatchObject({
      model: 'deepseek-chat',
      key: CUSTOM.credential,
      url: 'https://api.deepseek.com/v1/chat/completions',
    });
  });

  it('base 以 /v1 结尾 → 拼 /chat/completions', async () => {
    const { item } = svc.create({ ...CUSTOM, name: '带v1', baseUrl: 'https://api.x.com/v1', protocol: 'custom' });
    await svc.test(item.id, undefined, 'm');
    expect(probes[0]?.url).toBe('https://api.x.com/v1/chat/completions');
  });

  it('★ 探针目标回退到它自己清单里的模型（hunyuan-lite 在自定义端点必 404，会误诊成「被拒」）', async () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: true });
    /* 建好即同步会拉清单 —— 手动种两个模型（一个停用），回退应取第一个启用的。 */
    catalog.seed(item.id, [
      { id: 'mimo-off', displayName: '停用模型', tag: null, multiplier: null },
      { id: 'mimo-on', displayName: '启用模型', tag: null, multiplier: null },
    ] as never);
    catalog.setEnabled(item.id, 'mimo-off', false);
    await svc.test(item.id, undefined, undefined);
    expect(probes[0]?.model).toBe('mimo-on');
    /* 清单空 → 回落 hunyuan-lite（那次 404 如实提示「先拉清单」）。 */
    catalog.replaceSync(item.id, []);
    await svc.test(item.id, undefined, undefined);
    expect(probes[1]?.model).toBe('hunyuan-lite');
  });
});

describe('models · 手动补模型（custom 专属）', () => {
  it('custom 家：manual 行入库，multiplier=null（不自标定）', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: true });
    const r = models.addManualModel(item.id, { id: 'deepseek-reasoner', displayName: 'R1' });
    expect(r).toEqual({ id: 'deepseek-reasoner', added: true });
    const rows = catalog.all(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'deepseek-reasoner', display_name: 'R1', source: 'manual', multiplier: null, enabled: 1 });
  });

  it('重复添加幂等（added=false，不报错）', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: true });
    models.addManualModel(item.id, { id: 'm1' });
    expect(models.addManualModel(item.id, { id: 'm1' })).toEqual({ id: 'm1', added: false });
  });

  it('★ 内置三家拒绝（清单以上游为准）', () => {
    repo.create({ id: 'p_wb9', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: true, protocol: 'openai', credKind: 'static' });
    expect(() => models.addManualModel('p_wb9', { id: 'm' })).toThrow(/自定义提供商/);
  });

  it('坏 id 400；不存在的提供商 404', () => {
    const { item } = svc.create({ ...CUSTOM, protocol: 'custom', activate: true });
    expect(() => models.addManualModel(item.id, { id: '' })).toThrow(/id/);
    expect(() => models.addManualModel('p_nope', { id: 'm' })).toThrow(/不存在/);
  });
});
