/**
 * 端到端验证 v0.2.1 修复：**总时长 >30s 的流式请求**穿过 relay 必须完整收完。
 *
 * 背景：2026-10-08 生产事故 —— `AbortSignal.timeout(firstByteTimeoutMs)` 挂在整个
 * fetch 上是全程超时，agent 工具调用的长流恰好在 30009/30011ms 被自己掐断
 * （note=stream_abort）。修复 = ReadGuard 两段式（首字超时 + 5 分钟空闲看门狗）。
 *
 * 手法（与 verify-all B 节同型，零生产污染）：
 *   快照库（VACUUM INTO）→ 隔离实例（真上游 key）→ 控制台建临时密钥 →
 *   发一条必然超过 30 秒的长文流式请求 → 断言收到 [DONE] 且总时长 >30s。
 *   退出码 0 = 修复生效；一切只写快照库，进程结束即焚。
 *
 * 用法（在 /opt/relay/server 下）：
 *   RELAY_UPSTREAM_KEY=$(cat /var/lib/relay/upstream.key) node tools/probe-long-stream.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import Database from 'better-sqlite3';

const SRV = '/opt/relay/server';
const ENTRY = join(SRV, 'dist', 'main.js');
const PASSWORD_MODULE = join(SRV, 'dist', 'api', 'auth', 'password.js');
const DATA = '/var/lib/relay';
const PW = 'probe-long-stream-onetime-0000';
const MODEL = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS || 8000);

if (!process.env.RELAY_UPSTREAM_KEY) {
  console.error('missing RELAY_UPSTREAM_KEY');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

// ① 快照库（一致性快照，不碰生产）
const iso = mkdtempSync(join(tmpdir(), 'probe-long-'));
{
  const vdb = new Database(`${DATA}/relay.db`, { readonly: true });
  vdb.exec(`VACUUM INTO '${iso}/relay.db'`);
  vdb.close();
}
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

// ② 隔离实例（真上游 key，数据目录指向快照）
const { hashPassword } = await import(pathToFileURL(PASSWORD_MODULE).href);
const child = spawn(process.execPath, [ENTRY], {
  cwd: SRV,
  env: {
    ...process.env,
    RELAY_DATA_DIR: iso,
    RELAY_PORT: String(port),
    RELAY_ADMIN_PASSWORD_HASH: hashPassword(PW),
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) up = true;
    } catch {}
    await sleep(250);
  }
  if (!up) throw new Error('隔离实例未启动');
  console.log('隔离实例就绪');

  const req = async (p, init = {}) => {
    const r = await fetch(BASE + p, {
      ...init,
      headers: { origin: BASE, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie') ?? '' };
  };

  // ③ 登录 + 建临时密钥（明文只在本次进程内存里，实例即焚）
  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  if (login.status !== 200) throw new Error(`登录失败 HTTP ${login.status}`);
  const cookie = login.cookie.split(';')[0];
  const created = await req('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'long-stream-probe' }),
  });
  const key = created.json?.data?.key;
  if (created.status !== 200 || typeof key !== 'string' || !key.startsWith('sk-waygate-')) {
    throw new Error(`建钥失败: HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  console.log('临时密钥已建（快照库内，实例即焚）');

  // ④ 决定性一击：必然超过 30 秒的长文流
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'user', content: `写一篇约 6000 字的中文长文，主题：航海罗盘的发展史。从中国古代司南讲起，经阿拉伯航海、欧洲大航海时代，到现代陀螺罗经与卫星导航。直接开始正文，持续写满篇幅，不要提前收尾。` },
      ],
    }),
    signal: AbortSignal.timeout(600_000),
  });
  let firstByteMs = null;
  let chunks = 0;
  let done = false;
  let usage = null;
  let contentChars = 0;
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') {
          done = true;
          continue;
        }
        chunks += 1;
        try {
          const j = JSON.parse(p);
          if (j.usage) usage = j.usage;
          contentChars += (j.choices?.[0]?.delta?.content || '').length;
        } catch {}
      }
    }
  }
  const totalMs = Date.now() - t0;
  const report = {
    httpStatus: res.status,
    firstByteMs,
    chunks,
    contentChars,
    gotDone: done,
    totalMs,
    over30s: totalMs > 30_000,
    usage,
    verdict:
      res.status === 200 && done && totalMs > 30_000
        ? '✅ 修复生效：>30s 流完整收完（旧实现会在 30s 整被掐断）'
        : totalMs <= 30_000
          ? `⚠️ 流只跑了 ${Math.round(totalMs / 1000)}s（<30s），未构成对修复的检验 —— 调大 PROBE_MAX_TOKENS 重跑`
          : '❌ 仍被掐断',
  };
  console.log(JSON.stringify(report, null, 1));
  process.exitCode = report.verdict.startsWith('✅') ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 2;
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  try {
    rmSync(iso, { recursive: true, force: true });
  } catch {}
}
