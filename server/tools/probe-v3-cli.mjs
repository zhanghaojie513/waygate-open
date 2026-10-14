/**
 * /v3/config 复测（2026-10-07）：buddy-proxy 的 CLI 身份姿势 × ck_ key × 三域名。
 * 上一轮用桌面身份（VSCode/CodeBuddy 4.9.x）拿回 models:null —— 本轮验证
 * 「CLI 形状的身份 + ck_」能否取回带 credits 的模型表。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-cli.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const IDE = '2.117.2';
const bases = [
  'https://copilot.tencent.com/v3/config',
  'https://www.codebuddy.ai/v3/config',
  'https://www.codebuddy.cn/v3/config',
];
for (const url of bases) {
  const u = new URL(url);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'X-IDE-Type': 'CLI',
      'X-IDE-Name': 'CLI',
      'X-IDE-Version': IDE,
      'User-Agent': `CLI/${IDE} CodeBuddy/${IDE}`,
      'X-Product': 'SaaS',
      'X-User-Id': 'probe',
      'X-Domain': u.hostname,
      'X-Agent-Intent': 'craft',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(15000),
  }).catch((e) => ({ status: -1, text: async () => 'ERR ' + e.message }));
  const body = typeof res.text === 'function' ? await res.text() : String(body);
  let j = null;
  try { j = JSON.parse(body); } catch {}
  const root = j && (j.data || j);
  let models = root && root.models;
  if (models && !Array.isArray(models) && models.models) models = models.models;
  const host = u.hostname;
  if (Array.isArray(models) && models.length > 0) {
    console.log(`✅ ${host}: HTTP ${res.status} models=${models.length}`);
    for (const m of models.slice(0, 40)) {
      const extra = {};
      for (const [k, v] of Object.entries(m)) if (/credit|rate|multi|cost/i.test(k)) extra[k] = v;
      console.log(`   ${m.id ?? m.modelId}  ${JSON.stringify(extra)}`);
    }
  } else {
    console.log(`❌ ${host}: HTTP ${res.status} apiCode=${j && j.code} models=${models === undefined ? 'absent' : 'null'} body=${body.slice(0, 120)}`);
  }
}
