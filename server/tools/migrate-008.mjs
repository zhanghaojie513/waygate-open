/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v7→v8 迁移
 * （新增 provider_model_prefs 表：按提供商记住模型的启用/停用）。
 * 与 tools/migrate-007.mjs 同一模式（user_version 守卫幂等；线上无 sqlite3 CLI，
 * 用服务自带 better-sqlite3）。
 *
 * 用法：
 *   node tools/migrate-008.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/008-provider-model-prefs.sql
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 8;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '008-provider-model-prefs.sql'),
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
const hasTable = (db, table) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;

const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const reqBefore = before.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}  requests 行数=${reqBefore}`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v8，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v8-${stamp}.db`);
{
  const ro = new Database(DB, { readonly: true });
  ro.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  ro.close();
}
console.log(`[备份] ${backupPath}`);

const sql = readFileSync(MIGRATION, 'utf8');
const db = new Database(DB);
db.pragma('foreign_keys = ON');
try {
  db.exec(sql);
} finally {
  db.close();
}

const after = new Database(DB, { readonly: true });
const vAfter = version(after);
const reqAfter = after.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
const hasPrefs = hasTable(after, 'provider_model_prefs');
const prefsCount = hasPrefs ? after.prepare('SELECT COUNT(*) AS n FROM provider_model_prefs').get().n : -1;
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] requests 行数=${reqAfter}（应等于迁移前 ${reqBefore}）`);
console.log(`[迁移后] provider_model_prefs 表存在=${hasPrefs}`);
console.log(`[迁移后] 偏好行数=${prefsCount}（应为 0 —— 首次切换时才产生）`);

const ok = vAfter === TARGET_VERSION && reqAfter === reqBefore && hasPrefs && prefsCount === 0;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
