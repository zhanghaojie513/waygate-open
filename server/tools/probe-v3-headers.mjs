/**
 * /v3/config 头子集二分（Node/undici 环境下；curl 全组合都 NULL，栈本身被降级）。
 * 目标：找出能拿回 models 的最小头集合，供目录同步实现使用。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-headers.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const URL_ = 'https://copilot.tencent.com/v3/config';
const IDE = '2.117.2';

const SETS = {
  S0_full: {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': IDE,
    'User-Agent': `CLI/${IDE} CodeBuddy/${IDE}`,
    'X-Product': 'SaaS',
    'X-User-Id': 'probe',
    'X-Domain': 'copilot.tencent.com',
    'X-Agent-Intent': 'craft',
    'X-Requested-With': 'XMLHttpRequest',
  },
  S1_no_intent_headers: null, // 逐组剔除，见下
  S2_no_product: null,
  S3_no_userid: null,
  S4_minimal: null,
  S5_no_ide_trio: null,
  S6_no_ua: null,
  S7_auth_only: null,
};
function without(base, ...drop) {
  const h = { ...base };
  for (const d of drop) delete h[d];
  return h;
}
const FULL = SETS.S0_full;
SETS.S1_no_intent_headers = without(FULL, 'X-Agent-Intent', 'X-Requested-With', 'X-Domain');
SETS.S2_no_product = without(FULL, 'X-Product', 'X-Agent-Intent', 'X-Requested-With', 'X-Domain');
SETS.S3_no_userid = without(FULL, 'X-User-Id', 'X-Agent-Intent', 'X-Requested-With', 'X-Domain', 'X-Product');
SETS.S4_minimal = {
  Accept: 'application/json',
  Authorization: `Bearer ${key}`,
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': IDE,
  'User-Agent': `CLI/${IDE} CodeBuddy/${IDE}`,
};
SETS.S5_no_ide_trio = without(FULL, 'X-IDE-Type', 'X-IDE-Name', 'X-IDE-Version');
SETS.S6_no_ua = without(FULL, 'User-Agent');
SETS.S7_auth_only = { Accept: 'application/json', Authorization: `Bearer ${key}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, headers] of Object.entries(SETS)) {
  let verdict;
  try {
    const res = await fetch(URL_, { headers, signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => null);
    const models = j?.data?.models;
    verdict =
      Array.isArray(models) && models.length
        ? `models=${models.length} http=${res.status}`
        : `NULL http=${res.status} code=${j?.code ?? '?'}`;
  } catch (e) {
    verdict = `ERR ${e.message}`;
  }
  console.log(`${name.padEnd(22)} ${verdict}`);
  await sleep(1200);
}
