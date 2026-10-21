/**
 * 迁移 021（requests 补 `ingress_ms`）—— v1.7.3 的口径修正。
 *
 * 为什么单独一个迁移而不是改 020：**020 已经在生产执行过**。改一个已执行的迁移，
 * 会让已经升到 v20 的库永远拿不到新列（守卫看到 user_version=20 就短路）。
 * 这类「发布后才发现定义错了」的修正，唯一正确的做法是加一个新迁移。
 *
 * 钉住：① 新列可空；② 存量行 NULL（不回溯填充）；③ 幂等 + 版本守卫。
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_USER_VERSION, applyForwardScript, readUserVersion, runMigrations } from './migrate';
import { assertSchema } from './self-check';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const MIGRATION_PATH = join(__dirname, '..', '..', 'migrations', '021-request-ingress-ms.sql');
const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 21;

/** 造 v20 库：建到当前版本后删掉 ingress_ms。 */
function makeV20Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql);
  db.exec('ALTER TABLE requests DROP COLUMN ingress_ms;');
  db.pragma('user_version = 20');
  return db;
}

const col = (db: Database.Database, name: string) =>
  (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string; notnull: number }>).find(
    (c) => c.name === name,
  );

describe('迁移 021 · 结构', () => {
  it('迁移文件存在，代码期望版本 ≥ 21', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });

  it('★ ingress_ms 可空（未知不能压成 0）', () => {
    const db = makeV20Db();
    expect(col(db, 'ingress_ms')).toBeUndefined();
    applyForwardScript(db, migrationSql, TARGET);
    expect(col(db, 'ingress_ms')?.notnull).toBe(0);
    expect(readUserVersion(db)).toBe(TARGET);
    db.close();
  });

  it('★ 存量行保持 NULL（不做回溯改写）', () => {
    const db = makeV20Db();
    db.prepare(
      `INSERT INTO requests (ts, trace_id, model, status, auth_ms, prep_ms, created_at)
       VALUES (1, 't-old', 'm', 200, 9660, 28, 1)`,
    ).run();
    applyForwardScript(db, migrationSql, TARGET);
    const row = db.prepare("SELECT ingress_ms, auth_ms FROM requests WHERE trace_id='t-old'").get() as {
      ingress_ms: number | null;
      auth_ms: number | null;
    };
    expect(row.ingress_ms).toBeNull();
    /* auth_ms 的历史值也不动 —— 即便它按新口径是"错的"，改写历史测量值违反纪律。 */
    expect(row.auth_ms).toBe(9660);
    db.close();
  });

  it('幂等 + self-check（列清单含 ingress_ms）', () => {
    const db = makeV20Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    db.close();

    const fresh = new Database(':memory:');
    runMigrations(fresh, schemaSql);
    expect(() => assertSchema(fresh)).not.toThrow();
    expect(col(fresh, 'ingress_ms')).toBeDefined();
    fresh.close();
  });

  it('v20 库启动被拒，报错指向 021', () => {
    const db = makeV20Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/021/);
    db.close();
  });
});
