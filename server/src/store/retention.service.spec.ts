/**
 * 日志保留清理单测（task#37 A4）。
 *
 * 断言的是**结果**：过期行被删、未过期行原样保留、聚合桶只清整日过期部分、
 * `retainDays` 每次实时读配置（改设置即时生效）。用内存库 + 真实 schema。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestsRepository } from './repositories/requests.repo';
import { AggregatesRepository, dayBucket } from './repositories/aggregates.repo';
import { RetentionService } from './retention.service';
import type { RelayConfigService } from '../config/config.service';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const DAY = 24 * 60 * 60 * 1000;

let db: Database.Database;
let requests: RequestsRepository;
let aggregates: AggregatesRepository;
let retainDays: number;
let service: RetentionService;

function makeService(): RetentionService {
  const config = {
    get: () => ({ logs: { retainDays } }),
  } as unknown as RelayConfigService;
  return new RetentionService(config, requests, aggregates);
}

let seq = 0;
function logAt(ts: number): void {
  requests.log({
    ts,
    traceId: `t${++seq}`,
    clientId: 'unidentified',
    client: '未识别',
    clientRule: 4,
    keyId: null,
    keyHint: null,
    model: 'm',
    modelDisplay: null,
    status: 200,
    upstreamCode: null,
    ms: 1,
    queuedMs: 0,
    firstByteMs: null,
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
  });
}

const countRequests = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
const oldAggregates = (cutoff: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM aggregates WHERE bucket < ?').get(dayBucket(cutoff)) as {
    n: number;
  }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  aggregates = new AggregatesRepository(db);
  retainDays = 30;
  service = makeService();
});

afterEach(() => db.close());

describe('RetentionService.sweep', () => {
  it('① 只删过期请求行，未过期的原样保留', () => {
    const now = Date.now();
    logAt(now - 100 * DAY); // 过期
    logAt(now - 1 * DAY); // 未过期
    expect(countRequests()).toBe(2);

    const out = service.sweep(now);

    expect(out.requests).toBe(1);
    expect(out.retainDays).toBe(30);
    expect(countRequests()).toBe(1);
    // 留下的必须是未过期那条
    expect((db.prepare('SELECT ts FROM requests').get() as { ts: number }).ts).toBeGreaterThan(
      now - 30 * DAY,
    );
  });

  it('② 过期聚合桶被清（不残留趋势图）', () => {
    const now = Date.now();
    logAt(now - 100 * DAY);

    expect(oldAggregates(now - 30 * DAY)).toBeGreaterThan(0);
    service.sweep(now);
    expect(oldAggregates(now - 30 * DAY)).toBe(0);
  });

  it('③ 没有过期数据时不动任何东西（幂等 / 不误删）', () => {
    const now = Date.now();
    logAt(now - 1 * DAY);
    const before = countRequests();

    const out = service.sweep(now);

    expect(out.requests).toBe(0);
    expect(out.aggregates).toBe(0);
    expect(countRequests()).toBe(before);
  });

  it('④ retainDays 每次实时读配置（改设置即时生效，无需重启）', () => {
    const now = Date.now();
    logAt(now - 2 * DAY); // 2 天前

    retainDays = 30;
    expect(service.sweep(now).requests).toBe(0); // 30 天内 → 不删

    // 改用同一个 service 实例，仅改配置 → 立即按新口径删
    retainDays = 1;
    expect(service.sweep(now).requests).toBe(1);
  });

  it('⑤ 未过期的聚合桶保留（保守：不删与存活请求对应的桶）', () => {
    const now = Date.now();
    logAt(now - 1 * DAY);
    service.sweep(now);
    // 近一天的聚合仍在（clearBefore 只删截止日之前的整日桶）
    const recent = db
      .prepare('SELECT COUNT(*) AS n FROM aggregates WHERE bucket >= ?')
      .get(dayBucket(now - 30 * DAY)) as { n: number };
    expect(recent.n).toBeGreaterThan(0);
  });
});

describe('RetentionService.sweepIncremental（线上分批清理）', () => {
  it('⑥ 跨批次（> 单批 5000 行）全部删净，未过期行保留，结果与一次性 sweep 等价', async () => {
    const now = Date.now();
    // 直接批量插 5003 条过期行（走 log() 太慢），再插 1 条未过期行
    const ins = db.prepare(
      `INSERT INTO requests (ts, trace_id, client_id, client, client_rule, model, status, ms, queued_ms,
         prompt_tokens, completion_tokens, total_tokens, cached_tokens, credits, stream, retry_count, note, created_at)
       VALUES (?, ?, 'unidentified', '未识别', 4, 'm', 200, 1, 0, 1, 1, 2, 0, 1, 1, 0, '', ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 5003; i++) ins.run(now - 100 * DAY + i, `bulk${i}`, now);
    })();
    logAt(now - 1 * DAY);

    const out = await service.sweepIncremental(now);

    expect(out.requests).toBe(5003);
    expect(countRequests()).toBe(1);
    expect(oldAggregates(now - 30 * DAY)).toBe(0);
  });
});
