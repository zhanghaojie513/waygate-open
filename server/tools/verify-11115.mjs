import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const SRV = '/opt/relay/server';
const DB = require(SRV + '/node_modules/better-sqlite3');
const { spawn, execSync } = require('node:child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 生产实测：造一个必然超限的请求（5.3MB ≈ 126 万 token > 上限 1048576），
   验证 relay 现在能把上游 11115 业务码**如实**读出并映射为 400 context_length_exceeded
   （修复前：502 / upstream_error / upstreamCode=null）。
   必须经完整链路（rewrite→路由→出站），否则验证不到「body 双重读取」那个 bug。 */
const iso = mkdtempSync(join(tmpdir(), 'v11115-'));
// ★ 复制生产 settings.json —— 否则隔离实例用代码默认 firstByteTimeoutMs=30s，
//   而生产实配 120s：上游处理 5.3MB 要 ~25s，30s 会把我们**自己**掐断成 504 超时，
//   那样根本走不到「上游回了 400」这一步，验证就验错了东西。
require('node:fs').writeFileSync(
  iso + '/settings.json',
  require('node:fs').readFileSync('/var/lib/relay/settings.json', 'utf8'),
);
// ★ 用 VACUUM INTO 取一致快照：直接 cp 会漏掉仍在 WAL 里未 checkpoint 的写入（verify-all 踩过）
{
  const vdb = new DB('/var/lib/relay/relay.db', { readonly: true });
  vdb.exec(`VACUUM INTO '${iso}/relay.db'`);
  vdb.close();
}
const port = await new Promise((res) => {
  const s = require('node:net').createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const BASE = `http://127.0.0.1:${port}`;
const { hashPassword } = await import(pathToFileURL(join(SRV,'dist','api','auth','password.js')).href);
const PW = 'verify-11115-onetime';
const upstreamKey = require('node:fs').readFileSync('/var/lib/relay/providers/p_default00.key','utf8').trim();

const child = spawn(process.execPath, [join(SRV,'dist','main.js')], {
  cwd: SRV,
  env: { ...process.env, RELAY_DATA_DIR: iso, RELAY_PORT: String(port),
         RELAY_UPSTREAM_KEY: upstreamKey,
         RELAY_ADMIN_PASSWORD_HASH: hashPassword(PW) },
  stdio: ['ignore','pipe','pipe'],
});
const logs = [];
child.stdout.on('data', d=>logs.push(String(d)));
child.stderr.on('data', d=>logs.push(String(d)));
for (let i=0;i<60;i++){ try { const r = await fetch(BASE+'/healthz'); if(r.ok) break; } catch {} await sleep(500); }
console.log('[iso] 实例已启动 port=', port);

const login = await fetch(BASE+'/api/auth/login', { method:'POST',
  headers:{'content-type':'application/json', origin: BASE}, body: JSON.stringify({password: PW}) });
const cookie = login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
console.log('[iso] admin 登录 HTTP', login.status);
if (login.status !== 200) { console.log('[iso] 登录失败日志：', logs.join('').slice(-800)); process.exit(1); }

const created = await fetch(BASE+'/api/keys', { method:'POST',
  headers:{'content-type':'application/json', cookie, origin: BASE}, body: JSON.stringify({
    name:'verify-11115', client:'verify', clients:['verify'], scope:{type:'all'} }) });
const ck = await created.json();
const plain = ck?.data?.key ?? ck?.data?.plain ?? ck?.key;
console.log('[iso] 临时密钥创建 HTTP', created.status, '明文可得:', Boolean(plain));

const UNIT = '这是一段用于验证上下文超限错误映射的对话填充内容，包含中文标点与数字 1234567890。';
const body = JSON.stringify({ model:'deepseek-v4.1-flash', stream:true, max_tokens:64, messages:[
  { role:'system', content:'You are a helpful assistant.' },
  { role:'user', content: UNIT.repeat(Math.ceil(5_300_000/Buffer.byteLength(UNIT,'utf8'))) + '\n只回答：好' },
]});
console.log('[iso] 请求体字节 =', Buffer.byteLength(body,'utf8'));

const t0 = Date.now();
const up = await fetch(BASE+'/v1/chat/completions', { method:'POST',
  headers:{ authorization:`Bearer ${plain}`, 'content-type':'application/json' },
  body, signal: AbortSignal.timeout(180000) });
const txt = await up.text();
console.log('\n══════ 生产链路实测（经 0.6.7 完整代理链）══════');
console.log('HTTP 状态    :', up.status, '  （修复前 = 502）');
console.log('耗时         :', Date.now()-t0, 'ms');
let parsed=null; try { parsed = JSON.parse(txt); } catch {}
console.log('error.code   :', parsed?.error?.code, '  （修复前 = upstream_error）');
console.log('error.type   :', parsed?.error?.type, '  （修复前 = server_error → 客户端会盲目重试）');
console.log('message      :', String(parsed?.error?.message ?? txt).slice(0,320));

const idb = new DB(iso+'/relay.db', { readonly:true });
const rows = idb.prepare('SELECT id,status,upstream_code,ms,first_byte_ms,substr(note,1,64) note FROM requests ORDER BY id DESC LIMIT 2').all();
console.log('\n--- 审计行（requests）---');
for (const r of rows) console.log(JSON.stringify(r));
const hit = rows.find(r => r.upstream_code === 11115);
console.log('\n判读：upstream_code=11115 / status=400 / first_byte_ms=null');
console.log(hit ? '✅ 业务码活着穿过代理链并落库了' : '❌ 仍未取到业务码');
child.kill('SIGTERM'); await sleep(400); idb.close();
execSync(`rm -rf ${iso}`);
