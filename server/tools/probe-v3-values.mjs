/**
 * /v3/config 第三轮：UA 取值与 X-User-Id 取值矩阵。
 * 已知必需：Authorization + User-Agent + X-User-Id。
 * 待定：UA 能否用 WorkBuddy/5.6.2（既有目录拉取 UA）或 relay-station/x.y（诚实 UA）；
 *       X-User-Id 的值是否任意（'probe' 可用，试 uuid 与固定串）。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-values.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const URL_ = 'https://copilot.tencent.com/v3/config';

const CASES = [
  ['UA=WorkBuddy uid=probe', 'WorkBuddy/5.6.2', 'probe'],
  ['UA=CLI uid=uuid', 'CLI/2.117.2 CodeBuddy/2.117.2', 'f0c1d2e3-4b5a-6789-abcd-ef0123456789'],
  ['UA=WorkBuddy uid=relay-station', 'WorkBuddy/5.6.2', 'relay-station'],
  ['UA=relay-station uid=probe', 'relay-station/0.4.1', 'probe'],
  ['UA=relay-station uid=empty', 'relay-station/0.4.1', ''],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, ua, uid] of CASES) {
  let verdict;
  try {
    const res = await fetch(URL_, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': ua,
        'X-User-Id': uid,
      },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => null);
    const models = j?.data?.models;
    verdict =
      Array.isArray(models) && models.length
        ? `models=${models.length}`
        : `NULL http=${res.status} code=${j?.code ?? '?'}`;
  } catch (e) {
    verdict = `ERR ${e.message}`;
  }
  console.log(`${name.padEnd(32)} ${verdict}`);
  await sleep(1200);
}
