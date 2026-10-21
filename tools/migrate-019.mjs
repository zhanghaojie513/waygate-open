/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v18→v19 迁移
 * （providers 表重建：protocol CHECK 扩 'custom' —— v1.7.0 自定义提供商）。
 * 与 tools/migrate-008.mjs 同一模式（user_version 守卫幂等；线上无 sqlite3 CLI，
 * 用服务自带 better-sqlite3）。
 *
 * 这条是**表重建**（SQLite 改不了 CHECK，只能建新表拷数据换名）——所以除了
 * 版本守卫，还逐行核对迁移前后的 providers 行数与内容指纹（行数一致 + 每行
 * 关键列拼接的哈希一致），任何一行变了就报错退出，绝不静默继续。
 *
 * 用法：
 *   node tools/migrate-019.mjs [dbPath] [sqlPath]
 *   默认 dbPath = $RELAY_DATA_DIR/relay.db 或 <cwd>/data/relay.db
 *   默认 sqlPath = <repo>/relay-station-design/design/migrations/019-custom-provider.sql
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 19;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', '..', 'relay-station-design', 'design', 'migrations', '019-custom-provider.sql'),
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

/** 迁移前后内容指纹：全行关键列拼接后哈希 —— 表重建必须一字不变地搬过去。 */
const providersFingerprint = (db) => {
  const rows = db
    .prepare(
      `SELECT id, name, base_url, active, protocol, chat_path, cred_kind,
              access_expires_at, signin_checked_on, signin_streak, signin_last_points,
              wb_signin_checked_on, wb_signin_streak, wb_signin_last_points,
              wb_oauth_expires_at, created_at, updated_at
       FROM providers ORDER BY id`,
    )
    .all();
  const digest = createHash('sha256')
    .update(rows.map((r) => JSON.stringify(r)).join('\n'))
    .digest('hex');
  return { count: rows.length, digest };
};

const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const fpBefore = providersFingerprint(before);
before.close();
console.log(`[迁移前] db=${DB}`);
console.log(`[迁移前] user_version=${vBefore}  providers 行数=${fpBefore.count} 指纹=${fpBefore.digest.slice(0, 16)}…`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v19，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移，请人工确认。`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v19-${stamp}.db`);
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
const fpAfter = providersFingerprint(after);
after.close();
console.log(`[迁移后] user_version=${vAfter}  providers 行数=${fpAfter.count} 指纹=${fpAfter.digest.slice(0, 16)}…`);

if (vAfter !== TARGET_VERSION) {
  console.error(`迁移后 user_version=${vAfter}，期望 ${TARGET_VERSION} —— 请用备份 ${backupPath} 排查。`);
  process.exit(4);
}
if (fpAfter.count !== fpBefore.count || fpAfter.digest !== fpBefore.digest) {
  console.error(
    `★ 表重建改变了存量数据（行数 ${fpBefore.count}→${fpAfter.count} 或内容指纹不一致）。` +
      `绝不该发生 —— 请停止部署，用备份 ${backupPath} 排查。`,
  );
  process.exit(5);
}

// 可写性烟测：'custom' 必须能 INSERT（CHECK 放宽是本迁移的全部目的），测完删掉。
{
  const rw = new Database(DB);
  try {
    rw.prepare(
      `INSERT INTO providers (id, name, base_url, active, protocol, cred_kind, created_at, updated_at)
       VALUES ('p__mig19_smoke', '迁移烟测', 'https://example.com', 0, 'custom', 'static', 1, 1)`,
    ).run();
  } catch (err) {
    console.error(`★ custom 协议仍写不进去（迁移未生效）：${err.message}`);
    process.exit(6);
  } finally {
    rw.prepare("DELETE FROM providers WHERE id = 'p__mig19_smoke'").run();
    rw.close();
  }
}
console.log('[烟测] protocol=custom 可写入 ✓（已回滚测试行）');
console.log('迁移 019 完成。');
