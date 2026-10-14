/**
 * 迁移 010（client_keys 增加 ip_whitelist / max_ips / token_quota + requests 索引）的测试。
 * 策略同 006：内存库 + 真实 schema.sql + 真实迁移文件；造 v9 库的做法是
 * 建到当前版本（v10）后 DROP 掉 010 加的列并回退 user_version。
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
  '010-key-policy.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 10;

/** 造一个 v9 库：建到当前版本（v10），再把 010 加的列 DROP 掉并回退版本号。 */
function makeV9Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql); // 当前 = v10
  db.exec(`
    ALTER TABLE client_keys DROP COLUMN ip_whitelist;
    ALTER TABLE client_keys DROP COLUMN max_ips;
    ALTER TABLE client_keys DROP COLUMN token_quota;
  `);
  db.pragma('user_version = 9');
  return db;
}

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

const indexes = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA index_list(${t})`).all() as Array<{ name: string }>).map((i) => i.name);

describe('迁移 010 · 前置', () => {
  it('迁移文件存在，且代码期望版本已升到 10', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 010 · 结构', () => {
  it('把 v9 顶到 v10：client_keys 出现三个策略列 + requests 出现 (key_id, remote_ip) 索引', () => {
    const db = makeV9Db();
    expect(readUserVersion(db)).toBe(9);

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);

    const keyCols = cols(db, 'client_keys');
    expect(keyCols).toContain('ip_whitelist');
    expect(keyCols).toContain('max_ips');
    expect(keyCols).toContain('token_quota');
    expect(indexes(db, 'requests')).toContain('idx_requests_key_ip');
    db.close();
  });

  it('★ 对旧行安全：迁移后既有密钥的三项策略均为「不限」（不改变任何现有行为）', () => {
    const db = makeV9Db();
    db.prepare(
      `INSERT INTO client_keys (id, name, key_hash, key_hint, scope, client, clients, enabled, created_at)
       VALUES ('k_old', '旧密钥', 'hash', 'hint', '{"type":"all"}', NULL, '[]', 1, 1000)`,
    ).run();
    applyForwardScript(db, migrationSql, TARGET);

    const row = db.prepare('SELECT * FROM client_keys WHERE id = ?').get('k_old') as {
      ip_whitelist: string;
      max_ips: number | null;
      token_quota: number | null;
    };
    expect(row.ip_whitelist).toBe('[]');
    expect(row.max_ips).toBeNull();
    expect(row.token_quota).toBeNull();
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL（第二遍不报 duplicate column）', () => {
    const db = makeV9Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();
  });
});

describe('迁移 010 · 版本守卫', () => {
  it('v9 库启动被拒绝，且报错里给出可执行的迁移文件名（010）', () => {
    const db = makeV9Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/010/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过（含三个策略列）', () => {
    const db = new Database(':memory:');
    runMigrations(db, schemaSql);
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(() => assertSchema(db)).not.toThrow();
    db.close();
  });
});
