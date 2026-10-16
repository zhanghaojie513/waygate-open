/**
 * WorkBuddy 签到状态同步服务（v1.3.0）的纯逻辑测试。
 *
 * 不碰真网络：`fetch` 被脚本化。面板响应形状取自生产探针实测
 * （tools/probe-wb-activities.mjs，2026-10-13）。语义定案：上游不允许 ck_ 代领
 * （daily-checkin 403 原话 "API key not allowed for this path or method"），
 * 本服务只做**只读状态同步**。重点守五件事：
 *   ① 上游确认今日已签 → 落库（本地幂等闸对齐，UI 显示"今日已签"）；
 *   ② 今日未签 → 'pending'（不打 claim、指引官方端领取）；
 *   ③ 本地幂等闸：今天已确认 → 不打上游；
 *   ④ runDaily 只挑 openai 提供商，设置开关关闭时不打上游；
 *   ⑤ 状态同步永不发 daily-checkin（只打 checkin-activity-status）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WbSigninService } from './wb-signin.service';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { runMigrations } from '../../store/migrate';
import { defaultSettings, type RelaySettings } from '../../config/settings.defaults';
import type { RelayConfigService } from '../../config/config.service';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: Database.Database;
let providers: ProvidersRepository;
const PROVIDER_ID = 'p_wbsign';

function makeConfig(settings: RelaySettings): RelayConfigService {
  return {
    get: () => settings,
    get upstreamKey() {
      return 'ck_test_fake_key_123456';
    },
  } as unknown as RelayConfigService;
}

/** 造一个已登记的 openai 提供商。 */
function seedProvider(protocol = 'openai'): void {
  providers.create({
    id: PROVIDER_ID,
    name: 'WorkBuddy',
    baseUrl: 'https://copilot.tencent.com',
    active: true,
    protocol,
    credKind: 'static',
  });
}

/** 把 fetch 脚本化（只有 status 一个端点会被调）；记录调用明细。 */
const calls: Array<{ url: string; method: string; auth: string; xuid: string }> = [];
function stubFetch(panel: unknown): void {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method: init?.method ?? 'GET', auth: h.authorization ?? '', xuid: h['x-user-id'] ?? '' });
      return new Response(JSON.stringify(panel), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** 探针实测的 checkin-activity-status 成功响应（2026-10-13）。 */
const PANEL_SIGNED = {
  code: 0,
  msg: 'OK',
  data: {
    active: true,
    today_checked_in: true,
    streak_days: 11,
    daily_credit: 100,
    today_credit: 100,
    total_credits: 1100,
    activity_name: 'Buddy加油站',
  },
};
const PANEL_UNSIGNED = {
  code: 0,
  msg: 'OK',
  data: { active: true, today_checked_in: false, streak_days: 10, daily_credit: 100, today_credit: 100, total_credits: 1000 },
};

describe('WbSigninService（状态同步语义）', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = new Database(':memory:');
    runMigrations(db, undefined);
    providers = new ProvidersRepository(db);
    process.env.RELAY_DATA_DIR = join(tmpdir(), `relay-wbsign-test-${Date.now()}`);
    mkdirSync(join(process.env.RELAY_DATA_DIR, 'providers'), { recursive: true });
    writeFileSync(join(process.env.RELAY_DATA_DIR, 'providers', `${PROVIDER_ID}.key`), 'ck_test_fake_key_123456\n');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(process.env.RELAY_DATA_DIR!, { recursive: true, force: true });
    delete process.env.RELAY_DATA_DIR;
    db.close();
  });

  function makeSvc(settings = defaultSettings()): WbSigninService {
    /* [v1.6.11] 修既存参数错位：第 3 参是 oauth、第 5 参才是 autoStart。
     原先把 false 传给了 oauth（类型不符），本意是关定时器。 */
    return new WbSigninService(providers, makeConfig(settings), undefined, undefined, false);
  }

  function row(): ProviderRow {
    return providers.findById(PROVIDER_ID)!;
  }

  it('① 面板解析：探针实测形状全量映射；请求带 X-User-Id 与 ck_ Bearer', async () => {
    seedProvider();
    stubFetch(PANEL_SIGNED);
    const panel = await makeSvc().panel(row());
    expect(panel.active).toBe(true);
    expect(panel.todayCheckedIn).toBe(true);
    expect(panel.streak).toBe(11);
    expect(panel.todayCredit).toBe(100);
    expect(panel.totalCredits).toBe(1100);
    expect(panel.activityName).toBe('Buddy加油站');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('checkin-activity-status');
    expect(calls[0].auth).toBe('Bearer ck_test_fake_key_123456');
    expect(calls[0].xuid).toBe('relay-station'); // 签到族必带（值不校验，两轮 403 实测后定案）
  });

  it('② 上游确认今日已签 → synced 且落库（日期/连签/积分）', async () => {
    seedProvider();
    stubFetch(PANEL_SIGNED);
    const result = await makeSvc().signin(row(), true);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('synced');
    expect(result.streak).toBe(11);
    const after = row();
    expect(after.wb_signin_checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.wb_signin_streak).toBe(11);
    expect(after.wb_signin_last_points).toBe(100);
  });

  it('③ 今日未签 → pending：指引官方端领取，**绝不打 daily-checkin**', async () => {
    seedProvider();
    stubFetch(PANEL_UNSIGNED);
    const result = await makeSvc().signin(row(), true);
    expect(result.outcome).toBe('pending');
    expect(result.message).toContain('官方');
    expect(calls.every((c) => !c.url.includes('daily-checkin'))).toBe(true);
    expect(row().wb_signin_checked_on).toBeNull(); // 未签不落闸（明天再同步）
  });

  it('④ 本地幂等闸：今天已确认 → 不打上游直接 synced', async () => {
    seedProvider();
    stubFetch(PANEL_SIGNED);
    const s = makeSvc();
    await s.signin(row(), true);
    const callsAfterFirst = calls.length;
    const result = await s.signin(row(), false); // 非强制
    expect(result.outcome).toBe('synced');
    expect(calls.length).toBe(callsAfterFirst); // 没有新请求
  });

  it('⑤ 活动未开（active=false）→ unavailable', async () => {
    seedProvider();
    stubFetch({ code: 0, msg: 'OK', data: { active: false } });
    const result = await makeSvc().signin(row(), true);
    expect(result.outcome).toBe('unavailable');
  });

  it('⑥ 业务码非 0 → error 且带上游 msg', async () => {
    seedProvider();
    stubFetch({ code: 1001, msg: '活动已结束', data: {} });
    const result = await makeSvc().signin(row(), true);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.message).toContain('活动已结束');
  });

  it('⑦ runDaily 只挑 openai 提供商（anthropic/qoder 不打）', async () => {
    seedProvider('anthropic');
    stubFetch(PANEL_SIGNED);
    await makeSvc().runDaily();
    expect(calls).toHaveLength(0);
  });

  it('⑧ 设置开关关闭 → runDaily 不打上游', async () => {
    seedProvider();
    stubFetch(PANEL_SIGNED);
    const settings = defaultSettings();
    settings.signin.workBuddyEnabled = false;
    await makeSvc(settings).runDaily();
    expect(calls).toHaveLength(0);
  });
});
