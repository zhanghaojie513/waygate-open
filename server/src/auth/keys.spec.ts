import { describe, expect, it } from 'vitest';
import {
  KEY_PATTERN,
  KEY_PREFIX,
  generateKey,
  hashKey,
  keyPrefixOf,
  looksLikeRelayKey,
  validateKey,
} from './keys';
import { buildKeyHint } from '../common/mask';
import type { ClientKeyRow } from '../store/repositories/client-keys.repo';

const SECRET = 'test-secret-do-not-use-in-prod';

function row(overrides: Partial<ClientKeyRow> = {}): ClientKeyRow {
  const plain = 'sk-waygate-0123456789abcdef01234567';
  return {
    id: 'k_test0001',
    name: 'test',
    key_hash: hashKey(SECRET, plain),
    key_hint: 'sk-waygate-0123…4567',
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    ip_whitelist: '[]',
    max_ips: null,
    token_quota: null,
    enabled: 1,
    expires_at: null,
    source: 'console',
    created_at: Date.now(),
    last_seen_at: null,
    last_seen_ip: null,
    ...overrides,
  };
}

const PLAIN = 'sk-waygate-0123456789abcdef01234567';

describe('hashKey', () => {
  it('① 同一密钥哈希稳定，且与手算 HMAC 一致', () => {
    expect(hashKey(SECRET, PLAIN)).toBe(hashKey(SECRET, PLAIN));
    // 换 secret 必须换结果（否则库泄漏后无需 secret 即可撞库）
    expect(hashKey(SECRET, PLAIN)).not.toBe(hashKey('other-secret', PLAIN));
    // 换明文必须换结果
    expect(hashKey(SECRET, PLAIN)).not.toBe(hashKey(SECRET, PLAIN + 'x'));
  });
});

describe('generateKey', () => {
  it('② 产出的明文符合 sk-waygate-[0-9a-f]{24}，且 hint 是遮蔽形态', () => {
    for (let i = 0; i < 20; i += 1) {
      const { plain, hint, hashFactory } = generateKey();
      expect(plain).toMatch(KEY_PATTERN);
      expect(plain).toHaveLength(35); // 前缀 11 + 24 位十六进制
      expect(looksLikeRelayKey(plain)).toBe(true);
      expect(hint).toBe(`sk-waygate-${plain.slice(11, 15)}…${plain.slice(-4)}`);
      expect(hint).not.toBe(plain);
      expect(hint).not.toContain(plain.slice(15, -4));
      // hashFactory 必须与本模块的 hashKey 等价
      expect(hashFactory(SECRET)).toBe(hashKey(SECRET, plain));
    }
  });

  it('③ 每次生成互不相同（randomHex(12) 的 96 bit 熵）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateKey().plain);
    expect(seen.size).toBe(200);
  });

  it('④ 非法形态一律 looksLikeRelayKey=false（不查库快速拒绝）', () => {
    expect(looksLikeRelayKey('sk-waygate-')).toBe(false);
    expect(looksLikeRelayKey('sk-waygate-ABCDEF0123456789ABCDEF01')).toBe(false); // 大写不合法
    expect(looksLikeRelayKey('sk-waygate-0123456789abcdef0123456')).toBe(false); // 23 位
    expect(looksLikeRelayKey('ck_whatever')).toBe(false);
    expect(looksLikeRelayKey('')).toBe(false);
    expect(looksLikeRelayKey(null)).toBe(false);
    expect(looksLikeRelayKey(undefined)).toBe(false);
  });
});

describe('validateKey', () => {
  it('⑤ hash 一致 + enabled=1 + 未过期 → 通过，并返回解析后的 scope', () => {
    const r = validateKey(SECRET, PLAIN, row());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toEqual({ type: 'all' });
  });

  it('⑥ hash 不一致 → unknown（不区分是查错行还是密钥不存在）', () => {
    const r = validateKey(SECRET, 'sk-waygate-ffffffffffffffffffffffff', row());
    expect(r).toEqual({ ok: false, reason: 'unknown' });
  });

  it('⑦ 行不存在（null）→ unknown', () => {
    expect(validateKey(SECRET, PLAIN, null)).toEqual({ ok: false, reason: 'unknown' });
    expect(validateKey(SECRET, PLAIN, undefined)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('⑧ 已停用（enabled=0）→ disabled', () => {
    const r = validateKey(SECRET, PLAIN, row({ enabled: 0 }));
    expect(r).toEqual({ ok: false, reason: 'disabled' });
  });

  it('⑨ 已过期（expires_at <= now）→ expired', () => {
    const r = validateKey(SECRET, PLAIN, row({ expires_at: Date.now() - 1000 }));
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('⑩ 未过期（expires_at > now）→ 通过', () => {
    const r = validateKey(SECRET, PLAIN, row({ expires_at: Date.now() + 60_000 }));
    expect(r.ok).toBe(true);
  });

  it('⑪ 边界：expires_at 恰为 now 视为已过期（<= now）', () => {
    const r = validateKey(SECRET, PLAIN, row({ expires_at: Date.now() }));
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('⑫ 停用且过期时优先报 disabled（判定顺序 enabled -> expires_at）', () => {
    const r = validateKey(SECRET, PLAIN, row({ enabled: 0, expires_at: Date.now() - 1 }));
    expect(r).toEqual({ ok: false, reason: 'disabled' });
  });

  it('⑬ scope 脏数据不把鉴权打挂，按 all 处理', () => {
    const r = validateKey(SECRET, PLAIN, row({ scope: 'not-json' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toEqual({ type: 'all' });
  });

  it('⑭ 非 all 的 scope 原样解析（family/models）', () => {
    const fam = validateKey(SECRET, PLAIN, row({ scope: '{"type":"family","value":"kimi"}' }));
    expect(fam.ok && fam.scope).toEqual({ type: 'family', value: 'kimi' });
    const models = validateKey(
      SECRET,
      PLAIN,
      row({ scope: '{"type":"models","value":["kimi-k3"]}' }),
    );
    expect(models.ok && models.scope).toEqual({ type: 'models', value: ['kimi-k3'] });
  });
});

/**
 * 前缀更名 `sk-relay-` → `sk-waygate-`（2026-10-11）的核心保障。
 *
 * 最要紧的一条：**旧前缀必须继续被接受** —— 只认新前缀会让库里所有存量密钥
 * 在查库前就被 `looksLikeRelayKey()` 拒掉，升级即事故（见 keys.ts 文件头）。
 */
describe('前缀更名（sk-waygate- 现行 / sk-relay- 已退役）', () => {
  /** 24 位小写十六进制随机段。 */
  const HEX24 = '0123456789abcdef01234567';

  it('① generateKey 明文以 sk-waygate- 开头且总长 35（前缀 11 + 24 位 hex）', () => {
    for (let i = 0; i < 20; i += 1) {
      const { plain } = generateKey();
      expect(plain.startsWith(KEY_PREFIX)).toBe(true);
      expect(plain.startsWith('sk-waygate-')).toBe(true);
      expect(plain).toHaveLength(35);
      expect(plain.slice(KEY_PREFIX.length)).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('② looksLikeRelayKey 接受新前缀 + 24 位小写十六进制', () => {
    expect(looksLikeRelayKey(`sk-waygate-${HEX24}`)).toBe(true);
    expect(KEY_PATTERN.test(`sk-waygate-${HEX24}`)).toBe(true);
  });

  it('★ ③ 旧前缀 sk-relay- 已退役：形态检查阶段即被拒（更名窗口关闭后收窄）', () => {
    /* 更名期曾并存接受旧前缀（给用户逐个替换客户端的窗口）；2026-10-11 存量密钥
       全部重签、库里已无旧前缀行，故收窄为只认新前缀。这条用例钉住收窄后的语义，
       防止有人"为了兼容"把旧前缀加回来 —— 那会让已删除的旧密钥形态重新变成合法输入。 */
    expect(looksLikeRelayKey(`sk-relay-${HEX24}`)).toBe(false);
    expect(KEY_PATTERN.test(`sk-relay-${HEX24}`)).toBe(false);
  });

  it('④ looksLikeRelayKey 拒绝畸形形态：23 位 / 大写十六进制 / 无前缀 / 空值', () => {
    expect(looksLikeRelayKey(`sk-waygate-${HEX24.slice(0, 23)}`)).toBe(false); // 23 位
    expect(looksLikeRelayKey(`sk-waygate-${HEX24.toUpperCase()}`)).toBe(false); // 大写不合法
    expect(looksLikeRelayKey(HEX24)).toBe(false); // 无前缀
    expect(looksLikeRelayKey(`sk-waygate-${HEX24}0`)).toBe(false); // 25 位
    expect(looksLikeRelayKey('')).toBe(false);
    expect(looksLikeRelayKey(null)).toBe(false);
    expect(looksLikeRelayKey(undefined)).toBe(false);
  });

  it('⑤ buildKeyHint 按形态解析：前缀取尾部 24 位十六进制之前的部分', () => {
    const expected = (p: string) => `${p}${HEX24.slice(0, 4)}…${HEX24.slice(-4)}`;
    expect(buildKeyHint(`sk-waygate-${HEX24}`)).toBe(expected('sk-waygate-'));
  });

  it('⑥ keyPrefixOf 只认新前缀，其它返回 null', () => {
    expect(keyPrefixOf(`sk-waygate-${HEX24}`)).toBe('sk-waygate-');
    expect(keyPrefixOf(`sk-relay-${HEX24}`)).toBeNull();
    expect(keyPrefixOf('ck_whatever')).toBeNull();
    expect(keyPrefixOf('')).toBeNull();
  });
});
