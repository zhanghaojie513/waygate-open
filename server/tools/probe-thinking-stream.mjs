/**
 * 观察 thinking 流的逐帧形态（2026-10-07 排查「每词一条思考块」现象）。
 * 直连上游，stream:true + thinking enabled，打印前 60 个 data 帧的字段形状与 delta 片段。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-thinking-stream.mjs
 */
const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions';
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const body = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  // ★ 复刻 ZCode 真实请求的字段组合（rollout 里看到的形状）
  max_completion_tokens: 512,
  thinking: { type: 'enabled' },
  reasoning_effort: 'high',
  tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'A bat and ball cost 1.10 total; the bat costs 1.00 more than the ball. How much is the ball?' },
  ],
});
const res = await fetch(UPSTREAM, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'relay-station/0.4.1' },
  body,
  signal: AbortSignal.timeout(60_000),
});
console.log('status', res.status);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let n = 0;
const t0 = Date.now();
outer: for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (!line.startsWith('data:')) {
      console.log('NONDATA:', JSON.stringify(line));
      continue;
    }
    const p = line.slice(5).trim();
    if (p === '[DONE]') {
      console.log(`frame ${++n} [DONE]  (+${Date.now() - t0}ms)`);
      break outer;
    }
    let j;
    try {
      j = JSON.parse(p);
    } catch {
      console.log(`frame ${++n} BADJSON: ${p.slice(0, 100)}`);
      continue;
    }
    const c = j.choices && j.choices[0] ? j.choices[0] : {};
    const d = c.delta || {};
    console.log(
      `frame ${++n} (+${Date.now() - t0}ms) top:{${Object.keys(j).join(',')}} delta:{${Object.keys(d).join(',')}} finish:${c.finish_reason ?? '-'} ${JSON.stringify(d).slice(0, 140)}`,
    );
    if (n >= 120) break outer;
  }
}
await reader.cancel().catch(() => {});
console.log('total frames printed:', n);
