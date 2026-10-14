/**
 * 一次性数据订正（2026-10-07）：把 2026-10-07 15:46（上游实扣上线）之前的历史行积分
 * 按校准量纲公式重算（旧公式量纲差 1000 倍），并同步 aggregates 桶。
 *
 *   new = ROUND(((pt − cached) + cached × k + ct) × 0.28 × multiplier / 1000, 2)   k = 0.1
 *
 * 选择条件：note 不含 credits_from_upstream（新口径行不动）且 credits ≠ 0（失败/缺 usage 行本来就是 0）。
 * 留痕：note 追加 credits_recalibrated；cached>0 的补 cache_discounted。
 * 用法：
 *   node recalibrate-credits.cjs <db>            # 预览（只读）
 *   node recalibrate-credits.cjs <db> --apply    # 执行（事务 + 桶同步；执行前请另有 VACUUM 备份）
 */
const Database = require('/opt/relay/server/node_modules/better-sqlite3');
const APPLY = process.argv.includes('--apply');
const db = new Database(process.argv[2], APPLY ? undefined : { readonly: true });

const K = 0.1;
const BASE = 0.28;
const mults = new Map(
  db.prepare('SELECT id, multiplier FROM model_catalog').all().map((r) => [r.id, r.multiplier]),
);

const pad = (n) => String(n).padStart(2, '0');
const hourBucket = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
};
const dayBucket = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const rows = db
  .prepare(
    `SELECT id, ts, model, status, prompt_tokens pt, completion_tokens ct, cached_tokens cached, credits, note
       FROM requests
      WHERE note NOT LIKE '%credits_from_upstream%' AND credits <> 0`,
  )
  .all();

const round2 = (v) => Math.round(v * 100) / 100;
const planned = [];
for (const r of rows) {
  const mult = mults.get(r.model) ?? 1;
  const hit = Math.min(Math.max(r.cached, 0), r.pt);
  const effective = hit > 0 && K < 1 ? r.pt - hit + hit * K : r.pt;
  const next = round2(((effective + r.ct) * BASE * mult) / 1000);
  const notes = [r.note || ''];
  if (hit > 0 && K < 1 && !notes[0].includes('cache_discounted')) notes.push('cache_discounted');
  if (!notes[0].includes('credits_recalibrated')) notes.push('credits_recalibrated');
  planned.push({ ...r, next, note: notes.filter(Boolean).join(','), delta: round2(next - r.credits) });
}

console.log(`== 订正${APPLY ? '执行' : '预览'}：命中 ${planned.length} 行 ==`);
let oldSum = 0;
let newSum = 0;
for (const p of planned) {
  oldSum += p.credits;
  newSum += p.next;
  console.log(
    `#${p.id} ${p.model} pt=${p.pt} cached=${p.cached} ct=${p.ct} ×${mults.get(p.model) ?? 'null→1'} : ${p.credits} → ${p.next} (Δ${p.delta})`,
  );
}
console.log(`合计：${round2(oldSum)} → ${round2(newSum)}`);

if (!APPLY) {
  console.log('（预览模式，未写入。加 --apply 执行。）');
  process.exit(0);
}

// 事务：改行 + 同步 5 个聚合桶的 credits
const updRow = db.prepare('UPDATE requests SET credits = ?, note = ? WHERE id = ?');
const updBucket = db.prepare(
  'UPDATE aggregates SET credits = ROUND(credits + ?, 2) WHERE bucket = ? AND dim = ? AND dim_value = ?',
);
const tx = db.transaction(() => {
  for (const p of planned) {
    updRow.run(p.next, p.note, p.id);
    const d = p.delta;
    if (d === 0) continue;
    const h = hourBucket(p['ts']);
    const day = dayBucket(p['ts']);
    updBucket.run(d, h, 'model', p.model);
    updBucket.run(d, h, 'status', String(p.status));
    updBucket.run(d, h, 'total', '-');
    updBucket.run(d, day, 'total', '-');
    // client 桶也要同步：需要 client_id
    const cid = db.prepare('SELECT client_id FROM requests WHERE id = ?').get(p.id).client_id;
    updBucket.run(d, h, 'client', cid);
  }
});
tx();

// 验证：按天 total 桶 vs requests 直算
const check = db
  .prepare(
    `SELECT (SELECT ROUND(SUM(credits),2) FROM requests) AS byRows,
            (SELECT ROUND(SUM(credits),2) FROM aggregates WHERE dim='total' AND length(bucket)=10) AS byDayBuckets`,
  )
  .get();
console.log('== 校验：requests 合计 vs day-total 桶合计 ==', JSON.stringify(check));
