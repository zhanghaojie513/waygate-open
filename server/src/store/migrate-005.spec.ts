/**
 * 迁移 005（requests / aggregates 增加 cached_tokens）与版本守卫的测试。
 *
 * 覆盖：
 *   - 迁移文件存在，EXPECTED_USER_VERSION 不低于 5
 *   - v4 → v5：两表都出现 cached_tokens 列，且**对旧行安全**（旧行补 0，不丢数据）
 *   - 幂等：版本已达标时短路，不重跑 DDL
 *   - 版本守卫：v4 库启动被拒且报错给出可执行迁移文件名
 *   - 空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过
 *
 * 测试策略：内存库 + **真实 schema.sql + 真实迁移文件**。
 * 造 v4 库的做法：按当前 schema 建库后，把 005 的两列 DROP 掉并回退 user_version ——
 * 结构与现实同源，不手抄旧 DDL。
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
  '005-cached-tokens.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 5;

/** 造一个 v4 库：按当前 schema（v5）建库，再把 005 加的两列 DROP 掉并回退版本号。 */
function makeV4Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(schemaSql); // 当前 = v5
  db.exec('ALTER TABLE requests   DROP COLUMN cached_tokens');
  db.exec('ALTER TABLE aggregates DROP COLUMN cached_tokens');
  // 造一行 v4 时代的旧请求（迁移后它的 cached_tokens 应被补为 0，而不是损坏）
  db.prepare(
    `INSERT INTO requests (ts, trace_id, model, status, prompt_tokens, completion_tokens, total_tokens, created_at)
     VALUES (1000, 'trace-v4', 'kimi-k2.7', 200, 50, 10, 60, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO aggregates (bucket, dim, dim_value, requests, prompt_tokens, completion_tokens, total_ms, updated_at)
     VALUES ('2026-10-03T10', 'model', 'kimi-k2.7', 1, 50, 10, 5, 1000)`,
  ).run();
  db.pragma('user_version = 4');
  return db;
}

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('迁移 005 · 前置', () => {
  it('迁移文件存在，且代码期望版本已至少升到 5', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 005 · 结构', () => {
  it('把 v4 顶到 v5：requests 与 aggregates 都出现 cached_tokens', () => {
    const db = makeV4Db();
    expect(readUserVersion(db)).toBe(4);

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);

    expect(cols(db, 'requests')).toContain('cached_tokens');
    expect(cols(db, 'aggregates')).toContain('cached_tokens');
    db.close();
  });

  it('★ 对旧行安全：迁移后旧请求行的 cached_tokens = 0（补默认值，不丢数据）', () => {
    const db = makeV4Db();
    applyForwardScript(db, migrationSql, TARGET);

    const req = db.prepare("SELECT cached_tokens FROM requests WHERE trace_id = 'trace-v4'").get() as {
      cached_tokens: number;
    };
    expect(req.cached_tokens).toBe(0);

    const agg = db
      .prepare("SELECT cached_tokens FROM aggregates WHERE dim_value = 'kimi-k2.7'")
      .get() as { cached_tokens: number };
    expect(agg.cached_tokens).toBe(0);

    // 且旧行的其它数据原样保留
    const row = db.prepare("SELECT prompt_tokens, completion_tokens FROM requests WHERE trace_id = 'trace-v4'").get() as {
      prompt_tokens: number;
      completion_tokens: number;
    };
    expect(row.prompt_tokens).toBe(50);
    expect(row.completion_tokens).toBe(10);
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL（第二遍不报 duplicate column）', () => {
    const db = makeV4Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();
  });
});

describe('迁移 005 · 版本守卫', () => {
  it('v4 库启动被拒绝，且报错里给出可执行的迁移文件名（005）', () => {
    const db = makeV4Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/005/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过（含 cached_tokens）', () => {
    const db = new Database(':memory:');
    db.exec(schemaSql);
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(() => assertSchema(db)).not.toThrow();
    expect(cols(db, 'requests')).toContain('cached_tokens');
    db.close();
  });
});
