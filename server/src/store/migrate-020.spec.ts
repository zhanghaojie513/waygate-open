/**
 * 迁移 020（requests 分段计时三列）+ splitTiming 的计算口径。
 *
 * 两件事分开钉：
 *   ① 迁移只加可空列 —— 老行必须仍是 NULL（不能因为加了列就把历史"填成 0ms"）；
 *   ② splitTiming 的「未知不压成 0」：缺端点、时钟回拨都返回 null，绝不给 0。
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_USER_VERSION, applyForwardScript, readUserVersion, runMigrations } from './migrate';
import { assertSchema } from './self-check';
import { splitTiming } from '../proxy/proxy-log';

const SCHEMA_PATH = join(__dirname, 'schema.sql');
const MIGRATION_PATH = join(__dirname, '..', '..', 'migrations', '020-request-timing-split.sql');
const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const TARGET = 20; // 本 spec 只验 020 本身；ingress_ms 由 021 提供，故 DB 构造走当前 schema

/** 造一个 v19 库：建到当前版本（v20），再把三列删掉（SQLite 3.35+ 支持 DROP COLUMN）。 */
function makeV19Db(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, schemaSql);
  db.exec(`
    ALTER TABLE requests DROP COLUMN auth_ms;
    ALTER TABLE requests DROP COLUMN prep_ms;
    ALTER TABLE requests DROP COLUMN upstream_wait_ms;
  `);
  db.pragma('user_version = 19');
  return db;
}

const cols = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string; notnull: number }>);

describe('迁移 020 · 结构', () => {
  it('迁移文件存在，代码期望版本 = 20', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(EXPECTED_USER_VERSION).toBeGreaterThanOrEqual(TARGET);
  });

  it('★ 三列都是可空（未知不能压成 0）', () => {
    const db = makeV19Db();
    for (const c of ['auth_ms', 'prep_ms', 'upstream_wait_ms']) {
      expect(cols(db).find((x) => x.name === c)).toBeUndefined(); // 迁移前不存在
    }
    applyForwardScript(db, migrationSql, TARGET);
    for (const c of ['auth_ms', 'prep_ms', 'upstream_wait_ms']) {
      const col = cols(db).find((x) => x.name === c);
      expect(col, c).toBeDefined();
      expect(col!.notnull, `${c} 必须可空`).toBe(0);
    }
    db.close();
  });

  it('★ 存量行三列保持 NULL（不追溯填充）', () => {
    const db = makeV19Db();
    db.prepare(
      `INSERT INTO requests (ts, trace_id, model, status, created_at) VALUES (1, 't-old', 'm', 200, 1)`,
    ).run();
    applyForwardScript(db, migrationSql, TARGET);
    const row = db.prepare("SELECT auth_ms, prep_ms, upstream_wait_ms FROM requests WHERE trace_id='t-old'").get() as Record<string, unknown>;
    expect(row).toEqual({ auth_ms: null, prep_ms: null, upstream_wait_ms: null });
    db.close();
  });

  it('幂等 + self-check（列清单已含三列）', () => {
    const db = makeV19Db();
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('applied');
    expect(applyForwardScript(db, migrationSql, TARGET)).toBe('skipped');
    expect(readUserVersion(db)).toBe(TARGET);
    db.close();

    const fresh = new Database(':memory:');
    runMigrations(fresh, schemaSql);
    expect(() => assertSchema(fresh)).not.toThrow();
    fresh.close();
  });

  it('v19 库启动被拒，报错指向 020', () => {
    const db = makeV19Db();
    expect(() => runMigrations(db, schemaSql)).toThrow(/020/);
    db.close();
  });
});

describe('splitTiming · 口径', () => {
  it('★ 四段齐全 → 都算出来（authMs 从 body 就绪起算，不是进门）', () => {
    // 进门 1000 → body 就绪 2100（客户端传了 1.1s）→ 鉴权完 2150 → 发出 2180 → 首字节 2580
    const r = splitTiming({ authed: 2150, sent: 2180, firstByte: 2580 }, 1000, 2100);
    expect(r).toEqual({ authMs: 50, prepMs: 30, upstreamWaitMs: 400, ingressMs: 1100 });
  });

  it('★ 大 body 只进 ingressMs，不污染 authMs（发版当天生产实证的教训）', () => {
    // 客户端传 9.6s（几十 MB body）—— 若把进门当起点，authMs 会是 9660，归因就废了
    const r = splitTiming({ authed: 9700, sent: 9730, firstByte: 12000 }, 100, 9600);
    expect(r.ingressMs).toBe(9500);
    expect(r.authMs).toBe(100); // 真正的鉴权耗时
    expect(r.prepMs).toBe(30);
  });

  it('★ 缺 bodyReadyAt → authMs 为 null（不拿进门顶替），后两段仍可算', () => {
    expect(splitTiming({ authed: 100, sent: 130, firstByte: 500 }, 90)).toEqual({
      authMs: null, prepMs: 30, upstreamWaitMs: 370, ingressMs: null,
    });
  });

  it('★ 失败行没有 firstByte → upstreamWaitMs null', () => {
    expect(splitTiming({ authed: 100, sent: 130 }, 90, 95)).toEqual({
      authMs: 5, prepMs: 30, upstreamWaitMs: null, ingressMs: 5,
    });
  });

  it('完全没打点 → 全 null', () => {
    expect(splitTiming({})).toEqual({ authMs: null, prepMs: null, upstreamWaitMs: null, ingressMs: null });
  });

  it('★ 时钟回拨（负值）→ null，不返回负数', () => {
    const r = splitTiming({ authed: 900, sent: 800, firstByte: 700 }, 1000, 950);
    expect(r).toEqual({ authMs: null, prepMs: null, upstreamWaitMs: null, ingressMs: null });
  });

  it('0 是合法测量值（同毫秒完成）', () => {
    const r = splitTiming({ authed: 1000, sent: 1000, firstByte: 1000 }, 1000, 1000);
    expect(r).toEqual({ authMs: 0, prepMs: 0, upstreamWaitMs: 0, ingressMs: 0 });
  });
});
