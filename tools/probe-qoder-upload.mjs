/**
 * 探针五：验证「先上传图片拿 URL，再在聊天里引用」这条路径。
 *
 * ── 依据（SDK 反混淆）──────────────────────────────────────────────────
 *   _Hi = "/api/v2/image/upload"
 *   upload(A): request_id=uuid, method=PUT, query {request_id},
 *              withSignature("auth"), body=multipart(form-data), headers{Content-Type}
 *              → 返回 { url }
 *   PPc(url):   /^https?:\/\// → {type:"url", url}   ← 聊天里用 URL 形态
 *   Jnl(source): {type:'url', url} → {type:'image_url', image_url:{url}}
 *
 * 即：**图片先上传到 Qoder 的对象存储，聊天时用 URL 引用**（不是内联 base64）。
 * 这解释了为什么所有内联尝试都看不到图 —— 网关只认 URL。
 *
 * 用法：
 *   RELAY_DATA_DIR=/var/lib/relay node tools/probe-qoder-upload.mjs p_qoder01 qfmodel
 *
 * ⚠️ 本探针会向 Qoder 上传一张 1×1 图片（约 70 字节）。属只读探测之外的最小写操作，
 *    上传的是我们自造的红点图，不含任何用户数据。
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
const store = new QoderCredentialStore();

const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ASK = '这张图是什么颜色？只回答颜色词。';
const BASE = 'https://gateway.qoder.com.cn';

/** 上传图片，返回 URL（失败返回 null 并打印原因）。 */
async function uploadImage() {
  const reqId = randomUUID().replaceAll('-', '');
  const boundary = `----qodercli-${reqId}`;
  const bin = Buffer.from(PIXEL_B64, 'base64');
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="image.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, bin, tail]);

  const path = '/api/v2/image/upload';
  const date = String(Math.floor(Date.now() / 1000));
  const { session } = store.session(providerId);
  /* 签名沿用聊天用的 COSY bearer；上传接口声明 withSignature("auth")，先按同一套试。 */
  const bearer = buildCosyBearer(session, date, body.toString('base64'), path);
  const headers = {
    authorization: `Bearer ${bearer}`,
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
  };

  try {
    const res = await fetch(`${BASE}${path}?request_id=${reqId}`, {
      method: 'PUT', headers, body, signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text().catch(() => '');
    console.log(`[上传] HTTP ${res.status} · ${text.slice(0, 300)}`);
    if (!res.ok) return null;
    try {
      const j = JSON.parse(text);
      const url =
        j?.url ?? j?.data?.url ?? j?.body?.url ??
        (typeof j?.body === 'string' ? JSON.parse(j.body)?.url : undefined);
      return typeof url === 'string' ? url : null;
    } catch {
      return null;
    }
  } catch (err) {
    console.log(`[上传] 异常: ${err.message}`);
    return null;
  }
}

const BLANK_USAGE = {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 },
};
const meta = () => ({ response_meta: { id: '', usage: JSON.parse(JSON.stringify(BLANK_USAGE)) }, reasoning_content_signature: '' });

function analyze(raw) {
  let text = ''; let error = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj; try { obj = JSON.parse(payload); } catch { continue; }
    let inner = obj;
    if (typeof obj.body === 'string') { try { inner = JSON.parse(obj.body); } catch { inner = obj; } }
    if (inner?.code === 'provider_error' || /Error in upstream/i.test(String(inner?.message ?? ''))) {
      error = `${inner.code}: ${String(inner.message ?? '').slice(0, 100)}`;
    }
    const d = inner?.choices?.[0]?.delta;
    if (d && typeof d.content === 'string') text += d.content;
  }
  return { text, error };
}

async function chat(label, message) {
  const bodyStr = JSON.stringify({
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
    messages: [{ role: 'user', ...meta(), ...message }],
    business: { id: randomUUID(), name: 'probe', begin_at: Date.now() },
    parameters: {},
  });
  const encoded = qEncode(bodyStr);
  const date = String(Math.floor(Date.now() / 1000));
  const path = DEFAULT_QODER_CHAT_PATH;
  const { session } = store.session(providerId);
  const headers = cosyChatHeaders(session, identity, buildCosyBearer(session, date, encoded, path.split('?')[0]), date, 'text/event-stream');
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: encoded, signal: AbortSignal.timeout(75_000) });
    let raw = '';
    const reader = res.body?.getReader();
    if (reader) { for (;;) { const r = await reader.read(); if (r.done) break; raw += new TextDecoder().decode(r.value); } }
    const { text, error } = analyze(raw);
    console.log(`[${label}] ${Date.now() - t0}ms · ${error ? '✗ ' + error : text.trim() ? `✓ ${JSON.stringify(text.slice(0, 60))}` : '✗ 空回复'}`);
  } catch (err) {
    console.log(`[${label}] 异常: ${err.message}`);
  }
}

console.log(`模型 key=${modelKey} · 期望回答「红色」\n`);
const url = await uploadImage();
if (!url) {
  console.log('\n上传未成功 —— 无法继续引用测试。');
  process.exit(1);
}
console.log(`\n[上传成功] ${url}\n`);

await chat('E 引用 URL（image_url 双写）', {
  content: [{ type: 'text', text: ASK }, { type: 'image_url', image_url: { url } }],
  contents: [{ type: 'text', text: ASK }, { type: 'image_url', image_url: { url } }],
});
await chat('F 引用 URL（仅 contents）', {
  contents: [{ type: 'text', text: ASK }, { type: 'image_url', image_url: { url } }],
});
await chat('G 引用 URL（content 数组 + contents image 块）', {
  content: [{ type: 'text', text: ASK }, { type: 'image_url', image_url: { url } }],
  contents: [{ type: 'text', text: ASK }, { type: 'image', source: { type: 'url', url } }],
});
