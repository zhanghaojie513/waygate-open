/**
 * 管理口令的哈希与校验（api-contract §1.4 / §3.1）。
 *
 * 存储格式：`scrypt$N$r$p$<salt_b64>$<hash_b64>`
 *   - N/r/p 显式写进字符串，将来调参不需要迁移脚本（旧串自带旧参数）
 *   - salt 每次生成时随机，绝不复用
 *   - 明文口令**永不落盘**、永不进日志
 *
 * 与 `auth/keys.ts` 的 key_hash 用不同的算法是**故意的**：
 *   - 密钥鉴权在热路径（每请求一次），必须快 → HMAC-SHA256
 *   - 口令鉴权只在登录时发生一次 → 可以慢，用 scrypt 抗离线爆破
 */

import {
  randomBytes,
  scrypt as scryptCb,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt 参数。N=16384/r=8/p=1 是 Node 默认档，约 60ms/次，足够抗暴力。 */
const PROD_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** 生产档参数（导出供测试断言「默认值没被改低」）。 */
export const DEFAULT_SCRYPT_PARAMS = PROD_PARAMS;

/**
 * 当前生效的 scrypt 成本。
 *
 * 生产恒为 `PROD_PARAMS`（N=16384）。**只有测试**会通过
 * `__setScryptParamsForTests()` 把它降到低成本档。原因：scrypt 是 **CPU 密集**的，
 * 单测里几十次「哈希 / 验密」在机器繁忙时单例可涨到数秒，逼近 vitest 默认 **5s
 * 单测超时** —— 于是**结果随机器负载漂移（flaky）**：同一份代码同一台机器，
 * 忙时红、闲时绿。降到低成本后单测恒在毫秒级，与负载无关。
 *
 * 为什么这不影响生产安全：`verifyPassword` 从**存储串自身**读参数（见下），
 * 生产里种下的一直是 N=16384 的串，验证也走 N=16384；测试里种低成本串，
 * 只在测试进程内。prod 的 `hashPassword` 默认值一个字没动。
 */
let activeParams: { N: number; r: number; p: number } = PROD_PARAMS;

/**
 * **仅供测试**：临时替换 scrypt 成本（传 `null` 复位为生产档）。
 * 下划线前缀 = 「不要在产品代码里调用」。
 */
export function __setScryptParamsForTests(params: { N: number; r: number; p: number } | null): void {
  activeParams = params ?? PROD_PARAMS;
}

export function hashPassword(plain: string, salt?: Buffer): string {
  const p = activeParams;
  // maxmem：Node 默认 32MB 在部分机器上不够，给 4× 余量（随参数档位缩放）
  const maxmem = 128 * p.N * p.r * 2;
  const useSalt = salt ?? randomBytes(SALT_LEN);
  // 同步版本：只在启动 / 生成初始口令时调用一次，不在请求路径上
  const derived = scryptSync(plain, useSalt, KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem });
  return [
    'scrypt',
    String(p.N),
    String(p.r),
    String(p.p),
    useSalt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** 解析存储串。格式非法返回 null（调用方按"无有效口令"处理，不抛）。 */
export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.trim().split('$');
  if (parts.length !== 6) return null;
  const [algo, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algo !== 'scrypt') return null;
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  try {
    const salt = Buffer.from(saltRaw, 'base64url');
    const hash = Buffer.from(hashRaw, 'base64url');
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

/**
 * 校验口令：timing-safe compare。
 *
 * 参数从**存储串自身**读取（而非用当前 PARAMS 重算），这样调参后旧口令仍可验证。
 * 存储串损坏时返回 false，绝不抛异常到请求层。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const maxmem = 128 * parsed.N * parsed.r * 2;
  const derived = await scrypt(plain, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem,
  });
  // 长度已在 parse 阶段保证 >0；长度不等时 timingSafeEqual 会抛，故先判
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/** 生成随机口令：16 字符，去掉了 0/O/1/l/I 等易混字符（要读屏手抄）。 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
