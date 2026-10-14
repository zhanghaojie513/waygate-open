/**
 * MiniMax 签到服务（v0.5.6）的纯逻辑测试：幂等闸、面板解析、领取落库。
 *
 * 不碰真网络：`call()` 被替换成脚本化的响应。重点守两件事：
 *   ① 同一天**不重复 claim**（上游会拒，白打一次）；
 *   ② claim 成功后日期/连续天数/积分必须落库（否则 UI 永远显示"未签到"）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimaxSigninService } from './minimax-signin.service';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import { MinimaxTokenService } from './minimax-token.service';
import { runMigrations } from '../../store/migrate';

let db: Database.Database;
let providers: ProvidersRepository;
let svc: MinimaxSigninService;
const PROVIDER_ID = 'p_signin';

/** 造一个已登记的 MiniMax oauth 提供商。 */
function seedProvider(): void {
  providers.create({
    id: PROVIDER_ID,
    name: 'MiniMax Code',
    baseUrl: 'https://agent.minimax.cn',
    active: true,
    protocol: 'anthropic',
    credKind: 'oauth_minimax',
  });
}

/** 把 fetch 脚本化：status 返回给定面板，claim 返回给定结果。 */
function stubFetch(panel: unknown, claim?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const isClaim = String(url).includes('/claim');
      const body = isClaim ? (claim ?? {}) : panel;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const PANEL_CLAIMABLE = {
  base_resp: { status_code: 0 },
  data: {
    days: [
      { day_no: 1, points: 400, status: 3, is_today: false },
      { day_no: 2, points: 400, status: 2, is_today: true },
      { day_no: 3, points: 400, status: 1, is_today: false },
    ],
  },
};
const PANEL_DONE = {
  base_resp: { status_code: 0 },
  data: { days: [{ day_no: 2, points: 400, status: 3, is_today: true }] },
};
const CLAIM_OK = { base_resp: { status_code: 0 }, data: { claim_result: 1, day_no: 2, points: 400 } };

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  providers = new ProvidersRepository(db);
  seedProvider();
  /* token 服务替换成桩（access token 刷新不在本 spec 的关注点）。 */
  const tokens = { accessToken: async () => 'mmoat_test_token' } as unknown as MinimaxTokenService;
  svc = new MinimaxSigninService(providers, tokens, false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  vi.restoreAllMocks();
});

const row = () => providers.findById(PROVIDER_ID)!;

describe('MinimaxSigninService.panel', () => {
  it('解析今日格子：可签 / 连续天数 / 应得积分', async () => {
    stubFetch(PANEL_CLAIMABLE);
    const p = await svc.panel(row());
    expect(p.claimable).toBe(true);
    expect(p.streak).toBe(2);
    expect(p.todayPoints).toBe(400);
  });

  it('已签的今天 → claimable=false', async () => {
    stubFetch(PANEL_DONE);
    const p = await svc.panel(row());
    expect(p.claimable).toBe(false);
  });
});

describe('MinimaxSigninService.signin', () => {
  it('★ 可签 → claim 并落库（日期/连续天数/积分）', async () => {
    stubFetch(PANEL_CLAIMABLE, CLAIM_OK);
    const res = await svc.signin(row());
    expect(res.outcome).toBe('claimed');
    expect(res.points).toBe(400);
    const r = row();
    expect(r.signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.signin_streak).toBe(2);
    expect(r.signin_last_points).toBe(400);
  });

  it('★ 幂等：同日第二次调用直接返回 already，**不再打上游**', async () => {
    stubFetch(PANEL_CLAIMABLE, CLAIM_OK);
    await svc.signin(row());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const callsAfterFirst = fetchMock.mock.calls.length;

    const again = await svc.signin(row());
    expect(again.outcome).toBe('already');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // 零新请求
  });

  it('今天不可签（已签）→ outcome=unavailable，且记下日期（避免本轮反复打）', async () => {
    stubFetch(PANEL_DONE);
    const res = await svc.signin(row());
    expect(res.outcome).toBe('unavailable');
    expect(row().signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row().signin_last_points).toBeNull(); // 没领到就不编造积分
  });

  it('上游业务码非 0 → outcome=error 且不落库', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } }), { status: 200 })),
    );
    const res = await svc.signin(row());
    expect(res.outcome).toBe('error');
    expect(res.message).toContain('invalid timezone_id');
    expect(row().signin_checked_on).toBeNull();
  });

  it('force=true 时即使今天签过也复查面板（手动补签路径）', async () => {
    stubFetch(PANEL_CLAIMABLE, CLAIM_OK);
    await svc.signin(row());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await svc.signin(row(), true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('MinimaxSigninService.runDaily · 时间闸', () => {
  it('★ 未到本地 08:05 不打上游（不白耗请求）', async () => {
    /* 冻结时间到 Asia/Shanghai 的 03:00 —— 远早于 08:05。 */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T03:00:00+08:00'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await svc.runDaily();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('★ 已过点且今天未签 → 真打上游并落库', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T09:00:00+08:00'));
    stubFetch(PANEL_CLAIMABLE, CLAIM_OK);
    await svc.runDaily();
    expect(row().signin_checked_on).toBe('2026-10-11');
    expect(row().signin_last_points).toBe(400);
    vi.useRealTimers();
  });

  it('★ 已过点但今天已签 → 幂等跳过（零请求）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T09:00:00+08:00'));
    stubFetch(PANEL_CLAIMABLE, CLAIM_OK);
    await svc.runDaily(); // 第一次签
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const after = fetchMock.mock.calls.length;
    await svc.runDaily(); // 第二次：同日应跳过
    expect(fetchMock.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });
});
