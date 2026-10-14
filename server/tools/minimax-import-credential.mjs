/**
 * MiniMax Code 凭证导入（v1.6.5）。
 *
 * 与 `qoder-import-credential.mjs` **同一契约**：给 provider_id，从本机客户端登录态
 * 解出凭证并写进 relay 的 `<数据目录>/providers/<provider_id>.key`。
 * 差别只在凭证形态：Qoder 写身份 JSON；MiniMax 写**裸 refresh token 字符串** ——
 * 因为 `MinimaxTokenService` 读 `.key` 后按 `.startsWith('mmort_')` 判有效性，
 * 存 JSON 会直接判为无效（这是最初写错、后修正的点）。
 *
 * 读取逻辑在 `tools/lib/read-client-credential.mjs`（与 qoder 导入、推送脚本共用一份）。
 *
 * 用法：
 *   node tools/minimax-import-credential.mjs <provider_id>
 *   node tools/minimax-import-credential.mjs <provider_id> --print   # 只打印（脱敏）
 *   RELAY_DATA_DIR=/var/lib/relay node tools/minimax-import-credential.mjs p_xxx
 *
 * ⚠️ refresh token **一次性**且同账号单会话：导入 relay 后，客户端**不要再用同一账号登录**
 *    （会顶掉 relay 的链）—— 用专用账号（见 README 的互斥警告）。
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mask, minimaxClientPresent, readMinimaxRefreshToken } from './lib/read-client-credential.mjs';

const providerId = process.argv[2];
if (!providerId || providerId.startsWith('--')) {
  console.error('用法: node tools/minimax-import-credential.mjs <provider_id> [--print]');
  process.exit(2);
}
const printOnly = process.argv.includes('--print');

if (!minimaxClientPresent()) {
  console.error('找不到 MiniMax Code 客户端登录态（客户端未登录？或 MINIMAX_AUTH_FILE 未指向正确位置）。');
  process.exit(1);
}

/* ── 解出凭证 ── */
const { refreshToken, accountKey, rec } = readMinimaxRefreshToken();

console.log('解析出的凭证（脱敏）：');
console.log(`  账号         ${accountKey}`);
console.log(`  refreshToken ${mask(refreshToken)}（mmort_…）`);
console.log(`  access 到期  ${typeof rec.expiresAtMs === 'number' ? new Date(rec.expiresAtMs).toISOString() : '(未记)'}`);
console.log(`  clientId     ${rec.clientId ?? '—'}    audience ${rec.audience ?? '—'}`);

if (printOnly) {
  console.log('--print 模式：不写文件。');
  process.exit(0);
}

/* ── 写入提供商凭证文件：**裸 token 字符串**（不是 JSON —— 见文件头说明） ── */
const dataDir = process.env.RELAY_DATA_DIR || join(process.cwd(), '..', 'data');
const providersDir = join(dataDir, 'providers');
mkdirSync(providersDir, { recursive: true });
const target = join(providersDir, `${providerId}.key`);
writeFileSync(target, refreshToken, { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  /* Windows 上 chmod 语义有限，忽略 */
}
console.log(`已写入：${target}`);
console.log('提示：令牌为一次性 —— 客户端请勿再用该账号登录（会顶掉本服务）；过期后重跑本脚本。');
