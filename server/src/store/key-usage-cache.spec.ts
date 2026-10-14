/**
 * KeyUsageCache：缓存值必须恒等于直接对 requests 表做聚合的结果。
 * 覆盖：增量维护 / 删除作废 / 进程外（其他连接）写入的识别。
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';
import { keyUsageCacheFor } from './key-usage-cache';
import { RequestsRepository } from './repositories/requests.repo';
import { AggregatesRepository } from './repositories/aggregates.repo';
import { ClientKeysRepository } from './repositories/client-keys.repo';

type Db = Parameters<typeof runMigrations>[0];

function setup(db: Database.Database) {
  runMigrations(db as unknown as Db);
  const keys = new ClientKeysRepository(db as unknown as Db);
  const requests = new RequestsRepository(db as unknown as Db, new AggregatesRepository(db as unknown as Db));
  for (const id of ['k1', 'k2']) {
    keys.create({
      id,
      name: id,
      keyHash: `h-${id}`,
      keyHint: id,
      scope: '{"type":"all"}',
      client: null,
      expiresAt: null,
      source: 'console',
    });
  }
  let seq = 0;
  const log = (keyId: string, tokens: number, ip: string | null, ts = Date.now()) =>
    requests.log({
      ts,
      traceId: `t${++seq}`,
      clientId: keyId,
      client: keyId,
      clientRule: 2,
      keyId,
      keyHint: keyId,
      model: 'm',
      modelDisplay: null,
      status: 200,
      upstreamCode: null,
      ms: 1,
      queuedMs: 0,
      firstByteMs: null,
      promptTokens: 0,
      completionTokens: tokens,
      totalTokens: tokens,
      cachedTokens: 0,
      credits: 0,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: ip,
      ua: null,
      requestBody: null,
      responseBody: null,
    });
  /** 直接 SQL 的真值（缓存必须与之恒等） */
  const truth = (keyId: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS tokens,
                COUNT(DISTINCT CASE WHEN remote_ip IS NOT NULL AND remote_ip <> '' THEN remote_ip END) AS ips,
                COUNT(*) AS requests
           FROM requests WHERE key_id = ?`,
      )
      .get(keyId) as { tokens: number; ips: number; requests: number };
  const cached = (keyId: string) => ({
    tokens: keys.tokensUsedForKey(keyId),
    ips: keys.distinctIpsForKey(keyId),
    requests: keys.usageForKey(keyId).requestsTotal,
  });
  return { keys, requests, log, truth, cached };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('KeyUsageCache', () => {
  it('加载后随写入增量维护：tokens / 去重 IP（空串与 NULL 不计）/ 请求数恒等于 SQL 真值', () => {
    const db = new Database(':memory:');
    const h = setup(db);
    h.log('k1', 10, '10.0.0.1');
    expect(h.cached('k1')).toEqual(h.truth('k1')); // 首次读取：从库里加载
    h.log('k1', 5, '10.0.0.1'); // 老 IP
    h.log('k1', 7, '10.0.0.2'); // 新 IP
    h.log('k1', 3, ''); // 空串不计入去重 IP
    h.log('k1', 4, null);
    h.log('k2', 100, '10.0.0.9'); // 别的密钥不影响 k1
    expect(h.cached('k1')).toEqual(h.truth('k1'));
    expect(h.cached('k1')).toEqual({ tokens: 29, ips: 2, requests: 5 });
    expect(h.cached('k2')).toEqual(h.truth('k2'));
  });

  it('删除（清空 / 保留期分批清理）后作废并重算', () => {
    const db = new Database(':memory:');
    const h = setup(db);
    const old = Date.now() - 100 * 24 * 3600 * 1000;
    h.log('k1', 50, '10.0.0.1', old);
    h.log('k1', 8, '10.0.0.2');
    expect(h.cached('k1')).toEqual({ tokens: 58, ips: 2, requests: 2 });

    h.requests.clearBeforeBatch(Date.now() - 1000 * 3600, 100);
    expect(h.cached('k1')).toEqual(h.truth('k1'));
    expect(h.cached('k1')).toEqual({ tokens: 8, ips: 1, requests: 1 });

    h.requests.clearAll();
    expect(h.cached('k1')).toEqual({ tokens: 0, ips: 0, requests: 0 });
  });

  it('其他连接（进程外运维脚本）改了库：凭 data_version 识别并作废', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuc-'));
    dirs.push(dir);
    const file = join(dir, 'relay.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    const h = setup(db);
    h.log('k1', 10, '10.0.0.1');
    h.log('k1', 20, '10.0.0.2');
    expect(h.cached('k1').tokens).toBe(30);

    const other = new Database(file); // 模拟 tools/cleanup-test-requests.mjs
    other.prepare("DELETE FROM requests WHERE remote_ip = '10.0.0.2'").run();
    other.close();

    expect(h.cached('k1')).toEqual({ tokens: 10, ips: 1, requests: 1 });
    db.close();
  });

  it('同一连接的两个仓库共享同一份缓存', () => {
    const db = new Database(':memory:');
    runMigrations(db as unknown as Db);
    expect(keyUsageCacheFor(db as unknown as Db)).toBe(keyUsageCacheFor(db as unknown as Db));
  });
});
