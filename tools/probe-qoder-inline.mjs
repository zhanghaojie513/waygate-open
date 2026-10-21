/**
 * 探针四：Qoder 消息体的真实多模态形态是 **Gemini 风格 inlineData**。
 *
 * ── 前三轮已排除的形态 ──────────────────────────────────────────────────
 *   ✗ contents:[{type:'image', source:{type:'base64'}}]           → 模型答「您未提供图片」
 *   ✗ content+contents 双写 [{type:'image_url'}]                  → provider_error
 *   ✗ content:[image_url] 单独                                    → provider_error
 *   ✗ content:[image_url] + contents:[image 块]                   → 模型答「无图片」
 *   ✓ 把图片 JSON.stringify 进纯文本                                → 模型**能看图**（但大图超时）
 *
 * ── 本轮假设（来自 SDK 反混淆）──────────────────────────────────────────
 * `g4c(A)`:   {type:'image', source:{media_type, data}} → {inlineData:{mimeType, data}}
 * `sOi(inference)`: 输出里的 image → `{inlineData:{data: image_data, mimeType: media_type}}`
 *
 * 即消息数组里的元素是**裸 `{text}` / `{inlineData}`**（Gemini Content.parts 形状），
 * 而不是 OpenAI 的 `{type:'text'}` / `{type:'image_url'}`。
 *
 * 四组对照（1×1 红点，问颜色）：
 *   A. 基线（纯文本，验证链路）
 *   B. contents:[{text}, {inlineData:{mimeType,data}}]  + content 同形数组   ★ 主假设
 *   C. contents:[{text}, {inlineData}]                    （content 省略）
 *   D. contents:[{text}] + 顶层 images:[{...}]             （探另一个可能字段）
 *
 * 用法：
 *   RELAY_DATA_DIR=/var/lib/relay node tools/probe-qoder-inline.mjs p_qoder01 qfmodel
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

const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ASK = '这张图是什么颜色？只回答颜色词。';

const BLANK_USAGE = {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 },
};

function buildBody(messages, extra = {}) {
  return {
    request_id: randomUUID(), request_set_id: randomUUID(), chat_record_id: randomUUID(),
    stream: true, chat_task: 'chat',
    chat_context: {
      extra: { modelConfig: { is_reasoning: false, key: modelKey }, originalContent: { type: 'text', text: ASK } },
      text: { type: 'text', text: ASK },
    },
    session_id: randomUUID(), source: 1, version: '1.0.0',
    aliyun_user_type: identity.userType, session_type: 'qodercli',
    agent_id: 'agent_common', task_id: 'common',
    model_config: { key: modelKey, is_vl: true, is_reasoning: false, source: 'system' },
    messages,
    business: { id: randomUUID(), name: 'probe', begin_at: Date.now() },
    parameters: {},
    ...extra,
  };
}

const meta = () => ({ response_meta: { id: '', usage: JSON.parse(JSON.stringify(BLANK_USAGE)) }, reasoning_content_signature: '' });

function analyze(raw) {
  let text = ''; let reasoning = ''; let error = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj; try { obj = JSON.parse(payload); } catch { continue; }
    let inner = obj;
    if (typeof obj.body === 'string') { try { inner = JSON.parse(obj.body); } catch { inner = obj; } }
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

async function call(label, messages, extra) {
  const bodyStr = JSON.stringify(buildBody(messages, extra));
  const encoded = qEncode(bodyStr);
  const date = String(Math.floor(Date.now() / 1000));
  const path = DEFAULT_QODER_CHAT_PATH;
  const { session } = new QoderCredentialStore().session(providerId);
  const headers = cosyChatHeaders(session, identity, buildCosyBearer(session, date, encoded, path.split('?')[0]), date, 'text/event-stream');
  const t0 = Date.now();
  let firstAt = null; let raw = '';
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
    const verdict = error ? `✗ ${error}`
      : text.trim() ? `✓ ${JSON.stringify(text.slice(0, 60))}`
      : reasoning.trim() ? `△ 只有思考 ${JSON.stringify(reasoning.slice(0, 50))}` : '✗ 空回复';
    console.log(`[${label}] 首字节 ${firstAt ?? '无'}ms 总 ${Date.now() - t0}ms`);
    console.log(`        ${verdict}`);
  } catch (err) {
    console.log(`[${label}] 异常 ${Date.now() - t0}ms: ${err.message}`);
  }
}

const inline = { inlineData: { mimeType: 'image/png', data: PIXEL_B64 } };
const textPart = { text: ASK };

console.log(`模型 key=${modelKey} · 期望回答「红色」\n`);

await call('A 基线纯文本', [{ role: 'user', contents: [{ type: 'text', text: '你好' }], content: '你好', ...meta() }]);

/* ★ 主假设：Gemini 裸 parts 形状，content 与 contents 双写。 */
await call('B inlineData 双写', [{ role: 'user', content: [textPart, inline], contents: [textPart, inline], ...meta() }]);

/* C：只在 contents 里。 */
await call('C inlineData 仅 contents', [{ role: 'user', contents: [textPart, inline], ...meta() }]);

/* D：消息里只放文本，图片挂顶层 images[]（另一种可能）。 */
await call(
  'D 顶层 images 字段',
  [{ role: 'user', content: ASK, contents: [{ type: 'text', text: ASK }], ...meta() }],
  { images: [{ image_data: PIXEL_B64, media_type: 'image/png' }] },
);
