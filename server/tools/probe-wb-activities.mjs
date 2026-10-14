/**
 * WorkBuddy meter/签到/成长任务接口探针（v0.7.0 第 0 步，一次性研究工具）。
 *
 * 在生产服务器上跑：node /tmp/probe-wb-activities.mjs
 * 读 /var/lib/relay/providers/p_default00.key 的 ck_ 凭证（凭证不出服务器）。
 *
 * 探测三个只读端点 + 一个对照变体：
 *   1. POST /v2/billing/meter/get-user-resource   （额度；带 X-User-Id 与不带各一次）
 *   2. POST /v2/billing/meter/checkin-activity-status （签到状态；404/405 回退 checkin-status）
 *   3. GET  /v2/activity/growth/tasks             （成长任务列表）
 *
 * ⚠️ 绝不打 /daily-checkin —— 那会真领积分，留给实现后手动验证。
 *
 * 头族 = 生产 injectWorkBuddyFingerprint（桌面指纹）+ X-User-Id 占位。
 * 对照目的：确认 meter 族是否校验 X-User-Id 的存在性（v3/config 先例：值不校验、缺失则空数据）。
 */

import { readFileSync } from 'node:fs';

const BASE = process.env.WB_BASE || 'https://copilot.tencent.com';
const KEY = readFileSync('/var/lib/relay/providers/p_default00.key', 'utf8').trim();

const VERSION = '5.8.0';
const UA = `WorkBuddy/${VERSION} WorkBuddy/${VERSION} CLI/2.137.1`;

function headers(withUserId) {
  const h = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    authorization: `Bearer ${KEY}`,
    'user-agent': UA,
    'x-agent-purpose': 'conversation',
    'x-agent-intent': 'craft',
    'x-ide-name': 'WorkBuddy',
    'x-ide-type': 'WorkBuddy',
    'x-ide-version': VERSION,
    'x-product': 'SaaS',
    'x-private-data': 'true',
    'x-codebuddy-request': '1',
    origin: 'https://www.codebuddy.cn',
    referer: 'https://www.codebuddy.cn/',
    'x-requested-with': 'XMLHttpRequest',
    'accept-language': 'zh-CN',
  };
  if (withUserId) h['x-user-id'] = 'relay-station';
  return h;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function probe(label, path, method, body, withUserId) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: headers(withUserId),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    console.log(`\n=== [${label}] ${method} ${path} (x-user-id: ${withUserId ? 'yes' : 'no'})`);
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 2500));
    if (text.length > 2500) console.log(`... (${text.length} bytes total)`);
  } catch (err) {
    console.log(`\n=== [${label}] ${method} ${path} → ERROR: ${err.message}`);
  }
}

const now = new Date();
const resourceBody = {
  PageNumber: 1,
  PageSize: 100,
  ProductCode: 'p_tcaca',
  Status: [0, 3],
  PackageEndTimeRangeBegin: fmtDate(now),
  PackageEndTimeRangeEnd: fmtDate(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)),
};

console.log(`probe @ ${now.toISOString()} | base=${BASE} | key=${KEY.slice(0, 6)}...`);

await probe('meter/resource +uid', '/v2/billing/meter/get-user-resource', 'POST', resourceBody, true);
await probe('meter/resource -uid', '/v2/billing/meter/get-user-resource', 'POST', resourceBody, false);
await probe('checkin-status', '/v2/billing/meter/checkin-activity-status', 'POST', {}, true);
await probe('growth/tasks', '/v2/activity/growth/tasks', 'GET', undefined, true);
