/**
 * [v1.6.28] 请求行落库时密钥已被删除（在途删除）的回归。
 *
 * 事故形态（2026-10-17 生产实证，trace fc179dcf…）：流式请求还没结束，临时密钥就被删了；
 * 请求随后落库时 `key_id` 指向已不存在的父行 ⇒ `FOREIGN KEY constraint failed`
 * ⇒ **整行审计被丢弃**（tokens / 积分 / 状态 / 耗时全没了，只剩一行 error 日志）。
 * 根因：`ON DELETE SET NULL` 只在删除那一刻清理已存在的子行，管不到「删除之后才插入」的行。
 *
 * 修复后的不变式：
 *   ① 行必须落库（不丢审计）；
 *   ② `key_id` 置 NULL（归属确实不存在了）；
 *   ③ `client` / `key_hint` 文本快照保留（仍能看出是谁发的，不污染客户端排行）；
 *   ④ note 带 `key_deleted_inflight`（事后可辨认这是「删除竞态」而非未识别流量）；
 *   ⑤ 聚合桶照常递增（否则统计会凭空少一条）；
 *   ⑥ 用量缓存不被喂一个不存在的 keyId。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestsRepository, ORPHANED_KEY_NOTE, type RequestLogInput } from './requests.repo';
import { AggregatesRepository } from './aggregates.repo';
import { ClientKeysRepository } from './client-keys.repo';

const SCHEMA_PATH = join(__dirname, '..', 'schema.sql');
const KEY_ID = 'k_inflight';

let db: Database.Database;
let requests: RequestsRepository;
let keys: ClientKeysRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  keys = new ClientKeysRepository(db);
  keys.create({
    id: KEY_ID,
    name: '在途删除测试',
    keyHash: 'h_inflight',
    keyHint: 'sk-waygate-aaaa…bbbb',
    scope: '{"type":"all"}',
    client: 'ZCode',
    expiresAt: null,
    source: 'console',
  });
});

afterEach(() => db.close());

const row = (over: Partial<RequestLogInput> = {}): RequestLogInput => ({
  ts: Date.now(),
  traceId: 'trace-inflight',
  clientId: KEY_ID,
  client: 'ZCode',
  clientRule: 2,
  keyId: KEY_ID,
  keyHint: 'sk-waygate-aaaa…bbbb',
  model: 'deepseek-v4.1-flash',
  modelDisplay: null,
  status: 200,
  upstreamCode: null,
  ms: 1234,
  queuedMs: 0,
  firstByteMs: 210,
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  cachedTokens: 0,
  credits: 1.25,
  stream: true,
  retryCount: 0,
  note: 'credits_from_upstream',
  remoteIp: '1.2.3.4',
  ua: 'ZCode/3.15.3',
  requestBody: null,
  responseBody: null,
  ...over,
});

describe('v1.6.28 · 密钥在请求在途期间被删除', () => {
  it('★ 行必须落库：key_id 降级 NULL，其余字段与聚合桶不丢', () => {
    keys.remove(KEY_ID); // 请求还在飞，密钥已被删
    expect(() => requests.log(row())).not.toThrow();

    const saved = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(saved.key_id).toBeNull(); // 归属确实不存在了
    expect(saved.client_id).toBe(KEY_ID); // ★ 稳定标识仍是文本快照，不改成 unidentified
    expect(saved.client).toBe('ZCode');
    expect(saved.key_hint).toBe('sk-waygate-aaaa…bbbb'); // ★ 快照保留，仍能看出是谁发的
    expect(saved.status).toBe(200);
    expect(saved.total_tokens).toBe(150);
    expect(saved.credits).toBe(1.25);
    expect(saved.ms).toBe(1234);
    expect(saved.first_byte_ms).toBe(210);
    expect(String(saved.note)).toContain(ORPHANED_KEY_NOTE);
    expect(String(saved.note)).toContain('credits_from_upstream'); // 原有标记不被覆盖

    // 聚合桶照常递增，否则概览会凭空少一条请求
    const agg = db
      .prepare("SELECT requests, credits FROM aggregates WHERE dim='total' AND dim_value='-'")
      .get() as { requests: number; credits: number } | undefined;
    expect(agg?.requests).toBe(1);
    expect(agg?.credits).toBeCloseTo(1.25, 5);
  });

  it('密钥仍存在时行为完全不变（不产生 key_deleted_inflight）', () => {
    requests.log(row());
    const saved = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(saved.key_id).toBe(KEY_ID);
    expect(String(saved.note)).not.toContain(ORPHANED_KEY_NOTE);
  });

  it('失败行（persistFailure 口径）同样不丢', () => {
    keys.remove(KEY_ID);
    requests.log(row({ status: 502, upstreamCode: 11128, credits: null, note: 'sysprompt_degraded_retry,retried,upstream_11128,credits_unknown' }));
    const saved = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(saved.key_id).toBeNull();
    expect(saved.status).toBe(502);
    expect(saved.upstream_code).toBe(11128);
    expect(String(saved.note)).toContain(ORPHANED_KEY_NOTE);
  });

  it('keyId 本来就是 NULL 时不受影响（未识别流量）', () => {
    requests.log(row({ keyId: null, keyHint: null, clientId: 'unidentified', client: '未识别', clientRule: 4 }));
    const saved = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(saved.key_id).toBeNull();
    expect(String(saved.note)).not.toContain(ORPHANED_KEY_NOTE);
  });
});
