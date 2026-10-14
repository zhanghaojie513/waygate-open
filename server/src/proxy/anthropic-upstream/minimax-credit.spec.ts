/**
 * MiniMax 积分账本服务（v0.5.7）测试：真实口径的解析与「拿不到就说拿不到」的纪律。
 *
 * 守三件事：
 *   ① 多笔发放**求和**（remaining/consumed/granted）；
 *   ② 字段缺失/格式怪 → 跳过该笔，**不编造**（宁可少算）；
 *   ③ 拉取失败保留旧值并置 stale，绝不抹零。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimaxCreditService } from './minimax-credit.service';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import { MinimaxTokenService } from './minimax-token.service';
import { runMigrations } from '../../store/migrate';

const PID = 'p_credit';
let db: Database.Database;
let providers: ProvidersRepository;
let svc: MinimaxCreditService;

const DETAILS = {
  base_resp: { status_code: 0, status_msg: 'ok' },
  total_count: 2,
  details: [
    { credit_type: 2, granted_amount: '400.00', remaining_amount: '400.00', consumed_amount: '0.00', granted_at_ms: 1, expire_at_ms: Date.now() + 86400000 },
    { credit_type: 2, granted_amount: '400.00', remaining_amount: '341.06', consumed_amount: '58.94', granted_at_ms: 2, expire_at_ms: Date.now() + 2 * 86400000 },
  ],
};

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  providers = new ProvidersRepository(db);
  providers.create({
    id: PID,
    name: 'MiniMax Code',
    baseUrl: 'https://agent.minimax.cn',
    active: true,
    protocol: 'anthropic',
    credKind: 'oauth_minimax',
  });
  const tokens = { accessToken: async () => 'mmoat_test' } as unknown as MinimaxTokenService;
  svc = new MinimaxCreditService(providers, tokens, false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  vi.restoreAllMocks();
});

const row = () => providers.findById(PID)!;

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe('MinimaxCreditService · 账本解析', () => {
  it('★ 多笔发放求和：granted/remaining/consumed 各自累加（精确到 0.01）', async () => {
    stub(DETAILS);
    const snap = await svc.refreshOne(row());
    expect(snap.granted).toBe(800);
    expect(snap.remaining).toBe(741.06);
    expect(snap.consumed).toBe(58.94);
    expect(snap.grants).toHaveLength(2);
    expect(snap.nextExpireAt).toBeGreaterThan(Date.now()); // 最近一笔未过期
  });

  it('★ 金额字段缺失的笔跳过，不编造（宁可少算）', async () => {
    stub({
      base_resp: { status_code: 0 },
      details: [
        { credit_type: 2, granted_amount: '400.00', remaining_amount: '400.00', consumed_amount: '0.00', expire_at_ms: Date.now() + 1000 },
        { credit_type: 2, granted_amount: null, remaining_amount: '100.00', consumed_amount: '0.00' }, // 缺 granted → 跳过
        { credit_type: 2, granted_amount: '50.00', remaining_amount: 'x', consumed_amount: '0' }, // 非数字 → 跳过
      ],
    });
    const snap = await svc.refreshOne(row());
    expect(snap.grants).toHaveLength(1);
    expect(snap.granted).toBe(400);
  });

  it('业务码非 0 → 抛错（调用方记失败，不落假数据）', async () => {
    stub({ base_resp: { status_code: 12345, status_msg: 'boom' } });
    await expect(svc.refreshOne(row())).rejects.toThrow('boom');
  });

  it('缺 details 数组 → 抛错', async () => {
    stub({ base_resp: { status_code: 0 } });
    await expect(svc.refreshOne(row())).rejects.toThrow(/details/);
  });

  it('HTTP 非 2xx → 抛错', async () => {
    stub({}, 500);
    await expect(svc.refreshOne(row())).rejects.toThrow(/HTTP 500/);
  });
});

describe('MinimaxCreditService · 失败保留旧值', () => {
  it('★ 成功后再失败：保留上次的值并置 stale，绝不抹零', async () => {
    stub(DETAILS);
    await svc.refreshOne(row());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await svc.refreshAll(); // 走失败路径

    const block = svc.block(row());
    expect(block.available).toBe(true);
    expect(block.remaining).toBe(741.06); // 旧值还在
    expect(block.stale).toBe(true);
    expect(block.message).toContain('network down');
  });

  it('从未成功过 → available=false，字段全 null（不假装有数）', () => {
    const block = svc.block(row());
    expect(block.available).toBe(false);
    expect(block.remaining).toBeNull();
    expect(block.consumed).toBeNull();
    expect(block.nextExpireAt).toBeNull();
  });
});

describe('MinimaxCreditService · 范围', () => {
  it('只统计 oauth_minimax 提供商（WorkBuddy 不在此列）', async () => {
    providers.create({ id: 'p_wb', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: true });
    stub(DETAILS);
    await svc.refreshAll();
    const blocks = svc.allBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].providerId).toBe(PID);
  });
});
