/**
 * 影响面（v1.7.1）—— 钉住「停用/删除前能看到谁在依赖它」这条链的四段：
 *   ① 密钥绑定按 **id 精确 + 名字兜底**（与路由层 resolveBinding 同源）；
 *   ② 模型范围点名这家的模型 → scopedKeys（**可能**受影响，不是独家）；
 *   ③ 近期流量走 provider_id 事实列，NULL 行不计入（猜出来的量不能当证据）；
 *   ④ 「删除会失去什么」分协议如实列（custom 不该被说成"OAuth 授权会丢"）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ProviderImpactService, scopeModelIds } from './provider-impact.service';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import type { Db } from '../store/db';

let db: Db;
let svc: ProviderImpactService;
let keys: ClientKeysRepository;

const MM = 'p_mm';
const WB = 'p_wb';

function seedKey(id: string, name: string, clients: string[], scope: unknown): void {
  keys.create({
    id, name, keyHash: `h_${id}`, keyHint: `sk-waygate-${id.slice(2)}…aaaa`,
    scope: JSON.stringify(scope), client: clients[0] ?? null,
    clients: JSON.stringify(clients), expiresAt: null, source: 'console',
  });
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.exec(readFileSync(join(__dirname, '..', 'store', 'schema.sql'), 'utf8').replace(/^PRAGMA user_version.*$/m, ''));
  const providers = new ProvidersRepository(db);
  const catalog = new ModelCatalogRepository(db);
  keys = new ClientKeysRepository(db);
  providers.create({ id: MM, name: 'MiniMax Code', baseUrl: 'https://agent.minimax.cn', active: true, protocol: 'anthropic', credKind: 'oauth_minimax' });
  providers.create({ id: WB, name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: true, protocol: 'openai', credKind: 'static' });
  catalog.seed(MM, [
    { id: 'MiniMax-M3', displayName: 'M3', tag: null, multiplier: 0.25 },
    { id: 'MiniMax-M3.1-Flash', displayName: 'M3.1', tag: null, multiplier: null },
  ]);
  catalog.seed(WB, [{ id: 'kimi-k3', displayName: 'Kimi K3', tag: null, multiplier: 1.62 }]);
  svc = new ProviderImpactService(db, providers, catalog, keys);
});

afterEach(() => {
  (db as unknown as Database.Database).close();
});

describe('scopeModelIds · 纯函数', () => {
  it('只有 type=models 有点名', () => {
    expect(scopeModelIds({ type: 'models', value: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(scopeModelIds({ type: 'all' })).toEqual([]);
    expect(scopeModelIds({ type: 'family', value: 'kimi' })).toEqual([]);
  });
  it('接受 JSON 字符串；脏数据当空', () => {
    expect(scopeModelIds('{"type":"models","value":["x"]}')).toEqual(['x']);
    expect(scopeModelIds('{ not json')).toEqual([]);
    expect(scopeModelIds(null)).toEqual([]);
  });
});

describe('影响面 · 绑定链', () => {
  it('★ 按 id 命中（新数据）', () => {
    seedKey('k_a', 'Claude Code', [MM, WB], { type: 'all' });
    const r = svc.impact(MM);
    expect(r.boundKeys).toHaveLength(1);
    expect(r.boundKeys[0]).toMatchObject({ id: 'k_a', rank: 0, legacyByName: false });
  });

  it('★ 名字兜底（旧数据存的是名字）—— 与路由层同源', () => {
    seedKey('k_old', '老密钥', ['MiniMax Code'], { type: 'all' });
    const r = svc.impact(MM);
    expect(r.boundKeys).toHaveLength(1);
    expect(r.boundKeys[0]).toMatchObject({ id: 'k_old', legacyByName: true, rank: 0 });
  });

  it('id 命中优先于名字命中（同一数组里有两者）', () => {
    seedKey('k_mix', '混合', ['MiniMax Code', MM], { type: 'all' });
    const r = svc.impact(MM);
    expect(r.boundKeys[0]).toMatchObject({ rank: 1, legacyByName: false });
  });

  it('按绑定序排序（rank 0 在最前）', () => {
    seedKey('k_second', '次选', [WB, MM], { type: 'all' });
    seedKey('k_first', '首选', [MM], { type: 'all' });
    const r = svc.impact(MM);
    expect(r.boundKeys.map((k) => k.id)).toEqual(['k_first', 'k_second']);
  });

  it('没绑这家的密钥不出现', () => {
    seedKey('k_other', '别家', [WB], { type: 'all' });
    expect(svc.impact(MM).boundKeys).toHaveLength(0);
  });
});

describe('影响面 · 模型范围', () => {
  it('★ 点名了这家的模型 → scopedKeys（可能受影响）', () => {
    seedKey('k_scope', '限定', [WB], { type: 'models', value: ['MiniMax-M3', 'glm-5.3'] });
    const r = svc.impact(MM);
    expect(r.scopedKeys).toHaveLength(1);
    expect(r.scopedKeys[0]).toMatchObject({ id: 'k_scope', modelIds: ['MiniMax-M3'] });
  });

  it('范围里没有这家的模型 → 不出现', () => {
    seedKey('k_scope2', '限定2', [WB], { type: 'models', value: ['kimi-k3'] });
    expect(svc.impact(MM).scopedKeys).toHaveLength(0);
  });
});

describe('影响面 · 近期流量与不可逆', () => {
  it('★ 走 provider_id 事实列；NULL 行（迁移前/本地拒绝）不计入', () => {
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO requests (ts, trace_id, model, status, total_tokens, provider_id, created_at)
       VALUES (?, ?, 'MiniMax-M3', 200, ?, ?, ?)`,
    );
    ins.run(now - 1000, 't1', 100, MM, now);
    ins.run(now - 2000, 't2', 200, MM, now);
    ins.run(now - 3000, 't3', 999, null, now); // 无归属 → 不算
    ins.run(now - 4000, 't4', 999, WB, now); // 别家 → 不算
    ins.run(now - 30 * 3600_000, 't5', 999, MM, now); // 超窗口 → 不算

    const r = svc.impact(MM);
    expect(r.recent).toEqual({ requests: 2, tokens: 300 });
  });

  it('★ 不可逆清单分协议（custom 不说 OAuth，openai 才说）', () => {
    const providers = new ProvidersRepository(db);
    providers.create({ id: 'p_cu', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', active: false, protocol: 'custom', credKind: 'static' });
    const custom = svc.impact('p_cu').irreversible.join(' ');
    expect(custom).toContain('API Key');
    expect(custom).not.toContain('OAuth');

    const wb = svc.impact(WB).irreversible.join(' ');
    expect(wb).toContain('OAuth');

    const mm = svc.impact(MM).irreversible.join(' ');
    expect(mm).toContain('refresh token');
    expect(mm).toContain('一次性');
  });

  it('模型数与启用数如实（停用的也算进 modelCount）', () => {
    const catalog = new ModelCatalogRepository(db);
    catalog.setEnabled(MM, 'MiniMax-M3', false);
    const r = svc.impact(MM);
    expect(r.modelCount).toBe(2);
    expect(r.modelEnabled).toBe(1);
  });
});
