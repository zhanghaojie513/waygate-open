/**
 * 客户端登录态读取（v1.6.5）—— 三个脚本共用，避免 DPAPI/结构解析逻辑抄三份。
 *
 * 使用方：
 *   · tools/qoder-import-credential.mjs    （本机 → 本机 relay 数据目录）
 *   · tools/minimax-import-credential.mjs  （同上）
 *   · tools/import-credential-push.mjs     （本机 → 远程 relay，走 HTTPS API）
 *
 * 返回**明文凭证**，调用方负责：只写 0600 文件 / 只走 HTTPS 推送，绝不回显完整值。
 */

import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ─────────────────────────── Qoder ─────────────────────────── */

const QODER_APP_DIR = () =>
  process.env.QODER_APP_DIR ||
  join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable');

export function qoderClientPath() {
  return join(QODER_APP_DIR(), 'auth.v1.dat');
}

export function qoderClientPresent() {
  return existsSync(qoderClientPath());
}

/** Chromium os_crypt 主密钥（经本机 DPAPI 解出）。 */
function osCryptKey() {
  const ls = JSON.parse(readFileSync(join(QODER_APP_DIR(), 'Local State'), 'utf8'));
  const encrypted = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  const hex = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$enc = [Convert]::FromBase64String('${encrypted.toString('base64')}'); $enc = $enc[5..($enc.Length-1)]; Add-Type -AssemblyName System.Security; ([Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser') | ForEach-Object { $_.ToString('x2') }) -join ''`,
    ],
    { encoding: 'utf8' },
  ).trim();
  return Buffer.from(hex, 'hex');
}

function decryptV10(blob, key) {
  if (blob.slice(0, 3).toString() !== 'v10') throw new Error('auth.v1.dat 不是 v10 格式（客户端版本变化？）');
  const nonce = blob.slice(3, 15);
  const tag = blob.slice(blob.length - 16);
  const ct = blob.slice(15, blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 读 Qoder 身份材料。缺字段抛错（客户端未登录）。 */
export function readQoderIdentity() {
  const auth = JSON.parse(decryptV10(readFileSync(qoderClientPath()), osCryptKey()));
  const identity = {
    token: String(auth.token ?? ''),
    refreshToken: String(auth.refreshToken ?? ''),
    uid: String(auth.user?.id ?? ''),
    name: String(auth.user?.name ?? 'qoder-user'),
    userType: 'personal_standard',
  };
  for (const [k, v] of Object.entries(identity)) {
    if (!v && k !== 'name') throw new Error(`登录态缺字段 ${k}（客户端未登录？）`);
  }
  return { identity, raw: auth };
}

/* ─────────────────────────── MiniMax ─────────────────────────── */

const MINIMAX_AUTH_FILE = () =>
  process.env.MINIMAX_AUTH_FILE ||
  join(homedir(), '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');

export function minimaxClientPath() {
  return MINIMAX_AUTH_FILE();
}

export function minimaxClientPresent() {
  return existsSync(minimaxClientPath());
}

/** 多账号取最近登录者：generation 优先、loginEpoch 次之（两者都单调递进）。 */
function pickMinimaxRecord(raw) {
  const records = raw?.records;
  if (!records || typeof records !== 'object') return null;
  const entries = Object.entries(records).filter(([, v]) => v && typeof v === 'object');
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    const ga = Number(a[1].generation ?? 0);
    const gb = Number(b[1].generation ?? 0);
    if (ga !== gb) return gb - ga;
    return String(b[1].loginEpoch ?? '').localeCompare(String(a[1].loginEpoch ?? ''));
  });
  return entries[0];
}

/** 读 MiniMax refresh token（**裸 token**，非 JSON）。 */
export function readMinimaxRefreshToken() {
  const raw = JSON.parse(readFileSync(minimaxClientPath(), 'utf8'));
  const picked = pickMinimaxRecord(raw);
  if (!picked) throw new Error('auth.json 里没有账号记录（records 为空）—— 客户端可能未登录。');
  const [accountKey, rec] = picked;
  const refreshToken = typeof rec.refreshToken === 'string' ? rec.refreshToken.trim() : '';
  if (!refreshToken.startsWith('mmort_')) {
    throw new Error(
      `账号记录里没有有效的 refresh token（期望 mmort_ 开头，实际 ${refreshToken ? refreshToken.slice(0, 6) + '…' : '缺失'}）。`
      + '若是 M Plan 平台账号，请在控制台直接贴 API key。',
    );
  }
  return { refreshToken, accountKey, rec };
}

/** 脱敏：只露前若干字符 + 长度。 */
export function mask(s, keep = 10) {
  return s && s.length > keep ? `${s.slice(0, keep)}…(${s.length}B)` : '***';
}
