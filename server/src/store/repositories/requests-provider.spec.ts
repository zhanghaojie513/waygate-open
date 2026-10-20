/**
 * [2026-10-19] 提供商归属必须等于**实际路由到的**提供商，而不是事后按目录猜。
 *
 * ## 缺陷背景
 * `requests` 表没有 provider 列，归属靠「模型 id → 生效目录的 provider」反解，
 * 反解规则是**遍历顺序先到先得**（`listActive()` = `ORDER BY created_at ASC`，
 * 即**最早创建**的提供商赢）。而路由 `resolveRoute` 的候选顺序是
 * 「**密钥绑定的提供商优先**，其余按创建序」。
 *
 * 于是当一个模型 id 同时存在于两家目录里（生产实测：MiniMax-M2.7 / M3 /
 * M3.1-Flash-Preview 同时在 MiniMax Code 与 MiniMax Code2 的目录中），
 * 若某把密钥绑定的是**较晚创建**的那家：
 *   · 请求实际路由到 Code2
 *   · 统计却记到 Code（创建序在前）
 * ⇒ 两个都叫「提供商用量」的数字，一个说流量去了 A、实际去了 B。
 *
 * ## 为什么现在不出错
 * 生产上目前没有任何密钥绑定 Code2，所以路由也不会优先它 —— 归属恰好正确。
 * 这是**巧合**，不是保证：一旦有人建一把绑定 Code2 的密钥就会错。
 *
 * ## 正确做法
 * 落库时记下**真实路由结果**（`requests.provider_id`），归属直接读它；
 * 只在历史行（该列为 NULL）上才会回落到「目录反解」。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestsRepository } from './requests.repo';
import { AggregatesRepository } from './aggregates.repo';
import { ClientKeysRepository } from './client-keys.repo';

const SCHEMA_PATH = join(__dirname, '..', 'schema.sql');

let db: Database.Database;
let requests: RequestsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  new ClientKeysRepository(db).create({
    id: 'k1',
    name: 'test',
    keyHash: 'h1',
    keyHint: 'sk-waygate-aaaa…0001',
    scope: '{"type":"all"}',
    client: null,
    expiresAt: null,
    source: 'console',
  });
});

afterEach(() => db.close());

const row = (over: Record<string, unknown> = {}) => ({
  ts: Date.now(),
  traceId: `t-${Math.random().toString(36).slice(2)}`,
  clientId: 'k1',
  client: 'C',
  clientRule: 2,
  keyId: 'k1',
  keyHint: 'sk-waygate-aaaa…0001',
  model: 'MiniMax-M3',
  modelDisplay: null,
  status: 200,
  upstreamCode: null,
  ms: 10,
  queuedMs: 0,
  firstByteMs: 5,
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  credits: 1,
  stream: true,
  retryCount: 0,
  note: '',
  remoteIp: null,
  ua: null,
  requestBody: null,
  responseBody: null,
  ...over,
});

describe('requests.provider_id · 归属落库', () => {
  it('★ 落库时记录真实路由的提供商', () => {
    requests.log(row({ providerId: 'p_code2' }) as never);
    const saved = db.prepare('SELECT provider_id FROM requests ORDER BY id DESC LIMIT 1').get() as { provider_id: string | null };
    expect(saved.provider_id).toBe('p_code2');
  });

  it('★ 未解析出模型（本地拒绝）时 provider_id 为 NULL，不编造', () => {
    requests.log(row({ model: '', providerId: null }) as never);
    const saved = db.prepare('SELECT provider_id, model FROM requests ORDER BY id DESC LIMIT 1').get() as { provider_id: string | null; model: string };
    expect(saved.provider_id).toBeNull();
  });

  it('★ 旧调用方不传 providerId 时不报错（向后兼容，落 NULL）', () => {
    requests.log(row() as never);
    const saved = db.prepare('SELECT provider_id FROM requests ORDER BY id DESC LIMIT 1').get() as { provider_id: string | null };
    expect(saved.provider_id).toBeNull();
  });
});
