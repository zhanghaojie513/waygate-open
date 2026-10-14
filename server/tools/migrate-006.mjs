/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v5→v6 迁移
 * （requests 加 reasoning_tokens：输出里的思考 tokens，含在 completion_tokens 内）。
 * 与 tools/migrate-005.mjs 同一模式（user_version 守卫幂等；线上无 sqlite3 CLI，
 * 用服务自带 better-sqlite3）。
 * 用法：
 *   node tools/migrate-006.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/server/migrations/006-reasoning-tokens.sql
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 6;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', 'migrations', '006-reasoning-tokens.sql'),
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

const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const reqBefore = count(before, 'requests');
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}  requests 行数=${reqBefore}`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v6，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v6-${stamp}.db`);
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
const reqAfter = count(after, 'requests');
const reqHas = hasColumn(after, 'requests', 'reasoning_tokens');
const legacy = after.prepare('SELECT COUNT(*) AS n FROM requests WHERE reasoning_tokens <> 0').get().n;
after.close();

console.log(`[迁移后] user_version=${vAfter}`);
console.log(`[迁移后] requests 行数=${reqAfter}（应等于迁移前 ${reqBefore}）`);
console.log(`[迁移后] requests.reasoning_tokens 存在=${reqHas}`);
console.log(`[迁移后] 旧行 reasoning_tokens<>0 的条数=${legacy}（应为 0）`);

const ok = vAfter === TARGET_VERSION && reqAfter === reqBefore && reqHas && legacy === 0;
console.log(ok ? '\n迁移成功' : '\n迁移结果异常，请检查');
process.exit(ok ? 0 : 4);
