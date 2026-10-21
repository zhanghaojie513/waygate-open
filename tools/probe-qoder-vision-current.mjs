/**
 * 探针二：验证**当前实现**（多模态 content 被 JSON.stringify 成文本）在 Qoder 上的真实行为。
 *
 * 探针一已确认 `contents` 里的 image 块不被支持：
 *   · OpenAI 风格 image_url → provider_error
 *   · Anthropic 风格 image   → 200 但模型答「您未提供图片」（图片被吞，比报错更危险）
 *
 * 本探针回答下一个问题：**现在线上那种「把图片序列化成 JSON 文本塞进 text」的做法**，
 * 在小图和真实尺寸图上分别是什么结果？这决定修复策略：
 *   · 小图也被拒 → 是结构问题（上游对 JSON 化的 image 结构有校验）
 *   · 小图能过、大图被拒 → 是体积问题（需截断/剥离）
 *   · 大小都过但模型乱答 → 静默幻觉，必须剥离并告知
 *
 * 用法：
 *   RELAY_DATA_DIR=/var/lib/relay node tools/probe-qoder-vision-current.mjs p_qoder01 qfmodel
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

/** 造一张「真实尺寸」的假图（纯 base64 填充，不需有效 PNG —— 测的是体积行为）。 */
function bigFakeB64(bytes) {
  return PIXEL_B64 + 'A'.repeat(Math.floor((bytes * 4) / 3) - PIXEL_B64.length);
}

const BLANK_USAGE = {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 },
};
const qMsg = (role, contents) => ({
  role,
  content: '',
  response_meta: { id: '', usage: JSON.parse(JSON.stringify(BLANK_USAGE)) },
  reasoning_content_signature: '',
  contents,
});

function buildBody(contents) {
  const text = contents.find((c) => c.type === 'text')?.text ?? '';
  return {
    request_id: randomUUID(), request_set_id: randomUUID(), chat_record_id: randomUUID(),
    stream: true, chat_task: 'chat',
    chat_context: {
      extra: { modelConfig: { is_reasoning: false, key: modelKey }, originalContent: { type: 'text', text } },
      text: { type: 'text', text },
    },
    session_id: randomUUID(), source: 1, version: '1.0.0',
    aliyun_user_type: identity.userType, session_type: 'qodercli',
    agent_id: 'agent_common', task_id: 'common',
    model_config: { key: modelKey, is_vl: true, is_reasoning: false, source: 'system' },
    messages: [qMsg('user', contents)],
    business: { id: randomUUID(), name: 'probe', begin_at: Date.now() },
    parameters: {},
  };
}

function analyze(raw) {
  let text = '';
  let error = null;
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
    if (d && typeof d.content === 'string') text += d.content;
  }
  return { text, error };
}

async function call(label, userContent, note) {
  /* ★ 关键：复刻 translate.ts:70 的做法 —— 非字符串 content 整个 JSON.stringify 成文本。 */
  const textPart = typeof userContent === 'string' ? userContent : JSON.stringify(userContent);
  const encoded = qEncode(JSON.stringify(buildBody([{ type: 'text', text: textPart }])));
  const date = String(Math.floor(Date.now() / 1000));
  const path = DEFAULT_QODER_CHAT_PATH;
  const { session } = new QoderCredentialStore().session(providerId);
  const headers = cosyChatHeaders(session, identity, buildCosyBearer(session, date, encoded, path.split('?')[0]), date, 'text/event-stream');

  const t0 = Date.now();
  let firstAt = null;
  let raw = '';
  try {
    const res = await fetch(`https://gateway.qoder.com.cn${path}`, {
      method: 'POST', headers, body: encoded, signal: AbortSignal.timeout(90_000),
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
    const { text, error } = analyze(raw);
    const verdict = error ? `✗ ${error}` : text.trim() ? `✓ 正文 ${JSON.stringify(text.slice(0, 60))}` : '✗ 空回复';
    console.log(`[${label}] body≈${(encoded.length / 1024).toFixed(0)}KB · 首字节 ${firstAt ?? '无'}ms · ${Date.now() - t0}ms`);
    console.log(`        ${verdict}`);
  } catch (err) {
    console.log(`[${label}] 异常 ${Date.now() - t0}ms: ${err.message}`);
  }
}

const multimodal = (b64) => [
  { type: 'text', text: '这张图是什么颜色？只回答颜色' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
];

console.log(`模型 key=${modelKey}\n`);
await call('① 纯文本（对照）', '你好，一个词回答', '');
await call('② 当前实现 · 70B 小图', multimodal(PIXEL_B64), 'JSON 化后仍很小');
await call('③ 当前实现 · 50KB 图', multimodal(bigFakeB64(50 * 1024)), '');
await call('④ 当前实现 · 1MB 图', multimodal(bigFakeB64(1024 * 1024)), '接近真实截图尺寸');
await call('⑤ 当前实现 · 4MB 图', multimodal(bigFakeB64(4 * 1024 * 1024)), '多图会话的典型总量');
