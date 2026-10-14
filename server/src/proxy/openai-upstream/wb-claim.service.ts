/**
 * WorkBuddy 领取域服务（v1.4.0）：签到代领 + 成长任务轮 + 连登兑换。
 *
 * ## 权限域（上游实测边界）
 * 这些端点全部在**用户会话域**（OAuth）——ck_ 恒 403（"API key not allowed"）。
 * 凭证由 `WbOauthService` 提供（providers/<id>.oauth，多会话共存不互踢）。
 *
 * ## 端点（契约逆向自桌面端 H5，88lin/HanawaBanana 社区实证 + 本地实验 2026-10-13）
 *   POST /v2/billing/meter/daily-checkin                —— 签到领取（幂等：重复上游拒）
 *   GET  /v2/activity/growth/tasks                      —— 任务列表（task_code/title/locked）
 *   POST /v2/activity/growth/tasks/accept               —— 接任务，body {"task_codes":[…]}（**复数数组**）
 *   POST /v2/activity/growth/tasks/{task_code}/claim    —— 领奖（路径带 code、body 空）
 *   GET  /v2/activity/growth/streak                     —— 连登 + 兑换档状态（redemption_status）
 *   POST /v2/activity/growth/redeem                     —— 兑换，body {"tier":"7d","client_token":"<uuid>"}
 *
 * ## 诚实边界（不编造、不模拟行为）
 *   · 任务多为「体验 XX」型，claim 的前置是真实使用行为 —— accept 后 claim 被拒
 *     （prerequisite not met）就如实记 skipped，**绝不伪造对话/行为去凑任务**。
 *   · 补登卡/抽奖/Buddy 旅行不自动化（资源消耗型，替用户做决定不合适）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { WbOauthService, wbOauthHeaders } from './wb-oauth.service';
import {
  WB_SIGNIN_STATUS_PATH,
  WB_SIGNIN_CLAIM_PATH,
  WB_GROWTH_TASKS_PATH,
  WB_GROWTH_TASKS_ACCEPT_PATH,
  WB_GROWTH_STREAK_PATH,
  WB_GROWTH_REDEEM_PATH,
  buildWbPathUrl,
} from '../upstream-url';

const REQUEST_TIMEOUT_MS = 20_000;

export interface GrowthTaskOutcome {
  code: string;
  title: string | null;
  /** 'claimed'（本轮真领到）| 'already'（此前已领）| 'accepted'（已接单待完成）| 'skipped'（任务未完成）| 'error' */
  outcome: 'claimed' | 'already' | 'accepted' | 'skipped' | 'error';
  reason?: string;
}

export interface RedeemOutcome {
  tier: string;
  ok: boolean;
  detail: string;
}

export interface GrowthRunReport {
  /** 签到结果（领取域口径；'claimed' = 本次真领到积分）。 */
  signin: { outcome: string; points: number | null; streak: number | null; message: string };
  tasks: GrowthTaskOutcome[];
  redeems: RedeemOutcome[];
  /** 整轮里认领到的积分合计（签到 + 任务 + 兑换里上游明示的 credit 数）。 */
  creditsGained: number;
}

@Injectable()
export class WbClaimService {
  private readonly logger = new Logger(WbClaimService.name);

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    @Inject(WbOauthService) private readonly oauth: WbOauthService,
  ) {}

  /** 打一次领取域接口（信封 {code,msg,data}；code 非 0 抛错带 msg）。 */
  private async call(
    provider: ProviderRow,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const token = await this.oauth.accessToken(provider);
    const snapshot = this.oauth.credentialSnapshot(provider.id);
    const cred = { accessToken: token, refreshToken: '', uid: snapshot?.uid ?? '', deviceToken: snapshot?.deviceToken };
    const headers = wbOauthHeaders(cred, token);
    headers['x-user-id'] = cred.uid; // 领取域必带（与签到读端点同闸）
    const res = await fetch(buildWbPathUrl(provider.base_url, path), {
      method: init.method ?? 'POST',
      headers,
      ...((init.method ?? 'POST') === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      /* 非 2xx 也读响应体：上游在 body 里给真实原因（实测 claim 未完成 → HTTP 400 +
         {"code":400,"msg":"task not completed"}）—— 只报状态码会丢上游错误语义。 */
      let upstream = '';
      try {
        const errBody = (await res.json()) as { msg?: unknown; code?: unknown };
        upstream = errBody && typeof errBody.msg === 'string' ? `：${errBody.msg}` : '';
      } catch {
        /* 响应体非 JSON：仅状态码 */
      }
      throw new Error(`领取域 ${path} HTTP ${res.status}${upstream}`);
    }
    const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: Record<string, unknown> };
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(String(body.msg ?? `业务码 ${body.code}`));
    }
    return body.data ?? {};
  }

  /** 签到领取（幂等：上游 today_checked_in 已签则不再打 claim）。 */
  async claimSignin(provider: ProviderRow, force = false): Promise<GrowthRunReport['signin']> {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!force && provider.wb_signin_checked_on === today) {
      return { outcome: 'already', points: provider.wb_signin_last_points, streak: provider.wb_signin_streak, message: '今天已经签过了。' };
    }
    const status = await this.call(provider, WB_SIGNIN_STATUS_PATH);
    if (status.active === false) {
      return { outcome: 'unavailable', points: null, streak: num(status.streak_days), message: '签到活动未进行中。' };
    }
    if (status.today_checked_in === true) {
      this.providers.setWbSignin(provider.id, today, num(status.streak_days), num(status.today_credit));
      return { outcome: 'already', points: num(status.today_credit), streak: num(status.streak_days), message: '今天已经签过了（上游已确认）。' };
    }
    const claim = await this.call(provider, WB_SIGNIN_CLAIM_PATH);
    const points = num(claim.credit) ?? num(claim.daily_credit) ?? num(claim.today_credit);
    const streak = num(claim.streak_days) ?? num(status.streak_days);
    this.providers.setWbSignin(provider.id, today, streak, points);
    return { outcome: 'claimed', points, streak, message: `签到成功 +${points ?? '?'} 积分。` };
  }

  /** 任务面板（GET tasks 透传，只读）：每个任务的完成态/进度/奖励 —— UI 展示用。 */
  async panelTasks(provider: ProviderRow): Promise<Array<Record<string, unknown>>> {
    const data = await this.call(provider, WB_GROWTH_TASKS_PATH, { method: 'GET' });
    const tasks = Array.isArray(data.tasks) ? (data.tasks as Array<Record<string, unknown>>) : [];
    return tasks.map((t) => ({
      code: t.task_code,
      title: t.title,
      desc: t.task_desc ?? t.description,
      /** claimed=已领 | in_progress=进行中 | accepted=已接单未完成（探针实测三态）。 */
      status: t.accept_status,
      progress: t.progress ?? null,
      rewardCredit: t.reward_credit ?? null,
      rewardEnergy: t.reward_energy ?? null,
      locked: t.locked === true,
    }));
  }

  /** 任务轮：查列表 → 接可接的 → 逐个领奖；被拒如实记 skipped。 */
  async runTasks(provider: ProviderRow): Promise<GrowthTaskOutcome[]> {
    const data = await this.call(provider, WB_GROWTH_TASKS_PATH, { method: 'GET' });
    const tasks = Array.isArray(data.tasks) ? (data.tasks as Array<Record<string, unknown>>) : [];
    const results: GrowthTaskOutcome[] = [];
    const acceptable = tasks.filter((t) => typeof t.task_code === 'string' && t.locked !== true);
    const titles = new Map<string, string>();
    for (const t of acceptable) titles.set(String(t.task_code), typeof t.title === 'string' ? t.title : '');

    /* 接单（复数数组一次打包；部分失败不影响其余） */
    let accepted = new Set<string>();
    if (acceptable.length > 0) {
      try {
        await this.call(provider, WB_GROWTH_TASKS_ACCEPT_PATH, { body: { task_codes: acceptable.map((t) => t.task_code) } });
        accepted = new Set(acceptable.map((t) => String(t.task_code)));
      } catch (err) {
        /* accept 整体失败：仍逐个尝试 claim（有些任务可能此前已接过） */
        this.logger.warn(`任务 accept 失败（继续尝试逐个 claim）：${(err as Error).message}`);
      }
    }

    for (const t of acceptable) {
      const code = String(t.task_code);
      try {
        const r = await this.call(provider, WB_GROWTH_TASKS_PATH + '/' + encodeURIComponent(code) + '/claim');
        /* 探针实测：已领任务再 claim → 200 + {already_claimed:true, credit:0, energy:0}
           —— 不是本轮真领到，单独归类；奖励形态 credit/energy 两种。 */
        if (r.already_claimed === true) {
          results.push({ code, title: titles.get(code) || null, outcome: 'already', reason: '此前已领过' });
          continue;
        }
        const credit = num(r.credit) ?? num(r.credit_granted);
        const energy = num(r.energy);
        const rewards = [
          credit !== null && credit > 0 ? `+${credit} 积分` : null,
          energy !== null && energy > 0 ? `+${energy} 能量` : null,
        ].filter(Boolean).join(' ');
        results.push({ code, title: titles.get(code) || null, outcome: 'claimed', reason: rewards || '已领取（无积分/能量奖励）' });
      } catch (err) {
        const msg = (err as Error).message;
        /* 探针实测：任务未完成 → HTTP 400 + msg "task not completed" —— 归 skipped
           （等真实使用后可领），不是系统错误。 */
        const notDone = /not completed|prerequisite|未完成|未达到/i.test(msg);
        results.push({
          code,
          title: titles.get(code) || null,
          outcome: notDone ? 'skipped' : 'error',
          reason: notDone ? '任务未完成（需在官方端真实使用后才能领）' : msg,
        });
      }
    }
    for (const code of accepted) {
      if (!results.some((r) => r.code === code)) {
        results.push({ code, title: titles.get(code) || null, outcome: 'accepted', reason: '已接单（领奖待任务完成）' });
      }
    }
    return results;
  }

  /** 连登兑换：对 available 档发 redeem（claimed/locked 档跳过）。 */
  async redeemStreak(provider: ProviderRow): Promise<RedeemOutcome[]> {
    const data = await this.call(provider, WB_GROWTH_STREAK_PATH, { method: 'GET' });
    const status = (data.redemption_status ?? {}) as Record<string, unknown>;
    const out: RedeemOutcome[] = [];
    const tiers: Array<[string, unknown]> = [
      ['7d', status.tier_7d_status],
      ['14d', status.tier_14d_status],
      ['28d', status.tier_28d_status],
    ];
    for (const [tier, st] of tiers) {
      if (st !== 'available') {
        out.push({ tier, ok: false, detail: String(st ?? 'unknown') });
        continue;
      }
      try {
        await this.call(provider, WB_GROWTH_REDEEM_PATH, { body: { tier, client_token: randomUUID() } });
        out.push({ tier, ok: true, detail: '已兑换' });
      } catch (err) {
        out.push({ tier, ok: false, detail: (err as Error).message });
      }
    }
    return out;
  }

  /** 整轮（签到 → 任务 → 兑换），供每日调度与手动按钮共用。单段失败不影响其余。 */
  async runAll(provider: ProviderRow): Promise<GrowthRunReport> {
    let signin: GrowthRunReport['signin'] = { outcome: 'error', points: null, streak: null, message: '' };
    try {
      signin = await this.claimSignin(provider);
    } catch (err) {
      signin = { ...signin, message: (err as Error).message };
    }
    let tasks: GrowthTaskOutcome[] = [];
    try {
      tasks = await this.runTasks(provider);
    } catch (err) {
      this.logger.warn(`任务轮失败：${(err as Error).message}`);
    }
    let redeems: RedeemOutcome[] = [];
    try {
      redeems = await this.redeemStreak(provider);
    } catch (err) {
      this.logger.warn(`连登兑换失败：${(err as Error).message}`);
    }
    let credits = signin.points ?? 0;
    for (const t of tasks) if (t.outcome === 'claimed' && t.reason?.startsWith('+')) credits += Number(/([d.]+)/.exec(t.reason)?.[1] ?? 0) || 0;
    return { signin, tasks, redeems, creditsGained: credits };
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
