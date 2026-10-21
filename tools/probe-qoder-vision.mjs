/**
 * 探针：Qoder 网关的 contents 到底认不认 image 类型（v1.7.3 决策依据）。
 *
 * 背景：`translate.ts:70` 把多模态 content 整个 JSON.stringify 成文本发出去，
 * 图片（base64）变成几 MB 的字符串正文 → 上游 200 零字节断流（生产实证 6 次）。
 * 在改成「直传图片」之前，必须确认协议支持，否则是换一种错法。
 *
 * 三组对照，都用**最小请求**（避免大 body 混淆变量）：
 *   A. 纯文本（对照组，应成功）
 *   B. contents 里加 image_url 块（OpenAI 风格 data URL）
 *   C. contents 里加 image 块（Anthropic 风格 {type:'image', source:{...}}）
 *
 * 用法（在服务器上跑，凭证从 dataDir 读，不打印）：
 *   RELAY_DATA_DIR=/var/lib/relay node tools/probe-qoder-vision.mjs p_qoder01 qfmodel
 *
 * 判定：
 *   A 成功 + B/C 都报 provider_error  → 协议不接受图片块
 *   A 成功 + B/C 有正文回答            → 可直传（记录哪种形态）
 *   A 成功 + B/C 只回来空 content      → 接受了结构但模型没看图（比报错更危险：
 *                                        客户端会以为回答了，实际是幻觉）→ 仍需剥离
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

/* 1×1 红点 PNG（约 70 字节）—— 测的是「结构是否被接受」，不是体积。 */
const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PIXEL_URL = `data:image/png;base64,${PIXEL_B64}`;

const BLANK_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_tokens_details: { cached_tokens: 0 },
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
    request_id: randomUUID(),
    request_set_id: randomUUID(),
    chat_record_id: randomUUID(),
    stream: true,
    chat_task: 'chat',
    chat_context: {
      extra: { modelConfig: { is_reasoning: false, key: modelKey }, originalContent: { type: 'text', text } },
      text: { type: 'text', text },
    },
    session_id: randomUUID(),
    source: 1,
    version: '1.0.0',
    aliyun_user_type: identity.userType,
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: modelKey, is_vl: true, is_reasoning: false, source: 'system' },
    messages: [qMsg('user', contents)],
    business: { id: randomUUID(), name: 'probe', begin_at: Date.now() },
    parameters: {},
  };
}

/** 从 SSE 里拼出正文与错误（响应是小帧，全读下来解析）。 */
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
    /* 网关把真正的上游体塞在 body 字段里（字符串化的 JSON）。 */
    let inner = obj;
    if (typeof obj.body === 'string') {
      try {
        inner = JSON.parse(obj.body);
      } catch {
        inner = obj;
      }
    }
    if (inner?.code === 'provider_error' || /Error in upstream/i.test(String(inner?.message ?? ''))) {
      error = `${inner.code ?? 'error'}: ${String(inner.message ?? '').slice(0, 120)}`;
    }
    const d = inner?.choices?.[0]?.delta;
    if (d) {
      if (typeof d.content === 'string') text += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    }
  }
  return { text, reasoning, error };
}

async function call(label, contents) {
  const encoded = qEncode(JSON.stringify(buildBody(contents)));
  const date = String(Math.floor(Date.now() / 1000));
  const path = DEFAULT_QODER_CHAT_PATH;
  const { session } = new QoderCredentialStore().session(providerId);
  const bearer = buildCosyBearer(session, date, encoded, path.split('?')[0]);
  const headers = cosyChatHeaders(session, identity, bearer, date, 'text/event-stream');

  const t0 = Date.now();
  let firstAt = null;
  let raw = '';
  try {
    const res = await fetch(`https://gateway.qoder.com.cn${path}`, {
      method: 'POST',
      headers,
      body: encoded,
      signal: AbortSignal.timeout(60_000),
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
        ? '✓ 有正文'
        : reasoning.trim()
          ? '△ 只有思考、无正文'
          : '✗ 空回复（结构被接受但没内容）';
    console.log(`[${label}] HTTP ${res.status} · 首字节 ${firstAt ?? '无'}ms · ${Date.now() - t0}ms`);
    console.log(`        结论: ${verdict}`);
    if (text.trim()) console.log(`        正文: ${JSON.stringify(text.slice(0, 100))}`);
    if (reasoning.trim()) console.log(`        思考: ${JSON.stringify(reasoning.slice(0, 80))}`);
  } catch (err) {
    console.log(`[${label}] 异常 ${Date.now() - t0}ms: ${err.message}`);
  }
}

console.log(`模型 key=${modelKey}\n`);
await call('A 纯文本（对照）', [{ type: 'text', text: '你好，一个词回答' }]);
await call('B image_url 块（OpenAI）', [
  { type: 'text', text: '这张图是什么颜色？只回答颜色' },
  { type: 'image_url', image_url: { url: PIXEL_URL } },
]);
await call('C image+source 块（Anthropic）', [
  { type: 'text', text: '这张图是什么颜色？只回答颜色' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_B64 } },
]);
