/**
 * 探针三：验证官方 SDK 的多模态形态是否能被 Qoder 网关接受。
 *
 * ── 前两次探针的结论（已确认）──────────────────────────────────────────
 *   ① `contents: [{type:'image', source:{type:'base64',...}}]`  → 200 但模型答「您未提供图片」
 *   ② `contents: [{type:'image_url', image_url:{url}}]` + `content:''` → provider_error
 *   ③ 把图片 JSON.stringify 进纯文本 text → 模型**居然能看图**（答对了颜色），但大图超时
 *
 * ── 本探针测什么 ───────────────────────────────────────────────────────
 * 反混淆官方 SDK（qoder-worker-runtime.obf.mjs）得到的真实形态：
 *
 *   // 有图时 n=true，content 直接发**数组**（含 image_url），而不是拼成文本
 *   messages.push({ role:'user', content: n ? blocks : joinText(blocks), contents: blocks })
 *
 *   // source → image_url 的转换（Jnl）：
 *   {type:'base64', media_type, data} → {type:'image_url', image_url:{url:`data:${mt};base64,${data}`}}
 *
 * 即：**`content` 才是网关判断多模态的字段**，且必须是数组；我们一直只填 `contents`（且是空串 content）。
 *
 * 四组对照（全部最小 1×1 红点图，排除体积变量）：
 *   A. 纯文本对照（基线）
 *   B. content=数组 + contents=数组（官方形态）★ 预期成功且模型答「红色」
 *   C. content=数组，contents 省略（若成功 → contents 并非必需）
 *   D. content=数组含 image_url，同时 contents 也含**旧式** image 块（混合）
 *
 * 用法：
 *   RELAY_DATA_DIR=/var/lib/relay node tools/probe-qoder-vl-shape.mjs p_qoder01 qfmodel
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DIST = process.env.RELAY_DIST ?? '/opt/relay/server/dist';
const { qEncode, buildCosyBearer, cosyChatHeaders, DEFAULT_QODER_CHAT_PATH } = require(
  join(DIST, 'proxy/qoder-upstream/cosy.js'),
);
const { QoderCredentialStore } = require(join(DIST, 'proxy/qoder-upstream/credential.js'));

const providerId = process.argv[2] ?? 'p_qoder01';
const modelKey = process.argv[3] ?? 'qfmodel';
const dataDir = process.env.RELAY_DATA_DIR ?? '/var/lib/relay';
const identity = JSON.parse(readFileSync(join(dataDir, 'providers', `${providerId}.key`), 'utf8'));

/* 1×1 纯红 PNG —— 提示词问「什么颜色」，正确答案是「红」。 */
const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PIXEL_B64}`;
const ASK = '这张图是什么颜色？只回答颜色词，不要解释。';

const BLANK_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_tokens_details: { cached_tokens: 0 },
};

/** 按官方形态构造一条 user 消息（content 与 contents 可分别指定）。 */
function userMsg({ content, contents }) {
  const m = {
    role: 'user',
    response_meta: { id: '', usage: JSON.parse(JSON.stringify(BLANK_USAGE)) },
    reasoning_content_signature: '',
  };
  if (content !== undefined) m.content = content;
  if (contents !== undefined) m.contents = contents;
  return m;
}

function buildBody(messages) {
  const firstText =
    (Array.isArray(messages[0].contents) ? messages[0].contents.find((c) => c.type === 'text')?.text : null) ??
    (typeof messages[0].content === 'string' ? messages[0].content : ASK);
  return {
    request_id: randomUUID(),
    request_set_id: randomUUID(),
    chat_record_id: randomUUID(),
    stream: true,
    chat_task: 'chat',
    chat_context: {
      extra: { modelConfig: { is_reasoning: false, key: modelKey }, originalContent: { type: 'text', text: firstText } },
      text: { type: 'text', text: firstText },
    },
    session_id: randomUUID(),
    source: 1,
    version: '1.0.0',
    aliyun_user_type: identity.userType,
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: modelKey, is_vl: true, is_reasoning: false, source: 'system' },
    messages,
    business: { id: randomUUID(), name: 'probe', begin_at: Date.now() },
    parameters: {},
  };
}

function analyze(raw) {
  let text = '';
  let reasoning = '';
  let error = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    let inner = obj;
    if (typeof obj.body === 'string') {
      try {
        inner = JSON.parse(obj.body);
      } catch {
        inner = obj;
      }
    }
    if (inner?.code === 'provider_error' || /Error in upstream/i.test(String(inner?.message ?? ''))) {
      error = `${inner.code ?? 'error'}: ${String(inner.message ?? '').slice(0, 100)}`;
    }
    const d = inner?.choices?.[0]?.delta;
    if (d) {
      if (typeof d.content === 'string') text += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    }
  }
  return { text, reasoning, error };
}

async function call(label, messages) {
  const bodyStr = JSON.stringify(buildBody(messages));
  const encoded = qEncode(bodyStr);
  const date = String(Math.floor(Date.now() / 1000));
  const path = DEFAULT_QODER_CHAT_PATH;
  const { session } = new QoderCredentialStore().session(providerId);
  const headers = cosyChatHeaders(session, identity, buildCosyBearer(session, date, encoded, path.split('?')[0]), date, 'text/event-stream');

  const t0 = Date.now();
  let firstAt = null;
  let raw = '';
  try {
    const res = await fetch(`https://gateway.qoder.com.cn${path}`, {
      method: 'POST', headers, body: encoded, signal: AbortSignal.timeout(75_000),
    });
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (firstAt === null) firstAt = Date.now() - t0;
        raw += new TextDecoder().decode(r.value);
      }
    }
    const { text, reasoning, error } = analyze(raw);
    const verdict = error
      ? `✗ ${error}`
      : text.trim()
        ? `✓ 正文 ${JSON.stringify(text.slice(0, 50))}`
        : reasoning.trim()
          ? '△ 只有思考无正文'
          : '✗ 空回复';
    console.log(`[${label}] JSON≈${(bodyStr.length / 1024).toFixed(1)}KB 首字节 ${firstAt ?? '无'}ms 总 ${Date.now() - t0}ms`);
    console.log(`        ${verdict}`);
  } catch (err) {
    console.log(`[${label}] 异常 ${Date.now() - t0}ms: ${err.message}`);
  }
}

const textBlock = { type: 'text', text: ASK };
const imageUrlBlock = { type: 'image_url', image_url: { url: DATA_URL } };
const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_B64 } };

console.log(`模型 key=${modelKey} · 期待回答「红/红色」\n`);

await call('A 纯文本（基线）', [userMsg({ content: '你好，一个词回答', contents: [{ type: 'text', text: '你好，一个词回答' }] })]);

/* ★ 官方形态：content 与 contents 同为一个数组，内含 image_url。 */
await call('B 官方形态（content+contents 双写数组）', [
  userMsg({ content: [textBlock, imageUrlBlock], contents: [textBlock, imageUrlBlock] }),
]);

/* C：只给 content 数组，不给 contents —— 判断 contents 是否必需。 */
await call('C 仅 content 数组', [userMsg({ content: [textBlock, imageUrlBlock] })]);

/* D：content 数组（image_url）+ contents 用旧式 image 块 —— 探测网关读哪个字段。 */
await call('D content=image_url，contents=image 块', [
  userMsg({ content: [textBlock, imageUrlBlock], contents: [textBlock, imageBlock] }),
]);
