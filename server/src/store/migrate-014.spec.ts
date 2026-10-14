/**
 * 迁移 014（requests.credits 改为**可空** —— 「未知」不再伪装成数字）的测试。
 *
 * 策略同 010：内存库 + 真实 schema.sql + 真实迁移文件；造 v13 库的做法是
 * 建到当前版本（v14）后把 credits 重建回 `NOT NULL DEFAULT 0` 并回退 user_version。
 *
 * 这一条迁移动的是**最大的表**（requests），且手法是表重建（DROP + RENAME），
 * 所以必须逐条钉住三件事：① 列约束真的变了；② 存量行一行不少、值一字不变；
 * ③ 六个索引全部回来（重建漏掉索引 = 生产上悄悄退化成全表扫描）。
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
  '014-credits-nullable.sql',
);

const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 14;

/** 迁移前就存在的 6 个索引（迁移里必须逐个重建，缺一个都会静默退化）。 */
const INDEXES = [
  'idx_requests_ts',
  'idx_requests_client_id_ts',
  'idx_requests_model_ts',
  'idx_requests_key_ts',
  'idx_requests_status_ts',
  'idx_requests_key_ip',
];

/** 造一个 v13 库：建到当前版本（v14），再把 credits 重建回 NOT NULL DEFAULT 0。 */
function makeV13Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql); // 当前 = v14
  // 表重建回 v13 的形态（SQLite 改不了列约束，只能重建）
  db.exec(`
    CREATE TABLE requests_v13 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, trace_id TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '未识别', client_rule INTEGER NOT NULL DEFAULT 4,
      client_id TEXT NOT NULL DEFAULT 'unidentified', key_id TEXT, key_hint TEXT,
      model TEXT NOT NULL, model_display TEXT, status INTEGER NOT NULL, upstream_code INTEGER,
      ms INTEGER NOT NULL DEFAULT 0, queued_ms INTEGER NOT NULL DEFAULT 0, first_byte_ms INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      credits REAL NOT NULL DEFAULT 0,
      stream INTEGER NOT NULL DEFAULT 1, retry_count INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', remote_ip TEXT, ua TEXT,
      request_body TEXT, response_body TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO requests_v13 SELECT * FROM requests;
    DROP TABLE requests;
    ALTER TABLE requests_v13 RENAME TO requests;
    CREATE INDEX idx_requests_ts ON requests(ts DESC);
    CREATE INDEX idx_requests_client_id_ts ON requests(client_id, ts DESC);
    CREATE INDEX idx_requests_model_ts ON requests(model, ts DESC);
    CREATE INDEX idx_requests_key_ts ON requests(key_id, ts DESC);
    CREATE INDEX idx_requests_status_ts ON requests(status, ts DESC);
    CREATE INDEX idx_requests_key_ip ON requests(key_id, remote_ip);
  `);
  db.pragma('user_version = 13');
  return db;
}

/** 插一行（credits 是 v13 的必填列，必须给值）。 */
function insertRow(db: Database.Database, id: number, credits: number): void {
  db.prepare(
    `INSERT INTO requests (id, ts, trace_id, model, status, credits, created_at)
     VALUES (?, ?, ?, 'kimi-k3', 200, ?, ?)`,
  ).run(id, 1000 + id, `t-${id}`, credits, 1000 + id);
}

const creditsCol = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(requests)').all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((c) => c.name === 'credits');

const indexes = (db: Database.Database) =>
  (db.prepare('PRAGMA index_list(requests)').all() as Array<{ name: string }>).map((i) => i.name);

describe('迁移 014 · 前置', () => {
  it('迁移文件存在，且代码期望版本已升到 14', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });
});

describe('迁移 014 · 结构', () => {
  it('★ credits 由 NOT NULL 变为可空（去掉默认值）', () => {
    const db = makeV13Db();
    expect(creditsCol(db)?.notnull).toBe(1); // 迁移前：必填

    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(readUserVersion(db)).toBe(TARGET);

    const col = creditsCol(db);
    expect(col?.notnull).toBe(0); // ★ 迁移后：可空
    expect(col?.dflt_value).toBeNull(); // 默认值也必须去掉（否则 NULL 会被悄悄写成 0）
    db.close();
  });

  it('★ 六个索引全部重建（漏一个就是静默的全表扫描）', () => {
    const db = makeV13Db();
    applyForwardScript(db, migrationSql, TARGET);
    for (const name of INDEXES) expect(indexes(db)).toContain(name);
    db.close();
  });

  it('★ 迁移后可写入 NULL（未知），且不再被默认值 0 顶替', () => {
    const db = makeV13Db();
    applyForwardScript(db, migrationSql, TARGET);
    db.prepare(
      `INSERT INTO requests (ts, trace_id, model, status, credits, created_at)
       VALUES (1, 't-null', 'm', 200, NULL, 1)`,
    ).run();
    const row = db.prepare("SELECT credits FROM requests WHERE trace_id = 't-null'").get() as {
      credits: number | null;
    };
    expect(row.credits).toBeNull(); // ← 若默认值还在，这里会是 0
    db.close();
  });
});

describe('迁移 014 · 存量数据', () => {
  it('★ 行数与积分值一字不变（迁移只改约束，不追溯改写历史）', () => {
    const db = makeV13Db();
    insertRow(db, 1, 0.08);
    insertRow(db, 2, 0);
    insertRow(db, 3, 2910); // 旧的量纲错误值：属历史记录，**不**追溯修正
    const before = db.prepare('SELECT id, credits FROM requests ORDER BY id').all();

    applyForwardScript(db, migrationSql, TARGET);

    const after = db.prepare('SELECT id, credits FROM requests ORDER BY id').all();
    expect(after).toEqual(before);
    expect(after.length).toBe(3);
    db.close();
  });

  it('★ 自增序列延续（重建表后新行的 id 不与存量冲突）', () => {
    const db = makeV13Db();
    insertRow(db, 7, 1);
    applyForwardScript(db, migrationSql, TARGET);
    db.prepare(
      `INSERT INTO requests (ts, trace_id, model, status, credits, created_at)
       VALUES (2, 't-next', 'm', 200, NULL, 2)`,
    ).run();
    const row = db.prepare("SELECT id FROM requests WHERE trace_id = 't-next'").get() as { id: number };
    expect(row.id).toBeGreaterThan(7);
    db.close();
  });

  it('幂等：版本已达标时短路，不重跑 DDL（第二遍不报 table exists）', () => {
    const db = makeV13Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();
  });
});

describe('迁移 014 · 版本守卫', () => {
  it('v13 库启动被拒绝，且报错里给出可执行的迁移文件名（014）', () => {
    const db = makeV13Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/014/);
    db.close();
  });

  it('空库首次建表直接到 EXPECTED_USER_VERSION，self-check 通过', () => {
    const db = new Database(':memory:');
    runMigrations(db, schemaSql);
    expect(readUserVersion(db)).toBe(EXPECTED_USER_VERSION);
    expect(creditsCol(db)?.notnull).toBe(0);
    expect(() => assertSchema(db)).not.toThrow();
    db.close();
  });
});
