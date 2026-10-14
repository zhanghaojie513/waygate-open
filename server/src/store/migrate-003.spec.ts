/**
 * 迁移 003（requests.client_id）与 schema 版本守卫的测试。
 *
 * 覆盖的验收标准：
 *   AC-C03 迁移回填正确（有 key_id 的行 client_id = key_id）
 *   AC-C02 rule-2 -> key_id / rule-4 -> 'unidentified'
 *   AC-C05 迁移脚本幂等（重复执行 = 干净 no-op）
 *   AC-C04 user_version 守卫拒绝启动 + self-check 认可新列（缺列/多列都报错）
 *
 * 测试策略：内存库 + 真实 schema.sql + 真实迁移文件（不造假 schema、不复制迁移逻辑）。
 * 构造 v2 库的做法：先按当前 v3 schema 建库，再把 v3 的改动「回退」成 v2 ——
 * 这样 v2 库的结构是**从真实 schema 派生**的，不会因为抄了一份旧 schema 而与现实脱节。
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_USER_VERSION, applyForwardScript, readUserVersion, runMigrations } from './migrate';
import { assertSchema } from './self-check';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const MIGRATION_PATH = join(
  __dirname, '..', '..', 'migrations',
  '003-client-id.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 3;

/** 造一个货真价实的 v2 库：先按当前 schema（v3）建，再把 client_id 相关改动回退掉。 */
function makeV2Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(schemaSql); // 当前 = v3
  db.exec('DROP INDEX IF EXISTS idx_requests_client_id_ts');
  db.exec('DROP INDEX IF EXISTS idx_requests_client_ts');
  db.exec('ALTER TABLE requests DROP COLUMN client_id');
  db.exec('CREATE INDEX idx_requests_client_ts ON requests(client, ts DESC)');
  db.pragma('user_version = 2');
  return db;
}

function insertV2Key(db: Database.Database, id: string, client = 'Claude Code'): void {
  // requests.key_id 有 FK -> client_keys(id)，故造行前得先把密钥放进 client_keys
  db.prepare(
    `INSERT INTO client_keys (id, name, key_hash, key_hint, scope, client, enabled, expires_at, source, created_at)
     VALUES (?, ?, ?, ?, '{"type":"all"}', ?, 1, NULL, 'console', ?)`,
  ).run(id, `密钥-${id}`, `hash-${id}`, `sk-waygate-${id.slice(-4)}…zzzz`, client, Date.now());
}

function insertV2Row(
  db: Database.Database,
  r: { client: string; rule: number; keyId: string | null; keyHint: string | null; credits?: number },
): void {
  db.prepare(
    `INSERT INTO requests
       (ts, trace_id, client, client_rule, key_id, key_hint, model, status, ms,
        prompt_tokens, completion_tokens, total_tokens, credits, stream, retry_count, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'kimi-k3', 200, 20, 100, 50, 150, ?, 1, 0, '', ?)`,
  ).run(
    Date.now(),
    `t-${Math.random().toString(36).slice(2)}`,
    r.client,
    r.rule,
    r.keyId,
    r.keyHint,
    r.credits ?? 1,
    Date.now(),
  );
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map(
    (x) => x.name,
  );
}
function cols(db: Database.Database, t: string): string[] {
  return (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
}
const badBackfill = (db: Database.Database): number =>
  (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM requests WHERE key_id IS NOT NULL AND key_id <> '' AND client_id <> key_id",
      )
      .get() as { n: number }
  ).n;

describe('迁移 003 · 前置', () => {
  it('迁移文件存在，且代码期望版本不低于 3（后续迁移会继续抬高）', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 003 · 结构（AC-C02 / AC-C03 / AC-C05）', () => {
  it('把 v2 顶到 v3：加列 + 换索引（旧索引退役）', () => {
    const db = makeV2Db();
    expect(readUserVersion(db)).toBe(2);

    const result = applyForwardScript(db, migrationSql, TARGET);

    expect(result).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);
    expect(cols(db, 'requests')).toContain('client_id');
    expect(indexNames(db)).toContain('idx_requests_client_id_ts');
    expect(indexNames(db)).not.toContain('idx_requests_client_ts');
    db.close();
  });

  it('AC-C03 回填：有 key_id 的行 client_id = key_id；无则 unidentified', () => {
    const db = makeV2Db();
    insertV2Key(db, 'k_aaa');
    insertV2Key(db, 'k_bbb');
    insertV2Row(db, { client: 'Claude Code', rule: 2, keyId: 'k_aaa', keyHint: 'sk-waygate-aaaa…0001' });
    insertV2Row(db, { client: 'Claude Code', rule: 2, keyId: 'k_bbb', keyHint: 'sk-waygate-bbbb…0002' });
    insertV2Row(db, { client: '未识别', rule: 4, keyId: null, keyHint: null });

    applyForwardScript(db, migrationSql, TARGET);

    // AC-C03：不允许存在「有 key_id 却 client_id 不等于它」的行
    expect(badBackfill(db)).toBe(0);
    const rows = db
      .prepare('SELECT client, client_rule, key_id, client_id FROM requests ORDER BY key_id')
      .all() as Array<{ client: string; client_rule: number; key_id: string | null; client_id: string }>;
    // AC-C02：rule-2 行 client_id 必须等于 key_id；rule-4 行必须为 'unidentified'
    for (const r of rows) {
      if (r.client_rule === 2) expect(r.client_id).toBe(r.key_id);
      if (r.client_rule === 4) expect(r.client_id).toBe('unidentified');
    }
    // 快照列 client 原样保留（降级为快照，不再是键）
    expect(rows.every((r) => r.client === (r.client_rule === 4 ? '未识别' : 'Claude Code'))).toBe(true);
    db.close();
  });

  it('aggregates 的历史 client 键被清掉（可重建的派生数据，不是丢失）', () => {
    const db = makeV2Db();
    db.exec(
      `INSERT INTO aggregates (bucket, dim, dim_value, requests, credits, updated_at)
       VALUES ('2026-10-03T14','client','Claude Code',3,6,1),
              ('2026-10-03T14','model','kimi-k3',3,6,1),
              ('2026-10-03T14','total','-',3,6,1)`,
    );

    applyForwardScript(db, migrationSql, TARGET);

    const clientDim = (
      db.prepare("SELECT COUNT(*) AS n FROM aggregates WHERE dim='client'").get() as { n: number }
    ).n;
    const otherDims = (
      db.prepare("SELECT COUNT(*) AS n FROM aggregates WHERE dim<>'client'").get() as { n: number }
    ).n;
    expect(clientDim).toBe(0); // 按名字的历史 client 聚合已清（权威源是 requests，可重算）
    expect(otherDims).toBe(2); // 其它维度不动
    db.close();
  });

  it('AC-C05 幂等：连续执行两次，第二次是干净 no-op，状态一致', () => {
    const db = makeV2Db();
    insertV2Key(db, 'k_aaa');
    insertV2Row(db, { client: 'Claude Code', rule: 2, keyId: 'k_aaa', keyHint: 'sk-waygate-aaaa…0001' });
    insertV2Row(db, { client: '未识别', rule: 4, keyId: null, keyHint: null });

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    const snapshot = () => ({
      version: readUserVersion(db),
      rows: db.prepare('SELECT id, client_id FROM requests ORDER BY id').all(),
      indexes: indexNames(db).sort(),
    });
    const first = snapshot();

    // 第二次：版本已 >= 目标 -> 短路，不重跑 DDL
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    expect(snapshot()).toEqual(first);
    db.close();
  });

  it('AC-C05 反证：裸跑第二遍会报 duplicate column —— 入口守卫不是摆设', () => {
    // 证明「为什么必须有 user_version 守卫」：SQLite 不支持 ADD COLUMN IF NOT EXISTS。
    const db = makeV2Db();
    db.exec(migrationSql);
    expect(() => db.exec(migrationSql)).toThrow(/duplicate column/i);
    db.close();
  });
});

describe('迁移 003 · 版本守卫与自检（AC-C04）', () => {
  it('v2 库启动被拒绝，且报错里给出可执行的迁移文件名', () => {
    const db = makeV2Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/003/);
    db.close();
  });

  it('空库首次建表后版本 = 代码期望版本；再次迁移正常放行', () => {
    const empty = new Database(':memory:');
    expect(runMigrations(empty, schemaSql)).toEqual({ applied: true, version: EXPECTED_USER_VERSION });
    // 再跑一次：已是最新版，不再建表
    expect(runMigrations(empty, schemaSql)).toEqual({ applied: false, version: EXPECTED_USER_VERSION });
    empty.close();
  });

  it('self-check 认可 v3 的 requests（含 client_id）', () => {
    const db = new Database(':memory:');
    db.exec(schemaSql);
    expect(() => assertSchema(db)).not.toThrow();
    db.close();
  });

  it('self-check 对「缺列」报错（v2 库缺 client_id）', () => {
    const db = makeV2Db();
    expect(() => assertSchema(db)).toThrow(/client_id/);
    db.close();
  });

  it('self-check 对「多出未声明列」也报错（双向校验）', () => {
    const db = new Database(':memory:');
    db.exec(schemaSql);
    db.exec('ALTER TABLE requests ADD COLUMN bogus_col TEXT');
    expect(() => assertSchema(db)).toThrow(/bogus_col/);
    db.close();
  });
});
