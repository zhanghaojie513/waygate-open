/**
 * 清理「已删除密钥」的历史请求数据（一次性维护工具，2026-10-08）。
 *
 * 背景：控制台删除 sk-waygate 密钥是硬删 client_keys 行，但该密钥的历史请求行
 * 仍在 requests/aggregates 里（日志本就是审计记录，保留是**正确默认**）。
 * 当那是测试数据、且用户明确要求清除时，用本工具一次性删除并**全维度重算聚合**，
 * 保持 api-contract §3.4 的「requests 合计 = aggregates 合计」不变式（verify-all A11）。
 *
 * 语义（与 requests.repo.log() 的增量口径逐字对齐）：
 *   小时桶 + dim=model(client 用 client_id)/status/total('-')，天桶 + dim=total('-')，
 *   errors = status>=400，桶格式本地时区 'YYYY-MM-DDTHH' / 'YYYY-MM-DD'。
 *   [v0.5.8 后] requests.credits 可空（上游未回报），SUM 必须 COALESCE(credits,0) ——
 *   与 requests.repo.log() 的 `credits ?? 0` 增量口径一致；否则含 NULL 行的桶 SUM 出
 *   NULL，撞 aggregates.credits 的 NOT NULL 约束（2026-10-11 实测踩过，事务已回滚）。
 *
 * 安全措施：
 *   ① 先 VACUUM INTO 全量备份到 <data>/backup/（删错可整库回滚）；
 *   ② --expect N 预期行数守卫：命中数不匹配立即中止（不写任何东西）；
 *   ③ 删除 + 重算在同一事务内，要么全成要么全不动。
 *
 * 用法（在 /opt/relay/server 下运行，better-sqlite3 才能解析）：
 *   node tools/cleanup-test-requests.mjs --hints "sk-waygate-a8c8…e937,sk-waygate-ee19…10d1" --expect 5
 *   （更名前签发的老密钥是 sk-relay- 形态，hint 参数按库里实际值传）
 *   RELAY_DATA_DIR 默认 /var/lib/relay。
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.RELAY_DATA_DIR || '/var/lib/relay';
const DB_PATH = join(DATA_DIR, 'relay.db');
const BACKUP_DIR = join(DATA_DIR, 'backup');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hintsRaw = arg('hints');
if (!hintsRaw) {
  console.error('用法: node tools/cleanup-test-requests.mjs --hints "hint1,hint2" [--expect N]');
  process.exit(2);
}
const hints = hintsRaw.split(',').map((h) => h.trim()).filter(Boolean);
const expect = arg('expect') ? Number(arg('expect')) : null;

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000');

const placeholders = hints.map(() => '?').join(',');
const rows = db
  .prepare(`SELECT id, ts, key_hint, client_id, model, status, credits FROM requests WHERE key_hint IN (${placeholders})`)
  .all(...hints);

console.log(`目标密钥 ${hints.length} 个，命中历史请求 ${rows.length} 行：`);
for (const r of rows) {
  console.log(
    `  #${r.id} ${new Date(r.ts).toISOString()} ${r.key_hint} client=${r.client_id} ${r.model} ${r.status} ${r.credits}cr`,
  );
}
if (rows.length === 0) {
  console.log('没有匹配行，无事可做。');
  db.close();
  process.exit(0);
}
if (expect !== null && rows.length !== expect) {
  console.error(`守卫中止：预期 ${expect} 行，实际 ${rows.length} 行。未做任何修改。`);
  db.close();
  process.exit(1);
}

// ① 全量备份（VACUUM INTO 产出一致性快照，含 WAL 中未 checkpoint 的页）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = join(BACKUP_DIR, `relay-pretestcleanup-${stamp}.db`);
mkdirSync(BACKUP_DIR, { recursive: true });
db.prepare(`VACUUM INTO ?`).run(backupPath);
console.log(`备份：${backupPath}`);

const before = db
  .prepare('SELECT COUNT(*) n, ROUND(SUM(COALESCE(credits,0)),2) c FROM requests')
  .get();
const aggBefore = db.prepare('SELECT COUNT(*) n FROM aggregates').get();

// ② 删除 + 全维度重算，单事务
const run = db.transaction(() => {
  db.prepare(`DELETE FROM requests WHERE key_hint IN (${placeholders})`).run(...hints);
  db.prepare('DELETE FROM aggregates').run();
  const now = Date.now();
  const insert = (sql) => db.prepare(sql).run(now);
  // 口径逐项对齐 requests.repo.log()；client 维度用 client_id（稳定键），绝不用名字快照
  insert(`
    INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
    SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime'), 'model', model, COUNT(*),
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), SUM(COALESCE(credits,0)), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms), ?
      FROM requests GROUP BY 1, 3`);
  insert(`
    INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
    SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime'), 'client', client_id, COUNT(*),
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), SUM(COALESCE(credits,0)), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms), ?
      FROM requests GROUP BY 1, 3`);
  insert(`
    INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
    SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime'), 'status', CAST(status AS TEXT), COUNT(*),
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), SUM(COALESCE(credits,0)), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms), ?
      FROM requests GROUP BY 1, 3`);
  insert(`
    INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
    SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime'), 'total', '-', COUNT(*),
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), SUM(COALESCE(credits,0)), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms), ?
      FROM requests GROUP BY 1`);
  insert(`
    INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime'), 'total', '-', COUNT(*),
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), SUM(COALESCE(credits,0)), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms), ?
      FROM requests GROUP BY 1`);
});
run();

const after = db
  .prepare('SELECT COUNT(*) n, ROUND(SUM(COALESCE(credits,0)),2) c FROM requests')
  .get();
const aggAfter = db.prepare('SELECT COUNT(*) n FROM aggregates').get();

// ③ 自检：不变式 requests 合计 = aggregates 小时 total 合计
const check = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM requests) AS req_n,
            (SELECT ROUND(SUM(COALESCE(credits,0)),2) FROM requests) AS req_c,
            (SELECT SUM(requests) FROM aggregates WHERE dim='total' AND length(bucket)=13) AS agg_n,
            (SELECT ROUND(SUM(COALESCE(credits,0)),2) FROM aggregates WHERE dim='total' AND length(bucket)=13) AS agg_c`,
  )
  .get();
const consistent = check.req_n === check.agg_n && Math.abs(check.req_c - check.agg_c) < 0.005;

console.log(
  `requests: ${before.n} 行 / ${before.c}cr → ${after.n} 行 / ${after.c}cr（删除 ${before.n - after.n} 行）`,
);
console.log(`aggregates: ${aggBefore.n} 桶 → ${aggAfter.n} 桶（全量重算）`);
console.log(`不变式自检: requests(${check.req_n}/${check.req_c}) == aggregates(${check.agg_n}/${check.agg_c}) → ${consistent ? '✅' : '❌'}`);
db.close();
if (!consistent) {
  console.error('不变式破坏！请用备份回滚：', backupPath);
  process.exit(1);
}
console.log('完成。');
