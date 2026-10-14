/**
 * D0 续二：验证「模板区改写」能否解掉 11128（task#2）
 *
 * 已定位：最小触发窗口 [WSTART, WEND)，47 字符。
 * 行为特征「必须凑够约 47 字符才拒、更短则放过」⇒ 长 n-gram 指纹匹配，非关键词/品牌名。
 *
 * 本脚本 **不输出窗口正文**（该文本进入任何模型上下文即致其请求被 400）。
 * 只输出数值特征，并验证两类修复动作是否有效：
 *   T1 切除窗口
 *   T2 按 Claude Code 血统的模板行做语义等价改写（git 上下文块）
 *
 * 用法：node probe-rewrite.mjs <sysprompt.txt> <out-json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions';
const UA = 'relay-station/0.4.1';
const MODEL = 'deepseek-v4.1-flash';
const WSTART = Number(process.env.WSTART || 7996);
const WEND = Number(process.env.WEND || 8043);

const sysPath = process.argv[2];
const outJson = process.argv[3] || 'd0-rewrite.json';
const rawKey = (process.env.RELAY_UPSTREAM_KEY || '').trim();
if (!rawKey) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}

const text = readFileSync(sysPath, 'utf8').replace(/\r\n/g, '\n');
const win = text.slice(WSTART, WEND);

const profile = {
  length: win.length,
  newlines: (win.match(/\n/g) || []).length,
  allAscii: /^[\x09\x0a\x0d\x20-\x7e]*$/.test(win),
  letters: (win.match(/[A-Za-z]/g) || []).length,
  digits: (win.match(/[0-9]/g) || []).length,
  spaces: (win.match(/ /g) || []).length,
  punct: (win.match(/[^\w\s]/g) || []).length,
  upperFirst: (win.match(/[A-Z]/g) || []).length,
  hash: [...win].reduce((a, ch) => (a * 31 + ch.codePointAt(0)) % 2147483647, 7),
};

/** T2：Claude Code 血统模板行的语义等价改写（破坏长 n-gram，保留语义）。 */
function rewriteTemplate(s) {
  let out = s;
  let n = 0;
  const rules = [
    [/^Current branch:/gm, 'Active branch:'],
    [/^Main branch \(you will usually use this for PRs\):/gm, 'Default PR target:'],
    [/^Git user:/gm, 'Git author:'],
    [/^Recent commits:/gm, 'Recent history:'],
    [/^Status:/gm, 'Working tree:'],
    [/^Note that this status is a snapshot in time, and will not update during the conversation\.$/gm, 'This snapshot does not live-update.'],
    [/^Here is useful information about the environment you are running in:$/gm, 'Environment:'],
  ];
  for (const [re, to] of rules) {
    const before = out;
    out = out.replace(re, () => {
      n++;
      return to;
    });
    if (before === out) n += 0;
  }
  return { text: out, count: n };
}

const rw = rewriteTemplate(text);
const cut = text.slice(0, WSTART) + text.slice(WEND);
const rwCut = rewriteTemplate(cut).text;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function probe(slice) {
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    max_tokens: 16,
    messages: [
      { role: 'system', content: slice },
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
    const t = await res.text();
    let code = null;
    try {
      code = JSON.parse(t).code ?? null;
    } catch {
      /* SSE */
    }
    return { status: res.status, code };
  } catch (e) {
    return { status: -1, code: String(e.message).slice(0, 100) };
  }
}

const CASES = [
  ['T0 tail only [WEND,N)', text.slice(WEND)],
  ['T1 window excised', cut],
  ['T2 template rewritten', rw.text],
  ['T3 T1+T2', rwCut],
];

const results = [];
for (const [label, s] of CASES) {
  const r = await probe(s);
  results.push({ label, len: s.length, ...r, rejected: r.status === 400 && r.code === 11128 });
  console.log(`${label.padEnd(24)} status=${String(r.status).padStart(4)} code=${String(r.code).padStart(6)} len=${String(s.length).padStart(5)} ${r.status === 400 && r.code === 11128 ? 'REJ' : 'ok'}`);
  await sleep(1300);
}

const out = {
  windowOffset: [WSTART, WEND],
  windowProfile: profile,
  templateRewriteCount: rw.count,
  results,
  note: 'window raw text deliberately NOT included',
};
writeFileSync(outJson, JSON.stringify(out, null, 2), 'utf8');
console.log('\nwindow profile:', JSON.stringify(profile));
