/**
 * note 标记覆盖门禁 —— 防止「发现一个补一个」的漏映射。
 *
 * 失败模式：后端新增/存在一个 note 取值，前端 `noteLabel()` 没有映射 → 该取值
 * 走 `map[first] ?? first` 兜底，**把英文内部标记原样抛到请求日志列上**。
 * 靠人肉发现必漏，所以把它变成机械检查。
 *
 * 枚举来源（两者并集，任一 token 都不能漏）：
 *   A) 契约 `docs/api-contract.md` §2.1.6 的「note 取值集合」表（文档口径）
 *   B) 后端 proxy 模块里**实际会写进 note** 的字面量（代码口径，机械提取）
 * 断言：A ∪ B 里每个 token 都能被 `noteLabel()` 的映射表翻译（即它是映射表的键）。
 * 动态取值（如 `max_tokens_raised_*`、`upstream_<code>`）无法静态枚举，按模式白名单放行。
 *
 * ⛔ 这里**不**维护一份手写的 token 清单 —— 清单来自契约与代码，抄一份就多一个会漂移的副本。
 * 用法：node web/scripts/check-note-tokens.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const CONTRACT = resolve(REPO, 'docs/api-contract.md');
const FORMAT = resolve(REPO, 'web/src/lib/format.ts');

const read = (p) => readFileSync(p, 'utf8');

/* ---------- A. 契约 §2.1.6「note 取值集合」表 ---------- */
function contractTokens() {
  const md = read(CONTRACT);
  const start = md.indexOf('**`note` 取值集合**');
  if (start < 0) throw new Error('契约里找不到 §2.1.6「note 取值集合」表');
  const block = md.slice(start, md.indexOf('\n**', start + 10));
  const tokens = new Set();
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? ''; // 只取「值」列
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) {
      for (const t of m[1].split('/')) {
        const tok = t.trim();
        if (tok) tokens.add(tok);
      }
    }
  }
  return tokens;
}

/* ---------- B. 后端实际写入 note 的字面量（机械提取） ---------- */
/* 只认「token 形状」的字面量（字母开头，含字母/数字/下划线/空格/连字符）——
   这样 `''`（空串）与 `' : '`（三元的残片）不会被误当成标记。

   ⚠️ 局限（team-lead 裁定：不改正则，但必须让局限可见）：
   这些正则**每处只抽第一个匹配的字面量**。例如 sse-stream.ts 的模式
   `note:[^\n]*?'([A-Za-z][A-Za-z0-9 _-]*)'` 只抓 `note:` 行上的**首个**字符串；
   若将来一行里写了多个 token（如 `note: a ? 'x' : b ? 'y' : 'z'`），只会抽到 `'x'`，
   `'y'` / `'z'` 会被漏掉。**所以一行出现多个 note 字面量时，需人工核对**（或把它拆成
   多行/多个赋值，让本门禁仍能逐个抽到）。本门禁能挡住「漏映射上屏」的绝大多数情况，
   但不是零漏的保证。 */
const LIT = String.raw`'([A-Za-z][A-Za-z0-9 _-]*)'`;
const rx = (body) => new RegExp(body, 'g');

/* ⚠️ 已知局限（task#37 记录，未修）：`sse-stream.ts` 的 pattern `note:[^\n]*?'...'`
   只提取 `note:` **同一行上的第一个**字面量。当前该行是
   `note: ok ? '' : endedNaturally || upstreamFailed ? 'stream_aborted' : 'client_detached'`，
   第一个「token 形状」的字面量是 `stream_aborted` —— 于是 `client_detached` 不会被机械提取，
   只能靠「契约 §2.1.6 表」这一路兜进来（本门禁取 A ∪ B 并集，故仍被覆盖）。
   若将来把 `client_detached` 只写进代码、漏进契约，本门禁**抓不到**。
   彻底修需把该行的字面量拆行或改成显式 push，属独立改动，留 backlog。 */
/**
 * 抽取 `this.fail(...)` 调用里**深度 1（直接实参）**位置的字面量 —— 那才是 note。
 *
 * 为什么不用宽松正则 `, 'xxx' \s* )`：它会误吞非 note 的实参。真实误报（2026-10-11）：
 * `readFileSync(file, 'utf8').trim()` 里的 `'utf8'` 被当成 note token 报进「契约未收录」，
 * 门禁因此长期红着 —— 而门禁一旦有假阳性，人就开始忽略它，等于没有门禁。
 * 按括号配对只看**直接实参**，既精确又不必维护一份「哪些字面量不是 note」的黑名单。
 *
 * 深度 ≥2 的字符串（如 `new RelayHttpError({ message: '…' })` 里的文案）天然被排除；
 * 模板串（如 `` `anthropic upstream ${res.status}` ``）不是单引号字面量，同样排除
 * —— 它属于动态取值族，靠契约表兜底。
 */
function failNoteLiterals(src) {
  const out = new Set();
  const anchor = 'this.fail(';
  let i = src.indexOf(anchor);
  while (i >= 0) {
    let j = i + anchor.length;
    let depth = 1;
    let quote = null;
    let buf = '';
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (quote) {
        if (ch === '\\') {
          buf += ch + src[j + 1];
          j += 2;
          continue;
        }
        if (ch === quote) {
          if (depth === 1) out.add(buf);
          quote = null;
          buf = '';
          j++;
          continue;
        }
        buf += ch;
        j++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        buf = '';
        j++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    i = src.indexOf(anchor, i + anchor.length);
  }
  return [...out].filter((t) => /^[A-Za-z][A-Za-z0-9 _-]*$/.test(t));
}

const BACKEND_SOURCES = [
  // 本地拒绝的翻译层：rejectionNote() 的 return 字面量 + persist() 的 notes.push
  { file: 'server/src/proxy/proxy-log.ts', patterns: [rx(`push\\(\\s*${LIT}`), rx(`return\\s+${LIT}`)] },
  // 改写时追加的标记
  { file: 'server/src/proxy/rewrite.ts', patterns: [rx(`push\\(\\s*${LIT}`)] },
  // 流式中断（三元表达式里的字面量：note: ok ? '' : 'stream_aborted'）
  // ⚠️ 局限（已知，不修）：本正则只取该 `note:` 行**第一个** token 形状的字面量
  //    （`note:[^\n]*?'([A-Za-z]...)'`）。当前 sse-stream 的写法是
  //    `note: ok ? '' : endedNaturally || upstreamFailed ? 'stream_aborted' : 'client_detached'`
  //    —— 空串不是 token 形状，故第一个捕获到的即 `stream_aborted`，而 `client_detached`
  //    由别处（契约 §2.1.6 表）覆盖，门禁仍成立。但这是**巧合而非保证**：
  //    若将来这行出现「两个非空 token 字面量」（如再嵌一层三元写 `... ? 'a' : 'b'`），
  //    第二个会被漏枚举。届时必须改本正则（逐个 matchAll 全部字面量），或把该表达式
  //    拆成显式赋值以让每个 token 各占一行。
  { file: 'server/src/proxy/sse-stream.ts', patterns: [rx(`note:[^\\n]*?${LIT}`)] },
  // fail() 的第三实参就是 note（'upstream unreachable' / 'upstream empty body' / …）。
  // 按括号配对抽取直接实参 —— 见 failNoteLiterals 的注释（宽松正则会误报 'utf8'）。
  { file: 'server/src/proxy/proxy.service.ts', extract: failNoteLiterals },
  // 上游失败码经 fail(ctx, failure, failure.code) 落进 note —— 这些 code 即 note 取值
  { file: 'server/src/proxy/upstream-errors.ts', patterns: [rx(`code:\\s*${LIT}`)] },
];

function backendTokens() {
  const tokens = new Set();
  const perFile = {};
  for (const { file, patterns, extract } of BACKEND_SOURCES) {
    const src = read(resolve(REPO, file));
    const found = new Set();
    if (extract) for (const t of extract(src)) found.add(t);
    for (const re of patterns ?? []) for (const m of src.matchAll(re)) found.add(m[1]);
    perFile[file] = [...found].sort();
    for (const t of found) tokens.add(t);
  }
  return { tokens, perFile };
}

/* ---------- 前端映射表（noteLabel 的真实来源，不抄副本） ---------- */
function labelMapKeys() {
  const src = read(FORMAT);
  /* [2026-10-07] 映射表从 noteLabel 函数体内抽成了模块级 `NOTE_MAP` 常量
     （noteLabel/noteLabels 两个导出共用）——提取源随之改为该常量块。 */
  const start = src.indexOf('const NOTE_MAP');
  if (start < 0) throw new Error('format.ts 里找不到 NOTE_MAP 常量（note 标签映射表）');
  const body = src.slice(start, src.indexOf('\n};', start));
  const constVal = /NOTE_CREDENTIAL_INVALID\s*=\s*'([^']+)'/.exec(src)?.[1];
  const keys = new Set();
  for (const m of body.matchAll(/(?:^|\s)(?:\[([A-Z_]+)\]|'([^']+)'|([A-Za-z_][\w]*))\s*:/g)) {
    if (m[1]) { if (constVal) keys.add(constVal); continue; }
    keys.add(m[2] ?? m[3]);
  }
  return { keys, constVal };
}

/* 无法静态枚举的动态取值族（后端模板串）—— 兜底会原样上屏，这是 team-lead 认可的诊断行为。
   它们**不在**本门禁的枚举里（枚举不出来），仅在此登记，供人对照。 */
const DYNAMIC_FAMILIES = ['max_tokens_raised_<n>_to_<m>', 'upstream_<上游业务码>'];

function main() {
  const contract = contractTokens();
  const { tokens: backend, perFile } = backendTokens();
  const { keys } = labelMapKeys();

  const must = new Set([...contract, ...backend]);
  const unresolved = [...must].filter((t) => !keys.has(t));

  console.log('note 标记覆盖门禁');
  console.log(`  A) 契约 §2.1.6 表 枚举：${contract.size} 个 → ${[...contract].join(', ')}`);
  console.log(`  B) 后端代码字面量 枚举：${backend.size} 个`);
  for (const [f, ts] of Object.entries(perFile)) console.log(`     · ${f.split('/').pop()}：${ts.length} 个 → ${ts.join(', ')}`);
  console.log(`  → 前端映射表键：${keys.size} 个`);
  console.log(`  → 需覆盖合计（A ∪ B）：${must.size} 个`);
  console.log(`  动态族（无法静态枚举、兜底原样上屏）：${DYNAMIC_FAMILIES.join('、')}`);

  const gap = [...backend].filter((t) => !contract.has(t));
  if (gap.length) {
    console.log(`\n  ⚠️ 契约 §2.1.6 表**未收录**但代码会写入的 token（${gap.length} 个）：`);
    console.log(`     ${gap.join(', ')}`);
    console.log('     → 契约不全也是缺陷：请后端把这份表补全（前端只按契约与代码核对，不自己猜）。');
  }

  if (unresolved.length) {
    console.log(`\n⛔ 以下 ${unresolved.length} 个 token 没有 noteLabel 映射，会以英文裸串上屏：`);
    for (const t of unresolved) console.log(`   - ${t}`);
    process.exit(1);
  }
  console.log(`\n✅ ${must.size} 个静态 token（契约 ∪ 后端代码）全部有可读映射，未映射将无法通过本门禁。`);
}

main();
// @zbiti-ai:f:153:c1269dd4
