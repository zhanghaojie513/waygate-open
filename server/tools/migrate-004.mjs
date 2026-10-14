/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v3→v4 迁移
 * （model_catalog：source 增 'observed' 四态；multiplier 改为可空 = 倍率未知）。
 *
 * 为什么不用 sqlite3 CLI：线上没装（`sqlite3: command not found`）。
 * 服务自带 better-sqlite3，直接用它——不引入新依赖，且与运行时同一个库（尤其事务语义）。
 * （与 tools/migrate-002.mjs / migrate-003.mjs 同一模式。）
 *
 * 为什么需要这个入口：迁移 004 是**重建表**（SQLite 无法 ALTER CHECK / 去掉 NOT NULL），
 * 裸跑第二遍会丢数据。本脚本用 user_version 守卫保证幂等：已是 v4 直接短路。
 *
 * 用法：
 *   node tools/migrate-004.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/004-model-catalog-source.sql
 *   （演练时先用临时库路径，绝不碰生产库。）
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 4;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '004-model-catalog-source.sql'),
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
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM model_catalog').get().n;
const multiplierNullable = (db) =>
  db.prepare('PRAGMA table_info(model_catalog)').all().find((c) => c.name === 'multiplier')?.notnull === 0;
const sourceAllowsObserved = (db) => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_catalog'").get()?.sql ?? '';
  return sql.includes("'observed'");
};

// ---- 迁移前快照
const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const nBefore = count(before);
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}  model_catalog 行数=${nBefore}`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v4，无需迁移（幂等）。');
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
const backupPath = join(backupDir, `relay-pre-v4-${stamp}.db`);
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
const nAfter = count(after);
const nullable = multiplierNullable(after);
const observedOk = sourceAllowsObserved(after);
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] model_catalog 行数=${nAfter}（应等于迁移前 ${nBefore}）`);
console.log(`[迁移后] multiplier 可空=${nullable}`);
console.log(`[迁移后] source CHECK 含 observed=${observedOk}`);

const ok = vAfter === TARGET_VERSION && nAfter === nBefore && nullable && observedOk;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
