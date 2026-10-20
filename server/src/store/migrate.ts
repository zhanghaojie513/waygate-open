import { readAsset } from '../common/assets';
import type { Db } from './db';

/** 代码期望的 schema 版本，与 schema.sql 的 `PRAGMA user_version` 一致。 */
export const EXPECTED_USER_VERSION = 19;

export function readUserVersion(db: Db): number {
  const row = db.pragma('user_version', { simple: true }) as unknown;
  if (typeof row === 'number') return row;
  if (Array.isArray(row) && typeof row[0] === 'number') return row[0];
  return 0;
}

/**
 * 迁移策略（ADR-002）：永不自动跑 ALTER。
 *   user_version = 0   -> 空库，执行 schema.sql 一次性建表与种子
 *   user_version < 期望 -> 拒绝启动，打印需要执行的迁移
 *   user_version > 期望 -> 打 warning 继续跑（迁移只增列，前向兼容）
 */
export function runMigrations(db: Db, schemaSql?: string): { applied: boolean; version: number } {
  const current = readUserVersion(db);
  if (current === 0) {
    const sql = schemaSql ?? readAsset('store/schema.sql');
    db.exec(sql);
    const after = readUserVersion(db);
    if (after !== EXPECTED_USER_VERSION) {
      throw new Error(
        `建表脚本执行后 user_version=${after}，期望 ${EXPECTED_USER_VERSION}。请检查 schema.sql 是否完整。`,
      );
    }
    return { applied: true, version: after };
  }
  if (current < EXPECTED_USER_VERSION) {
    throw new Error(
      `数据库版本 ${current} 低于代码期望的 ${EXPECTED_USER_VERSION}。请先执行迁移 server/migrations/00${current + 1}-*.sql 再启动，本服务不会自动改表。`,
    );
  }
  if (current > EXPECTED_USER_VERSION) {
    console.warn(
      `[store] 数据库版本 ${current} 高于代码期望的 ${EXPECTED_USER_VERSION}，按前向兼容继续运行。`,
    );
  }
  return { applied: false, version: current };
}

/**
 * 执行一段**前向迁移脚本**，并保证**幂等**：
 *   - 当前版本已 >= 目标版本 -> 直接短路返回 'skipped'（绝不重跑 DDL）；
 *   - 否则整段脚本在事务内执行（脚本自带 BEGIN/COMMIT），执行后校验版本号。
 *
 * 为什么需要它：SQLite **不支持** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，
 * 一条裸 `ADD COLUMN` 脚本第二遍执行会抛 "duplicate column name"。把这些脚本的
 * 幂等性收敛到「按 user_version 短路」这一处，就不会有人靠"再跑一次试试"把库搞脏。
 *
 * 这是**手工迁移入口**（`tools/migrate-003.mjs` 与迁移测试）共用的执行语义；
 * 启动路径仍走 `runMigrations`（低版本一律拒绝启动，永不自动改表）。
 */
export function applyForwardScript(
  db: Db,
  sqlText: string,
  targetVersion: number,
): 'applied' | 'skipped' {
  const current = readUserVersion(db);
  if (current >= targetVersion) return 'skipped';
  db.exec(sqlText);
  const after = readUserVersion(db);
  if (after !== targetVersion) {
    throw new Error(
      `迁移脚本执行后 user_version=${after}，期望 ${targetVersion}。脚本可能不完整或未置版本号。`,
    );
  }
  return 'applied';
}
