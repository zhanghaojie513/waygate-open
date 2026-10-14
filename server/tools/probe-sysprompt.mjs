/**
 * D0 决定性实验：定位 11128 的触发机制（task#2）
 *
 * 四组对照，一次区分：
 *   X0 原样                基线，期望 400/11128
 *   X1 仅 A1 零宽脱敏      200 ⇒ H1「内容审核关键词误触」成立
 *   X2 仅 A2 身份中性化    200 ⇒ H2「第三方客户端身份指纹」成立
 *   X3 A1 + A2             200 ⇒ 修复方案定性
 *
 * 关键纪律：**本脚本只输出状态码与上游业务码，绝不打印提示正文或响应正文**。
 * 原因（实测教训）：ZCode 的系统提示一旦进入任何模型上下文，
 * 该模型的请求即被上游判为 unapproved channel 而 400。故正文只在磁盘与 HTTP 之间流动。
 *
 * 用法：node probe-sysprompt.mjs <sysprompt.txt> <out-report.md>
 * 依赖：Node >= 22，零依赖。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions';
const UA = 'relay-station/0.4.1';
const MODEL = 'deepseek-v4.1-flash';
const ZWSP = '\u200B';

const sysPath = process.argv[2];
const outPath = process.argv[3] || 'd0-report.md';
if (!sysPath) {
  console.error('usage: node probe-sysprompt.mjs <sysprompt.txt> <out-report.md>');
  process.exit(2);
}

const rawKey = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!rawKey) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
/** 掩码：只保留前缀与长度，任何输出都不得出现完整 key。 */
const mask = (k) => `${k.slice(0, 3)}***(${k.length})`;

const original = readFileSync(sysPath, 'utf8');

/** A1：在敏感词中部插入零宽空格，令关键词匹配失效。 */
const MASK_WORDS = [
  'DoS',
  'exploit',
  'C2',
  'detection evasion',
  'supply chain',
  'mass targeting',
  'credential testing',
  'malicious',
];

function maskKeywords(text) {
  let out = text;
  let n = 0;
  for (const w of MASK_WORDS) {
    const parts = out.split(w);
    if (parts.length > 1) {
      n += parts.length - 1;
      const mid = Math.max(1, Math.floor(w.length / 2));
      out = parts.join(w.slice(0, mid) + ZWSP + w.slice(mid));
    }
  }
  return { text: out, count: n };
}

/** A2：抹掉客户端身份特征，语义等价改写。 */
const IDENTITY_RULES = [
  ['You are ZCode, an interactive coding agent', 'You are an interactive coding agent'],
  ['You are an interactive ZCode agent', 'You are an interactive coding agent'],
  ['ZCode', 'the assistant'],
];

function neutralizeIdentity(text) {
  let out = text;
  let n = 0;
  for (const [from, to] of IDENTITY_RULES) {
    const parts = out.split(from);
    if (parts.length > 1) {
      n += parts.length - 1;
      out = parts.join(to);
    }
  }
  return { text: out, count: n };
}

const a1 = maskKeywords(original);
const a2 = neutralizeIdentity(original);
const both = neutralizeIdentity(a1.text);

const CASES = [
  ['X0', 'original', original, 'baseline'],
  ['X1', 'A1 mask only', a1.text, `masked=${a1.count}`],
  ['X2', 'A2 identity only', a2.text, `neutralized=${a2.count}`],
  ['X3', 'A1+A2', both.text, `masked=${a1.count},neutralized=${both.count}`],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, system) {
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    max_tokens: 16,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'Reply with OK only.' },
    ],
  });
  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rawKey}`,
        'content-type': 'application/json',
        'user-agent': UA,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let code = null;
    let msg = null;
    try {
      const j = JSON.parse(text);
      code = j.code ?? null;
      msg = typeof j.msg === 'string' ? j.msg : null;
    } catch {
      /* 成功时为 SSE，不解析正文 */
    }
    return {
      label,
      status: res.status,
      code,
      msg,
      len: system.length,
      raw: res.status === 200 ? '<SSE 200, body omitted by design>' : text.slice(0, 800),
    };
  } catch (e) {
    return { label, status: -1, code: null, msg: e.message, len: system.length, raw: String(e) };
  }
}

const results = [];
for (const [label, desc, text, extra] of CASES) {
  const r = await run(label, text);
  r.desc = desc;
  r.extra = extra;
  results.push(r);
  console.log(
    `${label.padEnd(3)} ${String(r.status).padStart(4)} code=${String(r.code)} len=${r.len} ${desc} ${extra}`,
  );
  await sleep(1500);
}

const verdictOf = (x0, x1, x2, x3) => {
  if (x0.status !== 400) return 'X0 基线未复现 400 ⇒ 假设前提动摇，需重新定性';
  const h1 = x1.status === 200;
  const h2 = x2.status === 200;
  if (h1 && h2) return 'H1 与 H2 均成立（两个因子独立可触发）';
  if (h1) return 'H1 成立：内容审核关键词误触';
  if (h2) return 'H2 成立：第三方客户端身份指纹';
  if (x3.status === 200) return 'H1/H2 单因子均不足，但组合可解（需补充因子）';
  return 'X1/X2/X3 均未通过 ⇒ 根因另有其它，需继续二分';
};

const verdict = verdictOf(...results);
const lines = [
  '# D0 决定性实验报告',
  '',
  `- 上游：${UPSTREAM}`,
  `- 模型：${MODEL}　UA：${UA}`,
  `- key：${mask(rawKey)}`,
  `- 提示源：${basename(sysPath)}（${original.length} 字符）`,
  `- 时间：${new Date().toISOString()}`,
  '',
  '## 结论',
  '',
  `**${verdict}**`,
  '',
  '## 原始结果',
  '',
  '| 组 | 说明 | HTTP | 上游 code | system 长度 | 附加 |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) => `| ${r.label} | ${r.desc} | ${r.status} | ${r.code ?? '-'} | ${r.len} | ${r.extra} |`,
  ),
  '',
  '## 原始响应（非 200 时保留全文）',
  '',
  ...results.map((r) => `### ${r.label}\n\n\`\`\`\n${r.raw}\n\`\`\`\n`),
];
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`\nVERDICT: ${verdict}`);
console.log(`report -> ${outPath}`);
