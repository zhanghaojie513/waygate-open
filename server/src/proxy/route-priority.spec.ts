/**
 * 路由第一轮（全集合精确 id 匹配）内的「**声明优先于 observed**」取舍（v0.5.10）。
 *
 * 背景（2026-10-11 生产事故）：reconcileObserved 曾把 MiniMax 模型的 id 以
 * source=observed 写进 WorkBuddy 分区（它从未提供过该模型）。旧路由按
 * 「密钥绑定序 → 创建序」取第一个精确命中，幽灵行使 WorkBuddy 抢走了
 * MiniMax 模型的请求。修法：同 id 多家命中时，**声明行（seed/upstream/manual）
 * 永远排在 observed 行前面**；observed 只是"见过这条请求"，不是"这家提供它"。
 *
 * 注：resolveRoute 是私有方法，这里经受控 cast 直接调（返回值里的 provider
 * 才是断言对象）；公开包装 resolveModel 不回传提供商，测不到这个维度。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProxyService } from './proxy.service';
import { ProxyLogger } from './proxy-log';
import type { RelayConfigService } from '../config/config.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { fakeWbOauth } from './openai-upstream/wb-oauth.harness';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');

let db: Database.Database;
let catalog: ModelCatalogRepository;
let providers: ProvidersRepository;
let service: ProxyService;

const WB = { id: 'p_wb', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com' };
const MM = { id: 'p_mm', name: 'MiniMax Code', baseUrl: 'https://agent.minimax.cn' };

/** 造一个能跑 resolveRoute 的 ProxyService（不打网络，路由解析是纯读库）。 */
function makeService(): ProxyService {
  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'relay/0.5.10', baseUrl: WB.baseUrl },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_test_0123456789abcdef',
  } as unknown as RelayConfigService;
  /* 路由测试不落库，但 ProxyLogger 构造时就要 prepare 语句 —— 借同一个有 schema 的库。 */
  const log = new ProxyLogger(new RequestsRepository(db, new AggregatesRepository(db)), catalog, providers);
  return new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef'));
}

/** 私有方法受控访问（见文件头注）。返回的是 {provider, id, displayName}。 */
function route(model: string, keyClients: string[] | null): { providerId: string; source: string } {
  const r = (service as unknown as {
    resolveRoute: (m: string, k: string[] | null) => { provider: { id: string }; id: string };
  }).resolveRoute(model, keyClients);
  const pid = r.provider.id;
  return { providerId: pid, source: catalog.findById?.(pid, r.id)?.source ?? 'unknown' };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  catalog = new ModelCatalogRepository(db);
  providers = new ProvidersRepository(db);
  // 与生产同构：WorkBuddy（openai）创建在前，MiniMax Code（anthropic）在后
  providers.create({ ...WB, active: true });
  providers.create({ ...MM, active: true, protocol: 'anthropic' });
  service = makeService();
});

afterEach(() => db.close());

describe('路由第一轮 × 声明优先于 observed（v0.5.10）', () => {
  beforeEach(() => {
    /* 生产 2026-10-11 的真实形态：MiniMax 模型以 seed 落在 p_mm，
       又以 observed（幽灵）落在 p_wb。 */
    catalog.mergeSync(MM.id, [{ id: 'MiniMax-M3.1-Flash-Preview', displayName: 'M3.1', source: 'seed', multiplier: null, tag: null }]);
    catalog.mergeSync(WB.id, [{ id: 'MiniMax-M3.1-Flash-Preview', displayName: 'M3.1', source: 'observed', multiplier: null, tag: null }]);
  });

  it('★ 密钥绑定 WorkBuddy → 仍路由到声明它的 MiniMax（幽灵行不得抢）', () => {
    expect(route('MiniMax-M3.1-Flash-Preview', ['WorkBuddy'])).toEqual({ providerId: MM.id, source: 'seed' });
  });

  it('★ 密钥无绑定（创建序 WorkBuddy 在前）→ 仍是 MiniMax', () => {
    expect(route('MiniMax-M3.1-Flash-Preview', null)).toEqual({ providerId: MM.id, source: 'seed' });
  });

  it('★ 密钥绑定 MiniMax → MiniMax（原有正确路径不回退）', () => {
    expect(route('MiniMax-M3.1-Flash-Preview', ['MiniMax Code'])).toEqual({ providerId: MM.id, source: 'seed' });
  });

  it('★ 大小写敏感性保留：WorkBuddy 自己的小写 minimax-m3 仍归 WorkBuddy', () => {
    catalog.mergeSync(WB.id, [{ id: 'minimax-m3', displayName: 'MiniMax M3', source: 'upstream', multiplier: 0.25, tag: null }]);
    catalog.mergeSync(MM.id, [{ id: 'MiniMax-M3', displayName: 'M3', source: 'seed', multiplier: null, tag: null }]);
    catalog.mergeSync(WB.id, [{ id: 'MiniMax-M3', displayName: 'M3', source: 'observed', multiplier: null, tag: null }]);

    expect(route('minimax-m3', null)).toEqual({ providerId: WB.id, source: 'upstream' }); // 精确小写 → WorkBuddy 真身
    expect(route('MiniMax-M3', null)).toEqual({ providerId: MM.id, source: 'seed' }); // 精确大写 → MiniMax（幽灵不抢）
  });

  it('★ 只有 observed 行时仍可路由（observed 兜底语义保留，只是不再压过声明）', () => {
    catalog.clearProvider(WB.id);
    catalog.mergeSync(WB.id, [{ id: 'solo-observed', displayName: 'Solo', source: 'observed', multiplier: null, tag: null }]);

    expect(route('solo-observed', null)).toEqual({ providerId: WB.id, source: 'observed' });
  });
});
