/**
 * [2026-10-18] `GET /api/keys` 的 `usedIps` / `usedTokens` 语义。
 *
 * ## 缺陷背景
 * 这两个字段是「配额/白名单的可视化对照」。没设限额的密钥不查用量（省两条全量聚合），
 * 但此前返回的是 **0** —— 0 会被读成「一次都没用过」，而事实是「没查」。
 * 与项目铁律「0 是事实、未知才不是 0」冲突，也与 `/v1/usage`（无论是否限额都返回真实累计）
 * 在同一把密钥上给出两个不同的数。
 *
 * ## 不变式
 *   · 无 maxIps 且无 tokenQuota → `usedIps = null`、`usedTokens = null`
 *   · 只要设了任一项 → 两者都是**真实值**（不是 null、也不是 0 占位）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './client-harness';
import { KeysService } from './keys.service';

let h: Harness;
let keys: KeysService;

beforeEach(() => {
  h = makeHarness();
  keys = new KeysService(
    { get: () => ({}) } as unknown as ConstructorParameters<typeof KeysService>[0],
    h.keysRepo,
    // StatsRepository 用于 requests24h；测试里不关心，给个恒 0 的桩
    { requestsForKey: () => 0 } as unknown as ConstructorParameters<typeof KeysService>[2],
  );
});
afterEach(() => {
  h.db.close();
});

const rowOf = (id: string) => keys.list().items.find((k) => k.id === id)!;

describe('keys.usedIps / usedTokens · 未计算必须返回 null（不是 0）', () => {
  it('★ 无任何限额 → null / null', () => {
    h.makeKey('k_free', 'Free', 'sk-waygate-free…0001');
    const row = rowOf('k_free');
    expect(row.usedIps).toBeNull();
    expect(row.usedTokens).toBeNull();
  });

  it('★ 设了 tokenQuota → 两项都是真实值（0 次用量的密钥也是 0，不是 null）', () => {
    h.makeKey('k_q', 'Quota', 'sk-waygate-quota…0002');
    keys.patch('k_q', { tokenQuota: 1000 });
    const row = rowOf('k_q');
    expect(row.usedTokens).toBe(0); // 真实值：确实还没用过
    expect(row.usedIps).toBe(0);
    expect(row.usedTokens).not.toBeNull();
  });

  it('★ 设了 maxIps（只限 IP 数）→ 同样查真实用量', () => {
    h.makeKey('k_ip', 'IpLimit', 'sk-waygate-ip…0003');
    keys.patch('k_ip', { maxIps: 5 });
    const row = rowOf('k_ip');
    expect(row.usedIps).toBe(0);
    expect(row.usedTokens).toBe(0);
  });
});
