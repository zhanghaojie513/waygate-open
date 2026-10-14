/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v2→v3 迁移（requests 增加稳定分组键 client_id）。
 *
 * 为什么不用 sqlite3 CLI：线上没装（实测 `sqlite3: command not found`，本机亦无）。
 * 服务自带 better-sqlite3，直接用它——不引入新依赖，且与运行时同一个库，行为一致（尤其事务语义）。
 * （与已有的 tools/migrate-002.mjs 同一模式。）
 *
 * 为什么需要这个入口（而不是裸跑 003-client-id.sql）：
 *   SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，裸跑第二遍会报 duplicate column。
 *   本脚本用 user_version 守卫保证**幂等**：已是 v3 直接短路，绝不重跑 DDL。
 *
 * 用法：
 *   node tools/migrate-003.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/003-client-id.sql
 *   （演练时建议先用临时库路径，绝不碰生产库。）
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 3;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '003-client-id.sql'),
);

if (!existsSync(DB)) {
  console.error(`找不到数据库文件 ${DB}`);
  process.exit(2);
}
if (!existsSync(MIGRATION)) {
  console.error(`找不到迁移文件 ${MIGRATION}`);
  process.exit(2);
}

const version = (db) => db.pragma('user_version', { simple: true });
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const indexNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);

// ---- 迁移前快照
const before = new Database(DB, { readonly: true });
const vBefore = version(before);
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v3，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

// ---- 备份（VACUUM INTO 一致快照；WAL 下 cp 可能拿到撕裂状态）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v3-${stamp}.db`);
{
  const ro = new Database(DB, { readonly: true });
  ro.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  ro.close();
}
console.log(`[备份] ${backupPath}`);

// ---- 执行迁移（脚本自带 BEGIN/COMMIT）
const sql = readFileSync(MIGRATION, 'utf8');
const db = new Database(DB);
db.pragma('foreign_keys = ON');
try {
  db.exec(sql);
} finally {
  db.close();
}

// ---- 回读验证
const after = new Database(DB, { readonly: true });
const vAfter = version(after);
const cols = columns(after, 'requests');
const idx = indexNames(after);
const badBackfill = after
  .prepare(
    "SELECT COUNT(*) AS n FROM requests WHERE key_id IS NOT NULL AND key_id <> '' AND client_id <> key_id",
  )
  .get().n;
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] requests 含 client_id=${cols.includes('client_id')}`);
console.log(`[迁移后] idx_requests_client_id_ts=${idx.includes('idx_requests_client_id_ts')}`);
console.log(`[迁移后] idx_requests_client_ts（应已退役）=${idx.includes('idx_requests_client_ts')}`);
console.log(`[迁移后] AC-C03 bad_backfill（期望 0）=${badBackfill}`);

const ok =
  vAfter === TARGET_VERSION &&
  cols.includes('client_id') &&
  idx.includes('idx_requests_client_id_ts') &&
  !idx.includes('idx_requests_client_ts') &&
  badBackfill === 0;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
