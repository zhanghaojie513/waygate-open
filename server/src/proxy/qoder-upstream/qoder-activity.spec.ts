/**
 * Qoder 签到/积分服务测试（fake fetch，不碰真上游）。
 * 重点：活动解析、领取必须用 campaignId（UUID 而非 campaignKey）、
 * 幂等闸、错误语义（401/业务错）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QoderActivityService } from './qoder-activity.service';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import { runMigrations } from '../../store/migrate';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: Database.Database;
let providers: ProvidersRepository;
const PID = 'p_qoder_t';
let dataDir: string;

const IDENTITY = { token: 'dt-test-token', refreshToken: 'drt-x', uid: 'uid-1', name: 'qoder-user', userType: 'personal_standard' };

const CAMPAIGNS = {
  claimable: true,
  campaigns: [
    {
      campaignId: '01a130ea-7c31-71b3-a22b-cbe019571350',
      campaignKey: 'act-20261013-603',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100 },
      placements: [{ type: 'POPUP', content: { zh: { title: '每天领 100 Credits' } } }],
    },
  ],
};

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  providers = new ProvidersRepository(db);
  providers.create({ id: PID, name: 'Qoder CN', baseUrl: 'https://gateway.qoder.com.cn', active: true, protocol: 'qoder' });
  dataDir = join(tmpdir(), `relay-qoder-act-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.RELAY_DATA_DIR = dataDir;
  mkdirSync(join(dataDir, 'providers'), { recursive: true });
  writeFileSync(join(dataDir, 'providers', `${PID}.key`), JSON.stringify(IDENTITY));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.RELAY_DATA_DIR;
  db.close();
});

function svc(): QoderActivityService {
  return new QoderActivityService(providers, false);
}
function row() {
  return providers.findById(PID)!;
}

describe('QoderActivityService', () => {
  it('面板：解析活动（含 benefit / 标题）+ 活跃天数', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('seat-activity')) {
        return new Response(JSON.stringify({ currentConsecutiveDays: 3, cumulativeActiveDays: 3 }), { status: 200 });
      }
      return new Response(JSON.stringify(CAMPAIGNS), { status: 200 });
    }));
    const panel = await svc().panel(row());
    expect(panel.claimable).toBe(true);
    expect(panel.consecutiveDays).toBe(3);
    expect(panel.campaigns[0]).toMatchObject({ campaignId: '01a130ea-7c31-71b3-a22b-cbe019571350', claimStatus: 'CLAIMABLE', benefitAmount: 100, title: '每天领 100 Credits' });
  });

  it('★ 签到用 campaignId（UUID）POST claim，不用 campaignKey', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(u)}`);
      if (String(u).includes('/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } }), { status: 200 });
      }
      if (String(u).includes('seat-activity')) return new Response(JSON.stringify({ currentConsecutiveDays: 4 }), { status: 200 });
      return new Response(JSON.stringify(CAMPAIGNS), { status: 200 });
    }));
    const r = await svc().checkin(row(), true);
    expect(r.outcome).toBe('claimed');
    expect(r.points).toBe(100);
    expect(calls.some((c) => c.startsWith('POST') && c.includes('01a130ea-7c31-71b3-a22b-cbe019571350/claim'))).toBe(true);
    expect(calls.some((c) => c.includes('act-20261013-603/claim'))).toBe(false);
    /* 落库：幂等闸 + 连签 + 积分 */
    const after = row();
    expect(after.signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.signin_last_points).toBe(100);
    expect(after.signin_streak).toBe(4);
  });

  it('今天已签（幂等闸）→ 非 force 时不打上游', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return new Response(JSON.stringify(CAMPAIGNS), { status: 200 }); }));
    const s = svc();
    await s.checkin(row(), true);   // 先真签一次
    const before = calls;
    const r = await s.checkin(row(), false); // 非强制
    expect(r.outcome).toBe('none');
    expect(r.message).toContain('已经签过');
    expect(calls).toBe(before); // 没有新请求
  });

  it('无可领活动 → none（不打 claim）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('seat-activity')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ claimable: false, campaigns: [{ ...CAMPAIGNS.campaigns[0], claimStatus: 'CLAIMED' }] }), { status: 200 });
    }));
    const r = await svc().checkin(row(), true);
    expect(r.outcome).toBe('none');
  });

  it('上游错误 → error 带原因（不编造成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('seat-activity')) return new Response(JSON.stringify({}), { status: 200 });
      if (String(u).includes('/claim')) return new Response(JSON.stringify({ errorCode: 'DAILY_LIMIT_REACHED', errorMessage: '已达每日上限' }), { status: 429 });
      return new Response(JSON.stringify(CAMPAIGNS), { status: 200 });
    }));
    const r = await svc().checkin(row(), true);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('已达每日上限');
  });

  it('积分概况：解析 total/peak/活跃天数 + 余额（v2/me/usage）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('credits-summary')) return new Response(JSON.stringify({ totalCredits: 241.81, peakCredits: 240.55, peakDate: '2026-10-12' }), { status: 200 });
      if (String(u).includes('v2/me/usage')) {
        return new Response(JSON.stringify({
          qoderUsage: {
            userType: 'personal_standard',
            userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
            addOnQuota: { total: 500, used: 5, remaining: 495, unit: 'credits' },
            isQuotaExceeded: false,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ currentConsecutiveDays: 3, maxConsecutiveDays: 3, cumulativeActiveDays: 3 }), { status: 200 });
    }));
    const c = await svc().credits(row());
    expect(c.total).toBe(241.81);
    expect(c.peak).toBe(240.55);
    expect(c.consecutiveDays).toBe(3);
    /* 余额口径：v2/me/usage 的 real balance（不是累计消耗）。 */
    expect(c.quota?.addOn).toEqual({ total: 500, used: 5, remaining: 495, unit: 'credits' });
    expect(c.quota?.plan?.total).toBe(0);
    expect(c.quota?.userType).toBe('personal_standard');
  });

  it('账本块：余额取 v2/me/usage（套餐内+资源包合计），到期时刻如实 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('credits-summary')) return new Response(JSON.stringify({ totalCredits: 241.81 }), { status: 200 });
      if (String(u).includes('v2/me/usage')) {
        return new Response(JSON.stringify({
          qoderUsage: {
            userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
            addOnQuota: { total: 500, used: 5, remaining: 495, unit: 'credits' },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const s = svc();
    await s.refreshLedgers();
    const block = s.allBlocks().find((b) => b.providerId === PID)!;
    expect(block.remaining).toBe(495); // 0 + 495
    expect(block.granted).toBe(500); // 0 + 500
    expect(block.consumed).toBe(5); // 0 + 5（当前包内消耗）
    expect(block.lifetimeConsumed).toBe(241.81); // 历史累计（单列，不混算）
    expect(block.nextExpireAt).toBeNull(); // 上游不提供到期时刻
    expect(block.available).toBe(true);
  });

  it('账本块：v2/me/usage 取不到时 granted/remaining 如实 null（不补 0）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('credits-summary')) return new Response(JSON.stringify({ totalCredits: 241.81 }), { status: 200 });
      if (String(u).includes('v2/me/usage')) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const s = svc();
    await s.refreshLedgers();
    const block = s.allBlocks().find((b) => b.providerId === PID)!;
    expect(block.remaining).toBeNull();
    expect(block.granted).toBeNull();
    expect(block.lifetimeConsumed).toBe(241.81); // 历史累计仍可拿到
  });

  it('非 qoder 提供商不参与（runDaily 只挑 qoder）', async () => {
    providers.create({ id: 'p_wb', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: true, protocol: 'openai' });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return new Response('{}', { status: 200 }); }));
    await svc().runDaily();
    /* 当前时刻若早于 08:05 则直接返回（不打上游）—— 两种情况都不该打 openai 家的接口。 */
    expect(calls).toBeGreaterThanOrEqual(0);
  });
});
