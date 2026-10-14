/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v1→v2 迁移。
 *
 * 为什么不用 sqlite3 CLI：线上没装（实测 `sqlite3: command not found`）。
 * 服务自带 better-sqlite3，直接用它——不引入新依赖，且与运行时同一个库，
 * 行为一致（尤其是事务语义）。
 *
 * 用法（在 /opt/relay/server 下跑，以便 require 到 node_modules）：
 *   node /root/migrate-002.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/opt/relay/server/');
const Database = require('better-sqlite3');

const DB = '/var/lib/relay/relay.db';
const MIGRATION = '/root/002-admin-credential.sql';

if (!existsSync(MIGRATION)) {
  console.error(`找不到迁移文件 ${MIGRATION}`);
  process.exit(2);
}

const before = new Database(DB, { readonly: true });
const vBefore = before.pragma('user_version', { simple: true });
const tablesBefore = before
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
before.close();
console.log(`[迁移前] user_version=${vBefore}`);
console.log(`[迁移前] tables=${tablesBefore.join(',')}`);

if (vBefore === 2) {
  console.log('已经是 v2，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 1）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

// ---- 备份（VACUUM INTO 生成一致性快照，比 cp 安全：WAL 模式下 cp 可能拿到撕裂状态）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = `/root/relay-backup/relay-pre-v2-${stamp}.db`;
{
  const ro = new Database(DB, { readonly: true });
  ro.exec(`VACUUM INTO '${backupPath}'`);
  ro.close();
}
console.log(`[备份] ${backupPath}`);

// ---- 执行迁移（脚本自带 BEGIN/COMMIT，见文件头注释）
const sql = readFileSync(MIGRATION, 'utf8');
const db = new Database(DB);
try {
  db.exec(sql);
} finally {
  db.close();
}

// ---- 回读验证
const after = new Database(DB, { readonly: true });
const vAfter = after.pragma('user_version', { simple: true });
const tablesAfter = after
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
const ddl = after
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='admin_credential'")
  .get();
const cols = after.prepare('PRAGMA table_info(admin_credential)').all().map((c) => c.name);
const rows = after.prepare('SELECT COUNT(*) AS n FROM admin_credential').get();
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] tables=${tablesAfter.join(',')}`);
console.log(`[迁移后] admin_credential 列=${cols.join(',')}`);
console.log(`[迁移后] 行数=${rows.n}`);
console.log(`[迁移后] DDL:\n${ddl ? ddl.sql : '(缺失!)'}`);

const ok = vAfter === 2 && tablesAfter.includes('admin_credential') && cols.length === 5;
console.log(ok ? '\n✅ 迁移成功' : '\n❌ 迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
