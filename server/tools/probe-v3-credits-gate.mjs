/**
 * /v3/config 第五轮：credits 字段的门禁因子二分。
 * 已知：UA=CLI(32 模型带 credits)；UA=WorkBuddy(37 模型无 credits)。
 * 待定：决定 credits 的是 UA 还是 X-IDE-* 头。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-credits-gate.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const URL_ = 'https://copilot.tencent.com/v3/config';
const IDE = '2.117.2';
const CLI_UA = `CLI/${IDE} CodeBuddy/${IDE}`;
const WB_UA = 'WorkBuddy/5.6.2';

const CASES = [
  ['UA=CLI, no IDE hdrs', { 'User-Agent': CLI_UA }],
  ['UA=WB + IDE trio', { 'User-Agent': WB_UA, 'X-IDE-Type': 'CLI', 'X-IDE-Name': 'CLI', 'X-IDE-Version': IDE }],
  ['UA=WB + X-IDE-Type only', { 'User-Agent': WB_UA, 'X-IDE-Type': 'CLI' }],
  ['UA=CLI + X-IDE-Type=VSCODE', { 'User-Agent': CLI_UA, 'X-IDE-Type': 'VSCODE' }],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, extra] of CASES) {
  try {
    const res = await fetch(URL_, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
        'X-User-Id': 'relay-station',
        ...extra,
      },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    const models = j?.data?.models ?? [];
    const withCredits = models.filter((m) => typeof m.credits === 'string' && m.credits.includes('x'));
    console.log(
      `${name.padEnd(30)} http=${res.status} models=${models.length} withCredits=${withCredits.length} sample=${withCredits[0]?.id ?? '-'}:${withCredits[0]?.credits ?? '-'}`,
    );
  } catch (e) {
    console.log(`${name.padEnd(30)} ERR ${e.message}`);
  }
  await sleep(1200);
}
