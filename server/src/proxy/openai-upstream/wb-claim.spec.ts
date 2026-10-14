/**
 * WorkBuddy OAuth 领取域（v1.4.0）纯逻辑测试：凭证生命周期 + 签到代领 + 任务轮。
 *
 * 不碰真网络：fetch 脚本化（响应形状取自 2026-10-13 生产实验实测）。
 * 守住的事：
 *   ① OAuth 未过期不刷新；临期刷新后原子写回 + 过期时刻落库；
 *   ② 签到领取：未签 → claim → 落库；上游已签 → 对齐幂等闸不再 claim；
 *   ③ 任务轮：accept 用复数数组；claim 被拒（prerequisite）记 skipped 不算 error；
 *   ④ runAll 单段失败不影响其余段。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WbOauthService, type WbOauthCredential } from './wb-oauth.service';
import { WbClaimService } from './wb-claim.service';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { runMigrations } from '../../store/migrate';

let db: Database.Database;
let providers: ProvidersRepository;
let oauth: WbOauthService;
let claim: WbClaimService;
const PROVIDER_ID = 'p_wbclaim';
const dataDir = () => process.env.RELAY_DATA_DIR!;

const CRED: WbOauthCredential = {
  accessToken: 'at_fresh_valid',
  refreshToken: 'rt_initial',
  uid: '98b9303e-test',
  domain: 'www.workbuddy.cn',
  expiresAt: Date.now() + 20 * 24 * 3600_000, // 20 天后（远未到期）
};

/** fetch 脚本化：按路径返回预设响应；记录调用。 */
const calls: Array<{ path: string; method: string; headers: Record<string, string>; body?: string }> = [];
function stubFetch(routes: Record<string, unknown>): void {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const path = u.pathname;
      calls.push({
        path,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const key = Object.keys(routes).find((k) => path.includes(k));
      const payload = key ? routes[key] : { code: 0, msg: 'OK', data: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function seedProvider(): void {
  providers.create({
    id: PROVIDER_ID,
    name: 'WorkBuddy',
    baseUrl: 'https://copilot.tencent.com',
    active: true,
    protocol: 'openai',
    credKind: 'static',
  });
}

function writeOauth(cred: Partial<WbOauthCredential> = {}): void {
  writeFileSync(join(dataDir(), 'providers', `${PROVIDER_ID}.oauth`), JSON.stringify({ ...CRED, ...cred }, null, 2));
}

function row(): ProviderRow {
  return providers.findById(PROVIDER_ID)!;
}

describe('WbOauthService（凭证生命周期）', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = new Database(':memory:');
    runMigrations(db, undefined);
    providers = new ProvidersRepository(db);
    process.env.RELAY_DATA_DIR = join(tmpdir(), `relay-wbclaim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(process.env.RELAY_DATA_DIR, 'providers'), { recursive: true });
    oauth = new WbOauthService(providers, false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(process.env.RELAY_DATA_DIR!, { recursive: true, force: true });
    delete process.env.RELAY_DATA_DIR;
    db.close();
  });

  it('① 未过期 → 直接返回 token（不打 refresh）', async () => {
    seedProvider();
    writeOauth();
    stubFetch({});
    const t = await oauth.accessToken(row());
    expect(t).toBe('at_fresh_valid');
    expect(calls).toHaveLength(0);
    expect(oauth.configured(PROVIDER_ID)).toBe(true);
    expect(oauth.statusOf(PROVIDER_ID)).toMatchObject({ configured: true });
  });

  it('② 临期（2 天内）→ 刷新、原子写回、过期时刻落库', async () => {
    seedProvider();
    writeOauth({ expiresAt: Date.now() + 24 * 3600_000 }); // 1 天后到期 < 2 天阈值
    stubFetch({
      '/v2/plugin/auth/token/refresh': { code: 0, data: { accessToken: 'at_new', refreshToken: 'rt_new', expiresIn: 2419200 } },
    });
    const t = await oauth.accessToken(row());
    expect(t).toBe('at_new');
    const refreshCall = calls.find((c) => c.path.includes('token/refresh'));
    expect(refreshCall?.headers['x-refresh-token']).toBe('rt_initial');
    expect(refreshCall?.headers['x-auth-refresh-source']).toBe('plugin');
    const written = JSON.parse(readFileSync(join(dataDir(), 'providers', `${PROVIDER_ID}.oauth`), 'utf8'));
    expect(written.accessToken).toBe('at_new');
    expect(written.refreshToken).toBe('rt_new');
    expect(providers.findById(PROVIDER_ID)!.wb_oauth_expires_at).toBeGreaterThan(Date.now());
  });

  it('③ importCredential 缺字段拒绝；完整导入落盘', () => {
    seedProvider();
    expect(() => oauth.importCredential(row(), { accessToken: 'a', refreshToken: '', uid: 'u' })).toThrow();
    oauth.importCredential(row(), CRED);
    expect(oauth.configured(PROVIDER_ID)).toBe(true);
  });
});

describe('WbClaimService（领取域）', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = new Database(':memory:');
    runMigrations(db, undefined);
    providers = new ProvidersRepository(db);
    process.env.RELAY_DATA_DIR = join(tmpdir(), `relay-wbclaim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(process.env.RELAY_DATA_DIR, 'providers'), { recursive: true });
    oauth = new WbOauthService(providers, false);
    claim = new WbClaimService(providers, oauth);
    seedProvider();
    writeOauth();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(process.env.RELAY_DATA_DIR!, { recursive: true, force: true });
    delete process.env.RELAY_DATA_DIR;
    db.close();
  });

  it('① 签到领取：未签 → claim → 落库（日期/连签/积分）', async () => {
    stubFetch({
      'checkin-activity-status': { code: 0, data: { active: true, today_checked_in: false, streak_days: 10 } },
      'daily-checkin': { code: 0, data: { credit: 100, streak_days: 11 } },
    });
    const r = await claim.claimSignin(row(), true);
    expect(r.outcome).toBe('claimed');
    expect(r.points).toBe(100);
    expect(r.streak).toBe(11);
    const after = row();
    expect(after.wb_signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.wb_signin_last_points).toBe(100);
    /* 领取域头：OAuth Bearer + x-user-id + machine/session 派生头 */
    const claimCall = calls.find((c) => c.path.includes('daily-checkin'));
    expect(claimCall?.headers.authorization).toBe('Bearer at_fresh_valid');
    expect(claimCall?.headers['x-user-id']).toBe('98b9303e-test');
    expect(claimCall?.headers['x-machine-id']).toHaveLength(36);
  });

  it('② 上游已签 → 对齐幂等闸，不打 claim', async () => {
    stubFetch({
      'checkin-activity-status': { code: 0, data: { active: true, today_checked_in: true, streak_days: 11, today_credit: 100 } },
    });
    const r = await claim.claimSignin(row(), true);
    expect(r.outcome).toBe('already');
    expect(calls.find((c) => c.path.includes('daily-checkin'))).toBeUndefined();
    expect(row().wb_signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('③ 任务轮：accept 复数数组；claim 成功与被拒（prerequisite）分开记录', async () => {
    stubFetch({
      '/tasks/accept': { code: 0, data: {} },
      '/tasks/create_canvas/claim': { code: 0, data: { already_claimed: true, credit: 0, energy: 0 } },
      '/tasks/RichMeow_Chat/claim': { code: 400, msg: 'task not completed' },
      '/growth/tasks': {
        code: 0,
        data: {
          tasks: [
            { task_code: 'create_canvas', title: '体验设计模式', locked: false },
            { task_code: 'RichMeow_Chat', title: '桌面端对话', locked: false },
            { task_code: 'locked_one', title: '锁定任务', locked: true },
          ],
        },
      },
    });
    const results = await claim.runTasks(row());
    const acceptCall = calls.find((c) => c.path.endsWith('/tasks/accept'));
    expect(JSON.parse(String(acceptCall?.body))).toEqual({ task_codes: ['create_canvas', 'RichMeow_Chat'] });
    const byCode = Object.fromEntries(results.map((r) => [r.code, r]));
    expect(byCode.create_canvas.outcome).toBe('already'); // 探针实测：已领任务再 claim → already_claimed
    expect(byCode.RichMeow_Chat.outcome).toBe('skipped'); // 'task not completed' → skipped 不算 error
    expect(byCode.locked_one).toBeUndefined(); // locked 不参与
  });

  it('④ 连登兑换：只对 available 档发 redeem（client_token 每次新鲜）', async () => {
    stubFetch({
      '/growth/streak': { code: 0, data: { streak: { days: 11 }, redemption_status: { tier_7d_status: 'available', tier_14d_status: 'claimed', tier_28d_status: 'locked' } } },
      '/growth/redeem': { code: 0, data: { credit_granted: 40 } },
    });
    const out = await claim.redeemStreak(row());
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ tier: '7d', ok: true });
    expect(out[1]).toMatchObject({ tier: '14d', ok: false, detail: 'claimed' });
    const redeemCalls = calls.filter((c) => c.path.includes('redeem'));
    expect(redeemCalls).toHaveLength(1); // 只发了 7d
    expect(JSON.parse(String(redeemCalls[0].body)).tier).toBe('7d');
    expect(JSON.parse(String(redeemCalls[0].body)).client_token).toMatch(/[\da-f-]{36}/);
  });

  it('⑤ runAll：签到段抛错不影响任务/兑换段', async () => {
    stubFetch({
      'checkin-activity-status': { code: 1001, msg: '活动维护中' },
      '/growth/tasks': { code: 0, data: { tasks: [{ task_code: 't1', title: 'T', locked: false }] } },
      '/tasks/accept': { code: 0, data: {} },
      '/tasks/t1/claim': { code: 0, data: { credit: 5, energy: 2 } },
      '/growth/streak': { code: 0, data: { redemption_status: {} } },
    });
    const report = await claim.runAll(row());
    expect(report.signin.outcome).toBe('error');
    expect(report.signin.message).toContain('活动维护中');
    expect(report.tasks.some((t) => t.code === 't1' && t.outcome === 'claimed')).toBe(true);
    expect(report.redeems).toHaveLength(3); // 三档都按 unknown 处理但流程走完
  });
});
