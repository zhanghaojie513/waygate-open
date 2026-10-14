/**
 * 迁移 006（requests 增加 reasoning_tokens）与版本守卫的测试。
 * 策略同 005：内存库 + 真实 schema.sql + 真实迁移文件；造 v5 库的做法是
 * 建到当前版本（v6）后 DROP 掉 006 加的列并回退 user_version。
 * （schema 的应用统一走 runMigrations 助手。）
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
  '006-reasoning-tokens.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 6;

/** 造一个 v5 库：建到当前版本（v6），再把 006 加的列 DROP 掉并回退版本号。 */
function makeV5Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql); // 当前 = v6
  db.exec('ALTER TABLE requests DROP COLUMN reasoning_tokens');
  db.prepare(
    `INSERT INTO requests (ts, trace_id, model, status, prompt_tokens, completion_tokens, total_tokens, created_at)
     VALUES (1000, 'trace-v5', 'kimi-k2.7', 200, 50, 10, 60, 1000)`,
  ).run();
  db.pragma('user_version = 5');
  return db;
}

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('迁移 006 · 前置', () => {
  it('迁移文件存在，且代码期望版本已至少升到 6', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 006 · 结构', () => {
  it('把 v5 顶到 v6：requests 出现 reasoning_tokens', () => {
    const db = makeV5Db();
    expect(readUserVersion(db)).toBe(5);

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);

    expect(cols(db, 'requests')).toContain('reasoning_tokens');
    db.close();
  });

  it('★ 对旧行安全：迁移后旧请求行的 reasoning_tokens = 0（补默认值，不丢数据）', () => {
    const db = makeV5Db();
    applyForwardScript(db, migrationSql, TARGET);

    const req = db.prepare("SELECT reasoning_tokens, prompt_tokens FROM requests WHERE trace_id = 'trace-v5'").get() as {
      reasoning_tokens: number;
      prompt_tokens: number;
    };
    expect(req.reasoning_tokens).toBe(0);
    expect(req.prompt_tokens).toBe(50); // 其它数据原样保留
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL（第二遍不报 duplicate column）', () => {
    const db = makeV5Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();
  });
});

describe('迁移 006 · 版本守卫', () => {
  it('v5 库启动被拒绝，且报错里给出可执行的迁移文件名（006）', () => {
    const db = makeV5Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/006/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过（含 reasoning_tokens）', () => {
    const db = new Database(':memory:');
    runMigrations(db, schemaSql);
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(() => assertSchema(db)).not.toThrow();
    expect(cols(db, 'requests')).toContain('reasoning_tokens');
    db.close();
  });
});
