/**
 * 迁移 019（providers.protocol CHECK 扩 'custom'）的测试。
 *
 * 策略同 014：内存库 + 真实 schema.sql + 真实迁移文件；造 v18 库的做法是
 * 建到当前版本（v19）后把 providers 重建回三值 CHECK 并回退 user_version。
 *
 * 这条迁移是**表重建**，必须钉住：① CHECK 真的放宽（'custom' 能写进去）；
 * ② 存量行一行不少、一字不变；③ idx_providers_active 回来；④ 幂等与版本守卫。
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_USER_VERSION, applyForwardScript, readUserVersion, runMigrations } from './migrate';
import { assertSchema } from './self-check';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const MIGRATION_PATH = join(__dirname, '..', '..', 'migrations', '019-custom-provider.sql');

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 19;

/** 造一个 v18 库：建到当前版本（v19），再把 providers 重建回三值 CHECK 的 v18 形态。 */
function makeV18Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql); // 当前 = v19
  db.exec(`
    CREATE TABLE providers_v18 (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      base_url   TEXT    NOT NULL,
      active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      protocol   TEXT    NOT NULL DEFAULT 'openai'
                 CHECK (protocol IN ('openai', 'anthropic', 'qoder')),
      chat_path  TEXT,
      cred_kind  TEXT    NOT NULL DEFAULT 'static'
                 CHECK (cred_kind IN ('static', 'oauth_minimax')),
      access_expires_at INTEGER,
      signin_checked_on  TEXT, signin_streak INTEGER, signin_last_points INTEGER,
      wb_signin_checked_on TEXT, wb_signin_streak INTEGER, wb_signin_last_points INTEGER,
      wb_oauth_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    /* 显式列名（不用通配）：模拟的是 v18 的列集合，schema.sql 后续演进不该让这条测试假红。 */
    INSERT INTO providers_v18
      (id, name, base_url, active, protocol, chat_path, cred_kind,
       access_expires_at, signin_checked_on, signin_streak, signin_last_points,
       wb_signin_checked_on, wb_signin_streak, wb_signin_last_points,
       wb_oauth_expires_at, created_at, updated_at)
    SELECT
      id, name, base_url, active, protocol, chat_path, cred_kind,
      access_expires_at, signin_checked_on, signin_streak, signin_last_points,
      wb_signin_checked_on, wb_signin_streak, wb_signin_last_points,
      wb_oauth_expires_at, created_at, updated_at
    FROM providers;
    DROP TABLE providers;
    ALTER TABLE providers_v18 RENAME TO providers;
    CREATE INDEX idx_providers_active ON providers(active);
  `);
  db.pragma('user_version = 18');
  return db;
}

function seedProviders(db: Database.Database): void {
  db.prepare(
    `INSERT INTO providers (id, name, base_url, active, protocol, chat_path, cred_kind, created_at, updated_at)
     VALUES
       ('p_a', 'WorkBuddy', 'https://copilot.tencent.com', 1, 'openai',  NULL, 'static', 1, 1),
       ('p_b', 'MiniMax Code', 'https://mavis.minimax.io', 0, 'anthropic', NULL, 'oauth_minimax', 2, 2),
       ('p_c', 'Qoder CN', 'https://gateway.qoder.com.cn', 0, 'qoder', NULL, 'static', 3, 3)`,
  ).run();
}

describe('迁移 019 · 前置', () => {
  it('迁移文件存在，且代码期望版本已升到 19', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 019 · 结构', () => {
  it('★ v18 库里写不进 custom（迁移确实必要，不是空转）', () => {
    const db = makeV18Db();
    expect(() =>
      db.prepare(
        `INSERT INTO providers (id, name, base_url, active, protocol, cred_kind, created_at, updated_at)
         VALUES ('p_x', 'x', 'https://x.example.com', 0, 'custom', 'static', 1, 1)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('★ 迁移后 protocol=custom 可写入（CHECK 放宽是本迁移的全部目的）', () => {
    const db = makeV18Db();
    applyForwardScript(db, migrationSql, TARGET);
    expect(readUserVersion(db)).toBe(TARGET);
    expect(() =>
      db.prepare(
        `INSERT INTO providers (id, name, base_url, active, protocol, chat_path, cred_kind, created_at, updated_at)
         VALUES ('p_x', 'DeepSeek', 'https://api.deepseek.com', 0, 'custom', NULL, 'static', 4, 4)`,
      ).run(),
    ).not.toThrow();
    db.close();
  });

  it('★ 非法协议值仍被拒（放宽只加了 custom，不是拆掉 CHECK）', () => {
    const db = makeV18Db();
    applyForwardScript(db, migrationSql, TARGET);
    expect(() =>
      db.prepare(
        `INSERT INTO providers (id, name, base_url, active, protocol, cred_kind, created_at, updated_at)
         VALUES ('p_y', 'y', 'https://y.example.com', 0, 'grpc', 'static', 1, 1)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('★ idx_providers_active 重建（漏掉就是静默全表扫描）', () => {
    const db = makeV18Db();
    applyForwardScript(db, migrationSql, TARGET);
    const idx = (db.prepare('PRAGMA index_list(providers)').all() as Array<{ name: string }>).map((i) => i.name);
    expect(idx).toContain('idx_providers_active');
    db.close();
  });
});

describe('迁移 019 · 存量数据', () => {
  it('★ 三家内置行一字不变（迁移只放宽约束，不动数据）', () => {
    const db = makeV18Db();
    seedProviders(db);
    const before = db.prepare('SELECT * FROM providers ORDER BY created_at').all();

    applyForwardScript(db, migrationSql, TARGET);

    const after = db.prepare('SELECT * FROM providers ORDER BY created_at').all();
    expect(after).toEqual(before);
    expect(after.length).toBe(3);
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL', () => {
    const db = makeV18Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();
  });
});

describe('迁移 019 · 版本守卫', () => {
  it('v18 库启动被拒绝，报错给出 019 迁移文件名', () => {
    const db = makeV18Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/019/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过', () => {
    const db = new Database(':memory:');
    runMigrations(db, schemaSql);
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(() => assertSchema(db)).not.toThrow();
    db.close();
  });
});
