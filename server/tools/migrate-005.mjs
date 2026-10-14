/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v4→v5 迁移
 * （requests / aggregates 各加 cached_tokens：缓存命中 prompt tokens 的采集列）。
 *
 * 为什么不用 sqlite3 CLI：线上没装（`sqlite3: command not found`）。
 * 服务自带 better-sqlite3，直接用它——不引入新依赖，且与运行时同一个库（尤其事务语义）。
 * （与 tools/migrate-00{2,3,4}.mjs 同一模式。）
 *
 * 为什么需要这个入口：迁移 005 是 ADD COLUMN（SQLite 不支持 ADD COLUMN IF NOT EXISTS），
 * 裸跑第二遍会报 "duplicate column name"。本脚本用 user_version 守卫保证幂等：已是 v5 直接短路。
 *
 * 用法：
 *   node tools/migrate-005.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/005-cached-tokens.sql
 *   （演练时先用临时库路径，绝不碰生产库。）
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 5;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '005-cached-tokens.sql'),
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
const hasColumn = (db, table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const legacyNonZero = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM requests WHERE cached_tokens <> 0').get().n;

// ---- 迁移前快照
const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const reqBefore = count(before, 'requests');
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}  requests 行数=${reqBefore}`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v5，无需迁移（幂等）。');
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
const backupPath = join(backupDir, `relay-pre-v5-${stamp}.db`);
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
const reqAfter = count(after, 'requests');
const reqHas = hasColumn(after, 'requests', 'cached_tokens');
const aggHas = hasColumn(after, 'aggregates', 'cached_tokens');
const legacy = legacyNonZero(after);
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] requests 行数=${reqAfter}（应等于迁移前 ${reqBefore}）`);
console.log(`[迁移后] requests.cached_tokens 存在=${reqHas}`);
console.log(`[迁移后] aggregates.cached_tokens 存在=${aggHas}`);
console.log(`[迁移后] 旧行 cached_tokens<>0 的条数=${legacy}（应为 0）`);

const ok = vAfter === TARGET_VERSION && reqAfter === reqBefore && reqHas && aggHas && legacy === 0;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
