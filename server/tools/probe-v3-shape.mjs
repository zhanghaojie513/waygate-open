/**
 * /v3/config 第四轮：WorkBuddy UA 视角的完整模型对象结构（供解析器设计）。
 * 输出：前 2 个模型的完整 JSON + 全部 id→credits 对照 + 与 CLI 视角的差集。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-shape.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const URL_ = 'https://copilot.tencent.com/v3/config';

async function get(ua) {
  const res = await fetch(URL_, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': ua,
      'X-User-Id': 'relay-station',
    },
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  return j?.data?.models ?? [];
}

const wb = await get('WorkBuddy/5.6.2');
const cli = await get('CLI/2.117.2 CodeBuddy/2.117.2');

console.log(`WorkBuddy models=${wb.length}  CLI models=${cli.length}`);
console.log('\n== sample full objects (first 2, WorkBuddy view) ==');
for (const m of wb.slice(0, 2)) console.log(JSON.stringify(m, null, 1));

console.log('\n== WorkBuddy id -> credits ==');
for (const m of wb) console.log(`${String(m.id ?? m.modelId ?? '?').padEnd(28)} ${JSON.stringify(m.credits)}`);

const cliIds = new Set(cli.map((m) => m.id ?? m.modelId));
console.log('\n== only in WorkBuddy view ==');
for (const m of wb) {
  const id = m.id ?? m.modelId;
  if (!cliIds.has(id)) console.log(`${id} credits=${JSON.stringify(m.credits)}`);
}
