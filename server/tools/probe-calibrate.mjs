/**
 * 积分计价校准实验（2026-10-07）：余额差法。
 * 打两条 token 数已知的请求，用户事后报官方余额差，与这里的 usage 对解出真实计价公式。
 *   A = 全新 ~2000 token 提示（unique 随机内容，必无缓存命中）
 *   B = 与 A 完全相同的请求重发（应几乎全部缓存命中）
 * 模型与生产一致（deepseek-v4.1-flash，thinking enabled，max_tokens 压小控成本）。
 * 用法: RELAY_UPSTREAM_KEY=ck_... node probe-calibrate.mjs
 */
const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions';
const key = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!key) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}

// ~2000 token 的唯一提示词（英文词 ≈1.3 token；随机种子保证绝不与历史缓存撞前缀）
const seed = Date.now() ^ (Math.random() * 0xffffffff);
let s = seed >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zebra amber cedar birch maple willow bamboo cypress aspen'.split(' ');
const filler = Array.from({ length: 1600 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const PROMPT = `Reference blob ${seed}:\n${filler}\n\nReply with OK only.`;

async function call(label) {
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 16,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: PROMPT },
    ],
  });
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'relay-station/0.4.1' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  // 非流式失败的形状直接打出来
  if (res.status !== 200) {
    console.log(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return null;
  }
  // 流式：逐行解析 data: 帧，取最后一帧带真实数值的 usage（嵌套大括号，不能靠正则抠）
  let usage = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      const u = j && j.usage;
      if (u && typeof u.prompt_tokens === 'number') usage = u;
    } catch {}
  }
  console.log(`${label}: HTTP 200, usage=${JSON.stringify(usage)}`);
  return usage;
}

const t = new Date().toISOString();
console.log(`== 校准探针 ${t} ==`);
const a = await call('A(全新,应无缓存)');
await new Promise((r) => setTimeout(r, 3000));
const b = await call('B(原样重发,应全缓存)');
console.log('---');
console.log('seed:', seed);
console.log('A.usage =', JSON.stringify(a));
console.log('B.usage =', JSON.stringify(b));
console.log('提示词字符数:', PROMPT.length);
