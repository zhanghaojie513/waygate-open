/**
 * Qoder CN 凭证导入（一次性工具，v0.6.0）。
 *
 * 从本机 Qoder 客户端登录态（auth.v1.dat，Chromium os_crypt v10）解出身份材料，
 * 写成 Waygate 的提供商凭证文件（<数据目录>/providers/<provider_id>.key，JSON）。
 *
 * 读取逻辑在 `tools/lib/read-client-credential.mjs`（与 minimax 导入、推送脚本共用一份）。
 *
 * 用法（Windows，客户端已登录）：
 *   node tools/qoder-import-credential.mjs <provider_id>
 *   node tools/qoder-import-credential.mjs <provider_id> --print   # 只打印（脱敏），不写文件
 *   RELAY_DATA_DIR=/var/lib/relay node tools/qoder-import-credential.mjs p_xxx
 *
 * 安全边界：明文只写进服务器本机的凭证文件（0600 意图）；终端只打印掩码摘要，
 * **绝不回显 token**。令牌失效（dt- 过期）后重跑本脚本即可。
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mask, qoderClientPresent, readQoderIdentity } from './lib/read-client-credential.mjs';

const providerId = process.argv[2];
if (!providerId || providerId.startsWith('--')) {
  console.error('用法: node tools/qoder-import-credential.mjs <provider_id> [--print]');
  process.exit(2);
}
const printOnly = process.argv.includes('--print');

if (!qoderClientPresent()) {
  console.error('找不到 Qoder CN 客户端登录态（客户端未登录？或 QODER_APP_DIR 未指向正确位置）。');
  process.exit(1);
}

/* ── 解出身份材料 ── */
const { identity, raw: auth } = readQoderIdentity();

console.log('解析出的身份材料（脱敏）：');
console.log(`  uid        = ${identity.uid}`);
console.log(`  name       = ${identity.name}`);
console.log(`  token      = ${mask(identity.token, 6)}（dt-…）`);
console.log(`  refresh    = ${mask(identity.refreshToken, 6)}（drt-…）`);
console.log(`  客户端到期 = ${auth.expiresAt ?? '(未记)'}`);

if (printOnly) {
  console.log('--print 模式：不写文件。');
  process.exit(0);
}

/* ── 写入提供商凭证文件 ── */
const dataDir = process.env.RELAY_DATA_DIR || join(process.cwd(), '..', 'data');
const providersDir = join(dataDir, 'providers');
mkdirSync(providersDir, { recursive: true });
const target = join(providersDir, `${providerId}.key`);
writeFileSync(target, JSON.stringify(identity), { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  /* Windows 上 chmod 语义有限，忽略 */
}
console.log(`已写入：${target}`);
console.log('提示：在控制台「客户端管理 → 提供商」确认该提供商凭证状态；令牌过期时重跑本脚本。');
