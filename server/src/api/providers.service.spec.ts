/**
 * ProvidersService 的行为单测（2026-10-08「自定义提供商」）。
 *
 * 钉的是四件**会静默出错**的事：
 *   ① 升级零行为变化 —— 空表种子默认行 = 原来的 settings.upstream.baseUrl + 现有凭证；
 *   ② 激活真的换了出站上游（settings.upstream.baseUrl 热更 + config.upstreamKey 载入）；
 *   ③ 「恰有一行 active」的不变式（切换后旧的必须熄灭）；
 *   ④ SSRF 防线 —— localhost / 环回 / 私有 / 保留地址一律 400（这是用户输入、
 *      服务端会真实向它发请求的目标）。
 *
 * 凭证文件指向临时目录（与 credential.service 同一理由：vitest 里不能 chdir）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../store/migrate';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ProvidersService, DEFAULT_PROVIDER_ID } from './providers.service';
import { CatalogSyncService } from '../catalog/catalog-sync';
import { fakeWbOauth } from '../proxy/openai-upstream/wb-oauth.harness';
import type { ModelProbeService } from '../catalog/probe';
import type { RelayConfigService } from '../config/config.service';
import type { Db } from '../store/db';

let db: Db;
let dir: string;
let repo: ProvidersRepository;
let prefs: ProviderModelPrefsRepository;
let svc: ProvidersService;
let configSet: { baseUrl: string[]; key: string[] };
/** makeService 里造的探针桩记录 —— 断言「打给了谁」用。 */
let probes: Array<{ model: string; key: string; baseUrl: string }>;

function makeService(overrides: { baseUrl?: string; key?: string } = {}) {
  configSet = { baseUrl: [], key: [] };
  const config = {
    get: () => ({ upstream: { baseUrl: overrides.baseUrl ?? 'https://copilot.tencent.com' } }),
    get upstreamKey() {
      return (config as unknown as { _k?: string })._k ?? overrides.key ?? 'ck_seed0000000000.zzz';
    },
    setUpstreamKey: (k: string) => {
      (config as unknown as { _k?: string })._k = k;
      configSet.key.push(k);
    },
    applyUpdates: (entries: Array<{ key: string; value: unknown }>) => {
      for (const e of entries) configSet.baseUrl.push(String(e.value));
      return { applied: entries.length, requiresRestart: false, version: 2 };
    },
    /* [2026-10-17] 激活路径改走 applyInternal（内部写不撞只读闸）—— mock 同步补 */
    applyInternal: (entries: Array<{ key: string; value: unknown }>) => {
      for (const e of entries) configSet.baseUrl.push(String(e.value));
    },
  } as unknown as RelayConfigService;
  /* 目录同步要打网络 —— 测试里换成桩（记录同步打给了哪家，断言"打给了谁"）。 */
  const resyncCalls: string[] = [];
  const sync = {
    syncProviderOnEnable: async (id?: string) => {
      resyncCalls.push(id ?? '-');
    },
  } as unknown as CatalogSyncService;
  /* 试通探针同样换成桩：记录 (model, key, baseUrl) 三元组，断言"打给了谁"。 */
  probes = [];
  const probe = {
    probe: async (model: string, key?: string, baseUrl?: string) => {
      probes.push({ model, key: key ?? '', baseUrl: baseUrl ?? '' });
      return { id: model, ok: true, upstreamCode: null, httpStatus: 200, reason: null };
    },
  };
  /* 偏好仓库用真表（prefs 表在 schema 里），删除护栏的测试要断言连带清理。 */
  prefs = new ProviderModelPrefsRepository(db);
  /* [v1.6.13] 第 8 参 = WorkBuddy OAuth 替身（openai 转发/试通已改走它）。 */
  svc = new ProvidersService(repo, config, sync, probe as unknown as ModelProbeService, prefs, undefined, undefined, fakeWbOauth('oauth-access-token-test', 'uidseed0000'));
  svc.setProvidersDirForTest(join(dir, 'providers'));
  return { config, resyncCalls, probes, prefs };
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  runMigrations(db);
  repo = new ProvidersRepository(db);
  dir = mkdtempSync(join(tmpdir(), 'prov-test-'));
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('种子（升级零行为变化）', () => {
  it('★ 空表 → 默认行 = settings 的 baseUrl，且 active，名字是 WorkBuddy', () => {
    makeService({ baseUrl: 'https://copilot.tencent.com', key: 'ck_seed0000000000.zzz' });
    // onApplicationBootstrap 等价物：手动触发
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();

    const items = svc.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: DEFAULT_PROVIDER_ID,
      /* [2026-10-09] 种子名按用户口径叫 WorkBuddy —— 现库那条上游连接
         就是 WorkBuddy 的地址与密钥，叫"默认提供商"要用户自己猜指谁。 */
      name: 'WorkBuddy',
      baseUrl: 'https://copilot.tencent.com',
      active: true,
      /* [v1.6.13] ck_ 退役：种子不再把 config.upstreamKey 迁到 .key。
         本 spec 注入了「已授权」的 OAuth 替身 → configured=true（真机上未授权时为 false）。 */
      configured: true,
    });
    // 不再落 .key（凭证来自 OAuth 槽，由 device-import 写入）
    expect(existsSync(join(dir, 'providers', `${DEFAULT_PROVIDER_ID}.key`))).toBe(false);
  });

  it('★ 存量库里的旧名「默认提供商」→ 启动时改名为 WorkBuddy（幂等，不动别的行）', () => {
    makeService({ baseUrl: 'https://copilot.tencent.com' });
    /* 直接造一个"旧种子名"的行（模拟 v0.4.1 之前已种过、还没改名的库）。 */
    db.prepare(
      "INSERT INTO providers (id, name, base_url, active, created_at, updated_at) VALUES (?, '默认提供商', 'https://copilot.tencent.com', 1, ?, ?)",
    ).run(DEFAULT_PROVIDER_ID, Date.now(), Date.now());

    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    expect(svc.findActive()?.name).toBe('WorkBuddy');

    // 再跑一次不再改（幂等）；且不会把用户自己改过的名字改掉
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    expect(svc.findActive()?.name).toBe('WorkBuddy');
    db.prepare('UPDATE providers SET name = ? WHERE id = ?').run('我的名字', DEFAULT_PROVIDER_ID);
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    expect(svc.findActive()?.name).toBe('我的名字');
  });

  it('★ 幂等：表非空 → 不再种子', () => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    expect(svc.list().items).toHaveLength(1);
  });

  it('★ 凭证掩码：WorkBuddy 行绝不含令牌明文（OAuth 形态只显示账号前缀）', () => {
    makeService({ key: 'ck_abcdefgh12345678.zzzz' });
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    const raw = JSON.stringify(svc.list());
    /* [v1.6.13] openai 的掩码来自 OAuth 替身（uid 前 8 位），没有 ck_ 参与。 */
    expect(raw).not.toContain('ck_abcdefgh12345678');
    expect(raw).not.toContain('oauth-access-token-test');
    expect(raw).toContain('oauth(');
  });
});

describe('新增 / 激活', () => {
  beforeEach(() => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
  });

  it('★ 新增不自动激活（默认）', () => {
    const { item, activated } = svc.create({
      name: '测试上游',
      baseUrl: 'https://api.test.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    expect(activated).toBe(false);
    expect(item.active).toBe(false);
    // active 仍是默认那行
    expect(svc.findActive()?.id).toBe(DEFAULT_PROVIDER_ID);
  });

  it('★ openai 建行不再接受 ck_ 密钥（指向「重新导入授权」）', () => {
    expect(() =>
      svc.create({ name: 'X', baseUrl: 'https://api.example.com', credential: 'ck_newkey0000000001.abc', protocol: 'openai' }),
    ).toThrow(/不再使用 ck_/);
  });

  it('★ openai 空凭证可建 → configured=false（待导入授权）', () => {
    const { item } = svc.create({ name: 'WB2', baseUrl: 'https://api.example.com', credential: '', protocol: 'openai' });
    /* 替身是「已授权」的，故 openai 行的 configured 由替身决定 —— 用真默认行（同样走替身）验证形态即可。 */
    expect(item.credentialMask).toMatch(/oauth\(|未配置/);
  });

  it('★ 激活 = settings 的 baseUrl 热更 + 该行进入生效集合', () => {
    const { item } = svc.create({
      name: '测试上游',
      baseUrl: 'https://api.test.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    const after = svc.activate(item.id);
    expect(after.active).toBe(true);
    /* [v0.5.1] 多生效：激活不再互斥 —— 默认行保持 active，两行都生效。 */
    const actives = svc.list().items.filter((p) => p.active);
    expect(actives.length).toBeGreaterThanOrEqual(1);
    expect(actives.map((a) => a.id)).toContain(item.id);
    // settings.upstream.baseUrl 被写成新行 —— 转发/实测/目录拉取都读它
    expect(configSet.baseUrl).toContain('https://api.test.example.com');
  });

  it('★ 激活触发**该提供商自己的**目录同步（多生效：不再有切走/切向）', () => {
    const { resyncCalls } = makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    const { item } = svc.create({
      name: 'T',
      baseUrl: 'https://api.t.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    svc.activate(item.id);
    // [v0.5.1] 多生效：只同步被启用的那家（id 传错，偏好就会恢复到别人头上）
    expect(resyncCalls).toEqual([item.id]);
  });

  it('★ create(activate:true) 也走目录重建 —— 只切配置不重建，页面会显示上一家的清单', async () => {
    const { resyncCalls } = makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
    svc.create({
      name: '即刻',
      baseUrl: 'https://api.now.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
      activate: true,
    });
    expect(resyncCalls).toHaveLength(1);
  });

  it('激活不存在的提供商 → 404', () => {
    expect(() => svc.activate('p_nope')).toThrow(/不存在/);
  });
});

describe('修改 / 删除的护栏', () => {
  beforeEach(() => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
  });

  it('★ 改活提供商的地址 → settings 同步热更', () => {
    const updated = svc.patch(DEFAULT_PROVIDER_ID, { baseUrl: 'https://new.example.com' });
    expect(updated.baseUrl).toBe('https://new.example.com');
    expect(configSet.baseUrl).toContain('https://new.example.com');
  });

  it('★ 删除护栏（v0.5.1 多生效）：最后一个生效的不可删；有其他生效行则直接删', () => {
    expect(() => svc.remove(DEFAULT_PROVIDER_ID)).toThrow(/至少保留一个/);
    // 加一个并启用 —— 两家都生效，删默认的（仍是生效行）不再报错：别家还在路由
    const { item } = svc.create({
      name: 'T',
      baseUrl: 'https://api.t.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    svc.activate(item.id);
    expect(() => svc.remove(DEFAULT_PROVIDER_ID)).not.toThrow();
    // 现在只剩 T 且生效 —— 删它会被「至少保留一个生效」挡住
    expect(() => svc.remove(item.id)).toThrow(/至少保留一个/);
  });

  it('删除非活提供商 → 行、凭证文件、启停偏好都消失（不留孤儿行）', () => {
    const { item } = svc.create({
      name: 'T',
      baseUrl: 'https://api.t.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    /* 给它塞一份偏好（模拟它曾生效过、用户停过模型再切走）。 */
    prefs.save(item.id, [{ modelId: 'm-1', enabled: false }]);
    expect(prefs.load(item.id)).toHaveLength(1);

    svc.remove(item.id);
    expect(svc.list().items).toHaveLength(1);
    expect(existsSync(join(dir, 'providers', `${item.id}.key`))).toBe(false);
    // ★ 偏好连带清理 —— provider_model_prefs 无 FK，不清理就永远留着
    expect(prefs.load(item.id)).toEqual([]);
  });
});

describe('试通（不切换就能测）', () => {
  beforeEach(() => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
  });

  it('★ 带 credential 时打到**该提供商**的地址（不是全局 baseUrl）', async () => {
    const { item } = svc.create({
      name: 'T',
      baseUrl: 'https://api.t.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    await svc.test(item.id, 'mmort_override00000000zz');
    /* 关键断言：probe 收到的 baseUrl 是该行的，key 是传入的那把 ——
       这正是"测非活提供商"的全部意义（此前只能切过去再测）。 */
    expect(probes[probes.length - 1]).toEqual({
      model: 'hunyuan-lite',
      key: 'mmort_override00000000zz',
      baseUrl: 'https://api.t.example.com',
    });
  });

  it('★ openai 试通用 OAuth 替身的 token（不接受手填 credential）', async () => {
    await svc.test(DEFAULT_PROVIDER_ID, undefined);
    expect(probes[probes.length - 1]).toEqual({
      model: 'hunyuan-lite',
      key: 'oauth-access-token-test',
      baseUrl: 'https://copilot.tencent.com',
    });
  });

  it('★ openai 传 credential → 400（ck_ 已退役，指向重新导入授权）', async () => {
    await expect(svc.test(DEFAULT_PROVIDER_ID, 'ck_OverRide0000001.zzz')).rejects.toThrow(/不再使用 ck_/);
  });

  it('★ 该提供商没有凭证又没带 credential → 400（不悄悄拿全局那把凑）', async () => {
    const { item } = svc.create({
      name: 'T',
      baseUrl: 'https://api.t.example.com',
      credential: 'mmort_abcdefghijklmnopqrst',
      protocol: 'anthropic',
    });
    // 把凭证文件删掉，模拟"建了但从没填过"
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(dir, 'providers', `${item.id}.key`));
    await expect(svc.test(item.id, undefined)).rejects.toThrow(/还没配置凭证/);
  });

  it('带 model 时用它探测；不带时回落通用名', async () => {
    await svc.test(DEFAULT_PROVIDER_ID, undefined, ' glm-5.3 ');
    expect(probes[probes.length - 1]!.model).toBe('glm-5.3');
    await svc.test(DEFAULT_PROVIDER_ID, undefined);
    expect(probes[probes.length - 1]!.model).toBe('hunyuan-lite');
  });

  it('anthropic credential 形状不合法 → 400（与既有试通同一条规则）', async () => {
    const { item } = svc.create({
      name: 'T', baseUrl: 'https://api.t.example.com', credential: 'mmort_abcdefghijklmnopqrst', protocol: 'anthropic',
    });
    await expect(svc.test(item.id, 'short')).rejects.toThrow(/格式不正确/);
  });

  it('不存在的提供商 → 404', async () => {
    await expect(svc.test('p_nope', undefined)).rejects.toThrow(/不存在/);
  });
});

describe('SSRF 防线（提供商地址是用户输入、服务端会真实请求它）', () => {
  beforeEach(() => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
  });

  const BAD = [
    'http://localhost:3000',
    'https://api.localhost',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.1.1',
    'https://0.0.0.0',
    'ftp://api.example.com',
    'not a url',
  ];
  it.each(BAD)('★ 拒绝 %s', (url) => {
    expect(() =>
      svc.create({ name: 'X', baseUrl: url, credential: 'mmort_abcdefghijklmnopqrst', protocol: 'anthropic' }),
    ).toThrow(/不允许|只允许|不是合法 URL/);
  });

  const OK = ['https://api.example.com', 'https://api.example.com/', 'http://api.example.com'];
  it.each(OK)('放行 %s（公网 http/https）', (url) => {
    const { item } = svc.create({
      name: 'X', baseUrl: url, credential: 'mmort_abcdefghijklmnopqrst', protocol: 'anthropic',
    });
    // 尾斜杠被规整掉（与 resolveUpstreamBase 的去斜杠语义一致）
    expect(item.baseUrl).not.toMatch(/\/$/);
  });
});

describe('凭证形状', () => {
  beforeEach(() => {
    makeService();
    (svc as unknown as { onApplicationBootstrap: () => void }).onApplicationBootstrap();
  });

  /* ★★ [v1.6.13] ck_ 已退役：openai 走 OAuth，手填密钥一律拒绝并指向「重新导入授权」。 */
  it('★ openai 不再支持手填 ck_ 密钥', () => {
    for (const bad of ['ck_1234567890abcdef.zzzz', 'anything']) {
      expect(() =>
        svc.create({ name: 'X', baseUrl: 'https://api.example.com', credential: bad, protocol: 'openai' }),
      ).toThrow(/不再使用 ck_/);
    }
  });

  it('★ openai 空凭证可建（待导入授权）', () => {
    const { item } = svc.create({ name: 'X', baseUrl: 'https://api.example.com', credential: '', protocol: 'openai' });
    expect(item.credentialMask).toMatch(/oauth\(|未配置/);
  });

  /* ★★ [v1.6.11] anthropic / qoder 允许**先建后导**。
     这两家的凭证在客户端登录态里（mmort_ / 身份 JSON），用户手上没有；
     原先强制必填 → 界面上根本建不出来；而导入脚本要 provider id，id 建完才有 —— 死锁。
     放行留空后必须满足两条：行能建出来，且**不得**被当成已配置（否则列表谎报"有效"）。 */
  describe('anthropic / qoder 先建后导', () => {
    it('空凭证可建 → configured=false（不是谎报有效），且不落空凭证文件', () => {
      for (const protocol of ['anthropic', 'qoder'] as const) {
        const { item } = svc.create({
          name: `待导入-${protocol}`,
          baseUrl: 'https://api.example.com',
          credential: '',
          protocol,
        });
        expect(item.configured).toBe(false);
        expect(item.credentialMask).toBe('未配置');
        /* 空凭证不能落盘：落一个空文件会让 configured 判断（读文件非空）与实际不符。 */
        expect(existsSync(join(dir, 'providers', `${item.id}.key`))).toBe(false);
      }
    });

    it('给了凭证就照常校验形状（留空放行 ≠ 任意字符串都收）', () => {
      expect(() =>
        svc.create({ name: 'X', baseUrl: 'https://api.example.com', credential: 'not-json', protocol: 'qoder' }),
      ).toThrow(/格式不正确/);
    });
  });
});
