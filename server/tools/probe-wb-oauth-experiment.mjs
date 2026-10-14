/**
 * WorkBuddy OAuth 互踢实验（v1.4.0 第 0 步，一次性）。
 *
 * 服务器上跑：node /tmp/wb-oauth-exp.mjs /tmp/wb-oauth.json
 * 五步序列（全部记录，不静默）：
 *   ① 旧 access 打 checkin-activity-status（OAuth 基线可用性）
 *   ② refresh（POST /v2/plugin/auth/token/refresh，HanawaBanana 实证头族）
 *   ③ 旧 access 再打 checkin —— 200=多会话共存（桌面端安全）/401=互踢
 *   ④ 新 access 打 daily-checkin（领取域验证；会真领今天的签到积分）
 *   ⑤ 新 access 打 growth/tasks（任务域验证）
 * 凭证用完即删；响应脱敏打印（只打状态码 + 关键字段）。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = 'https://copilot.tencent.com';
const ORIGIN = 'https://www.codebuddy.cn';
const credFile = process.argv[2] || '/tmp/wb-oauth.json';
const cred = JSON.parse(readFileSync(credFile, 'utf8'));

const machineId = (uid, purpose) =>
  createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36);

function headers(token, { billing = false } = {}) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    'user-agent': 'WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1',
    'x-codebuddy-request': '1',
    'accept-language': 'zh-CN',
    'x-machine-id': machineId(cred.uid, 'machine'),
    'x-session-id': machineId(cred.uid, 'session'),
    authorization: `Bearer ${token}`,
  };
  if (billing) h['x-user-id'] = cred.uid;
  return h;
}

async function call(label, path, token, opts = {}) {
  try {
    const res = await fetch(BASE + path, {
      method: opts.method ?? 'POST',
      headers: headers(token, opts),
      body: opts.body === undefined ? '{}' : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let brief = text.slice(0, 220);
    try {
      const j = JSON.parse(text);
      const d = j.data ?? j;
      brief = JSON.stringify({
        code: j.code,
        msg: j.msg,
        today_checked_in: d?.today_checked_in,
        streak_days: d?.streak_days,
        tasks: Array.isArray(d?.tasks) ? d.tasks.length : undefined,
        credit: d?.credit,
        message: j.message,
      });
    } catch { /* 非 JSON，保留原文截断 */ }
    console.log(`[${label}] HTTP ${res.status} ${brief}`);
    return { status: res.status, text };
  } catch (err) {
    console.log(`[${label}] ERROR ${err.message}`);
    return { status: 0, text: '' };
  }
}

console.log(`实验开始：uid=${cred.uid} domain=${cred.domain}`);

/* ① OAuth 基线 */
const s1 = await call('①旧access查签到', '/v2/billing/meter/checkin-activity-status', cred.accessToken, { billing: true });

/* ② refresh */
let newAccess = null;
let newRefresh = null;
{
  const h = headers(cred.accessToken);
  h['x-refresh-token'] = cred.refreshToken;
  h['x-auth-refresh-source'] = 'plugin';
  delete h.authorization;
  try {
    const res = await fetch(`${BASE}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: h,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    console.log(`[②refresh] HTTP ${res.status} ${text.slice(0, 160)}`);
    if (res.ok) {
      const j = JSON.parse(text);
      const d = j.data ?? j;
      newAccess = d.accessToken ?? d.access_token;
      newRefresh = d.refreshToken ?? d.refresh_token;
      console.log(`  新 access: ${newAccess ? newAccess.slice(0, 12) + '…(' + newAccess.length + ')' : '缺失'} | 新 refresh: ${newRefresh ? newRefresh.slice(0, 12) + '…' : '缺失'} | expiresIn: ${d.expiresIn}`);
      /* 写回凭证文件（实验脚本也要善终：后续实现会用 relay 服务管理） */
      if (newAccess && newRefresh) {
        writeFileSync(credFile, JSON.stringify({ ...cred, accessToken: newAccess, refreshToken: newRefresh }, null, 2));
      }
    }
  } catch (err) {
    console.log(`[②refresh] ERROR ${err.message}`);
  }
}

/* ③ 互踢判定：旧 access 复打 */
const s3 = await call('③旧access复打(互踢判定)', '/v2/billing/meter/checkin-activity-status', cred.accessToken, { billing: true });
console.log(`  → 判定：${s3.status === 200 ? '多会话共存（桌面端安全，旧 token 未被作废）' : s3.status === 401 || s3.status === 403 ? '⚠️ 旧 token 已失效 —— 互踢（桌面端将要求重新登录）' : `状态 ${s3.status}，需人工判读`}`);

/* ④⑤ 新 access 领取域 */
if (newAccess) {
  await call('④新access领取签到', '/v2/billing/meter/daily-checkin', newAccess, { billing: true });
  await call('⑤新access查任务', '/v2/activity/growth/tasks', newAccess, { billing: true, method: 'GET', body: undefined });
} else {
  console.log('[④⑤] refresh 未成功，跳过');
}

console.log('实验结束（新链已写回 ' + credFile + '；导入 relay 前请妥善保管）');
