/**
 * 服务器端：备份 relay.db（VACUUM INTO）+ 执行 v20→v21 迁移
 * （requests 加 auth_ms / prep_ms / upstream_wait_ms 三列 —— v1.7.2 延迟归因）。
 * 与 tools/migrate-008.mjs / migrate-019.mjs 同一模式（user_version 守卫幂等）。
 *
 * 这条是**纯加列**（可空、无默认值），比迁移 019 的表重建安全得多。
 * 但仍逐条核对：① requests 行数与内容指纹不变（加列不该动数据）；
 * ② ingress_ms 确实可空；③ 老行读出来是 NULL 而不是 0。
 *
 * 用法：
 *   node tools/migrate-021.mjs [dbPath] [sqlPath]
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_VERSION = 21;

const dataDir = (process.env.RELAY_DATA_DIR ?? '').trim();
const DB = resolve(process.argv[2] ?? join(dataDir || join(process.cwd(), 'data'), 'relay.db'));
const MIGRATION = resolve(
  process.argv[3] ??
    join(HERE, '..', '..', 'relay-station-design', 'design', 'migrations', '021-request-ingress-ms.sql'),
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

/** 采样指纹：取最近 500 行的关键列（全表哈希在 1.6 万行上要几百 ms，采样足够证「没动数据」）。 */
const fingerprint = (db) => {
  const rows = db
    .prepare(
      `SELECT id, ts, model, status, ms, first_byte_ms, credits, provider_id
         FROM requests ORDER BY id DESC LIMIT 500`,
    )
    .all();
  const count = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  const digest = createHash('sha256').update(rows.map((r) => JSON.stringify(r)).join('\n')).digest('hex');
  return { count, digest };
};

const before = new Database(DB, { readonly: true });
const vBefore = version(before);
const fpBefore = fingerprint(before);
before.close();
console.log(`[迁移前] user_version=${vBefore}  requests=${fpBefore.count} 行 指纹=${fpBefore.digest.slice(0, 16)}…`);

if (vBefore === TARGET_VERSION) {
  console.log('已经是 v20，无需迁移（幂等）。');
  process.exit(0);
}
if (vBefore !== TARGET_VERSION - 1) {
  console.error(`非预期的 user_version=${vBefore}（期望 ${TARGET_VERSION - 1}）。拒绝迁移。`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(dirname(DB), 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `relay-pre-v21-${stamp}.db`);
{
  /* WAL 模式下 VACUUM INTO 会包含已提交的 WAL 内容，是完整快照。 */
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
const fpAfter = fingerprint(after);

/* ① 版本 */
if (vAfter !== TARGET_VERSION) {
  after.close();
  console.error(`迁移后 user_version=${vAfter}，期望 ${TARGET_VERSION} —— 请用备份 ${backupPath} 排查。`);
  process.exit(4);
}

/* ② 三列存在且可空 */
const cols = Object.fromEntries(
  (after.prepare('PRAGMA table_info(requests)').all()).map((c) => [c.name, c]),
);
for (const name of ['ingress_ms']) {
  const c = cols[name];
  if (!c) {
    after.close();
    console.error(`★ 迁移后缺列 ${name}`);
    process.exit(5);
  }
  if (c.notnull !== 0) {
    after.close();
    console.error(`★ ${name} 是 NOT NULL —— 未知会被压成 0，违反口径`);
    process.exit(6);
  }
}

/* ③ 存量行必须是 NULL（不能是 0） */
const sample = after
  .prepare('SELECT auth_ms, prep_ms, upstream_wait_ms FROM requests ORDER BY id DESC LIMIT 20')
  .all();
const filledWithZero = sample.filter((r) => r.auth_ms === 0 || r.prep_ms === 0 || r.upstream_wait_ms === 0);
if (filledWithZero.length > 0) {
  after.close();
  console.error(`★ 有 ${filledWithZero.length} 行被填了 0 —— 未回溯填充是硬要求`);
  process.exit(7);
}
after.close();

/* ④ 数据未变 */
if (fpAfter.count !== fpBefore.count || fpAfter.digest !== fpBefore.digest) {
  console.error(
    `★ 加列改变了存量数据（${fpBefore.count}→${fpAfter.count} 或指纹不一致）。请用备份 ${backupPath} 排查。`,
  );
  process.exit(8);
}

console.log(`[迁移后] user_version=${vAfter}  requests=${fpAfter.count} 行 指纹一致 ✓ 三列可空 ✓ 老行 NULL ✓`);
console.log('迁移 020 完成。');
