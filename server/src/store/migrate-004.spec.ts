/**
 * 迁移 004（model_catalog：source 增 'observed' 四态；multiplier 改为可空）与版本守卫的测试。
 *
 * 覆盖：
 *   - 迁移文件存在，EXPECTED_USER_VERSION 不低于 4
 *   - v3 → v4：表被重建，multiplier 变可空，source CHECK 接受 'observed'、仍拒绝未知值
 *   - 数据无损：行数与值（含 multiplier / display_name）逐行保留
 *   - 幂等：版本已达标时短路，不重跑 DDL
 *   - 版本守卫：v3 库启动被拒且报错给出可执行迁移文件名
 *
 * 测试策略：内存库 + **真实迁移文件**。v3 建表用历史形状显式构造（SQLite 无法从 v4
 * 「回退」掉 CHECK 约束，只能显式写 v3 的 DDL —— 这是本迁移唯一可行且诚实的做法）。
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_USER_VERSION, applyForwardScript, readUserVersion, runMigrations } from './migrate';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const MIGRATION_PATH = join(
  __dirname, '..', '..', 'migrations',
  '004-model-catalog-source.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 4;

/** v3 的 model_catalog 历史形状（multiplier NOT NULL；source 三态）。 */
const V3_TABLE = `
CREATE TABLE model_catalog (
  id               TEXT    PRIMARY KEY,
  display_name     TEXT    NOT NULL,
  family           TEXT    NOT NULL,
  tag              TEXT,
  multiplier       REAL    NOT NULL DEFAULT 1.0,
  source           TEXT    NOT NULL DEFAULT 'seed',
  verified         INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (source  IN ('upstream', 'seed', 'manual')),
  CHECK (verified IN (0, 1)),
  CHECK (enabled  IN (0, 1))
);
CREATE INDEX idx_model_catalog_display ON model_catalog(display_name COLLATE NOCASE);
CREATE INDEX idx_model_catalog_enabled ON model_catalog(enabled);
`;

function makeV3Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(V3_TABLE);
  db.exec(
    `INSERT INTO model_catalog (id, display_name, family, tag, multiplier, source, verified, enabled, last_verified_at, created_at, updated_at)
     VALUES ('kimi-k2.7', 'Kimi-K2.7-Code', 'kimi', NULL,   0.57, 'seed', 1, 1, NULL, 1, 1),
            ('glm-5.3',   'GLM-5.3',       'glm',  '订阅优先', 0.79, 'seed', 0, 1, NULL, 1, 1)`,
  );
  db.pragma('user_version = 3');
  return db;
}

const cols = (db: Database.Database, t: string) =>
  db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>;

describe('迁移 004 · 前置', () => {
  it('迁移文件存在，且代码期望版本已至少升到 4', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    // 不钉死等于 4 —— 后续迁移（005…）会把 EXPECTED_USER_VERSION 继续抬高。
    // 这里只要求「不低于本迁移目标」，与 migrate-003.spec 同一处理。
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 004 · 结构', () => {
  it('把 v3 顶到 v4：multiplier 变可空，source CHECK 含 observed', () => {
    const db = makeV3Db();
    expect(readUserVersion(db)).toBe(3);

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);

    const multiplier = cols(db, 'model_catalog').find((c) => c.name === 'multiplier');
    expect(multiplier?.notnull).toBe(0);

    // source='observed' 可以写入；未知来源仍被 CHECK 拒绝
    expect(() =>
      db
        .prepare(
          `INSERT INTO model_catalog (id, display_name, family, multiplier, source, verified, enabled, created_at, updated_at)
           VALUES ('obs-1', 'Obs 1', 'obs', NULL, 'observed', 0, 1, 1, 1)`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO model_catalog (id, display_name, family, multiplier, source, verified, enabled, created_at, updated_at)
           VALUES ('bad-1', 'Bad', 'bad', NULL, 'bogus', 0, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('数据无损：行数与值（含 multiplier / display_name）逐行保留', () => {
    const db = makeV3Db();
    applyForwardScript(db, migrationSql, TARGET);

    const rows = db.prepare('SELECT id, display_name, multiplier FROM model_catalog ORDER BY id').all() as Array<{
      id: string;
      display_name: string;
      multiplier: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'kimi-k2.7')?.display_name).toBe('Kimi-K2.7-Code');
    expect(rows.find((r) => r.id === 'kimi-k2.7')?.multiplier).toBe(0.57);
    expect(rows.find((r) => r.id === 'glm-5.3')?.multiplier).toBe(0.79);
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL', () => {
    const db = makeV3Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    const snapshot = () => db.prepare('SELECT id, display_name, multiplier FROM model_catalog ORDER BY id').all();
    const first = snapshot();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    expect(snapshot()).toEqual(first);
    db.close();
  });
});

describe('迁移 004 · 版本守卫', () => {
  it('v3 库启动被拒绝，且报错里给出可执行的迁移文件名', () => {
    const db = makeV3Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/004/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过', () => {
    const db = new Database(':memory:');
    db.exec(schemaSql);
    // schema.sql 随最新迁移同步抬高版本；这里跟随 EXPECTED_USER_VERSION，不写死 4。
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(() => runMigrations(db, schemaSql)).not.toThrow();
    db.close();
  });
});
