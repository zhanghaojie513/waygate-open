/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v6→v7 迁移
 * （新增 providers 表：自定义提供商，多个已配置、单活）。
 * 与 tools/migrate-006.mjs 同一模式（user_version 守卫幂等；线上无 sqlite3 CLI，
 * 用服务自带 better-sqlite3）。
 *
 * 注意：本迁移**只建表**，不种子默认行 —— 默认行要从 settings.json 读
 * upstream.baseUrl、要复制 upstream.key 文件，SQL 做不到。
 * 种子由服务首次启动时的 ProvidersService.ensureSeeded() 完成（幂等）。
 *
 * 用法：
 *   node tools/migrate-007.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/007-providers.sql
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 7;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '007-providers.sql'),
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
  console.log('已经是 v7，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v7-${stamp}.db`);
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
const hasProviders = hasTable(after, 'providers');
const provCount = hasProviders ? after.prepare('SELECT COUNT(*) AS n FROM providers').get().n : -1;
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] requests 行数=${reqAfter}（应等于迁移前 ${reqBefore}）`);
console.log(`[迁移后] providers 表存在=${hasProviders}`);
console.log(`[迁移后] providers 行数=${provCount}（应为 0 —— 默认行在服务首次启动时种子）`);

const ok = vAfter === TARGET_VERSION && reqAfter === reqBefore && hasProviders && provCount === 0;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
