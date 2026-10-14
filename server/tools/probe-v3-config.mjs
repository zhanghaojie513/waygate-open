/**
 * 用完整伪装头打 GET /v3/config，取权威 credits 倍率（2026-10-07 积分数值核查）。
 * 头族照抄 vendor workbuddy-bridge 的 buildHeaders()（实测与官方客户端一致）。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-v3-config.mjs
 */
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const APP_VERSION = '4.9.29177644';
const IDE_VERSION = '1.119.0';
const trace = () => crypto.randomUUID().replace(/-/g, '');
const traceId = trace();
const spanId = traceId.slice(0, 16);
const parentSpanId = traceId.slice(16, 32);
import('node:crypto').then(({ randomUUID }) => {
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': 'VSCode',
    'X-IDE-Name': 'VSCode',
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': 'production',
    'X-Domain': 'www.codebuddy.cn',
    'X-Product': 'SaaS',
    'User-Agent': `VSCode/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
    'X-Request-ID': randomUUID().replace(/-/g, ''),
    'X-Conversation-ID': randomUUID().replace(/-/g, ''),
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    Authorization: `Bearer ${key}`,
  };
  fetch('https://copilot.tencent.com/v3/config', { headers: h, signal: AbortSignal.timeout(15000) })
    .then(async (res) => {
      const text = await res.text();
      console.log('HTTP', res.status, text.length, 'bytes');
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        console.log('非 JSON：', text.slice(0, 300));
        return;
      }
      const dumpModels = (arr, label) => {
        if (!Array.isArray(arr)) return;
        console.log(`-- ${label} (${arr.length}) --`);
        for (const m of arr) {
          const extra = {};
          for (const [k, v] of Object.entries(m)) {
            if (/credit|rate|cost|price|multi|billing|weight/i.test(k)) extra[k] = v;
          }
          console.log(`${m.id ?? m.model ?? m.name}  ${JSON.stringify(extra)}`);
        }
      };
      const data = j.data ?? j;
      dumpModels(data.models, 'data.models');
      if (Array.isArray(data.agents)) {
        for (const a of data.agents) dumpModels(a.models, `agents[${a.name ?? a.id ?? 0}].models`);
      }
      if (!data.models && !data.agents) {
        console.log('形状：top=', Object.keys(j), ' data=', data && typeof data === 'object' ? Object.keys(data) : typeof data);
        console.log(text.slice(0, 400));
      }
    })
    .catch((e) => console.log('fetch error:', e.message));
});
