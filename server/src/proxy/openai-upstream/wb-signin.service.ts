/**
 * WorkBuddy（openai 协议）签到状态同步（v1.3.0）。
 *
 * ## 能做什么 / 不能做什么（生产实测，2026-10-13）
 * WorkBuddy 的签到/成长任务分两个权限域，**ck_ API key 只在只读域**：
 *   · `checkin-activity-status`（查状态）：ck_ ✅ 200 —— 连签天数 / 今日是否已签 /
 *     活动累计积分都拿得到；
 *   · `daily-checkin`（真领取）：ck_ ❌ 403，上游原话
 *     `{"message":"API key not allowed for this path or method"}` —— 领取在
 *     **用户会话域**（桌面端 OAuth accessToken），API key 明确被排除；
 *   · growth 全族（任务/补登/抽奖）：同因，ck_ 恒 401。
 * ⇒ 本服务（ck_ 形态）能做的是**每日同步签到状态**（用户在官方客户端/网页领过后，
 *   面板与健康卡如实显示），不能代领。代领需要 OAuth 凭证（独立议题，见
 *   waygate-workbuddy-activities 记忆）。
 *
 * ## 端点（探针实测）
 *   POST <base>/v2/billing/meter/checkin-activity-status   body {}
 * 信封 `{code, msg, requestId, data}`；code 非 0 抛错。data（实测形状）：
 *   { active, today_checked_in, streak_days, daily_credit, today_credit,
 *     total_credits, checkin_dates[], activity_name, season, … }
 * ⚠️ 头族要点（两轮 403 实测）：完整桌面指纹 + **X-User-Id 必带**（值不校验，
 * 'relay-station' 占位可用——v3/config 同款先例）；额度端点则无此要求。
 *
 * ## 幂等
 * `wb_signin_checked_on` 记最近一次确认「今日已签」的本地日期：同一天不再查询。
 * 日期口径 Asia/Shanghai（与上游活动日历一致）。
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { RelayConfigService } from '../../config/config.service';
import { resolveDataDir } from '../../store/db';
import { buildWbSigninUrl } from '../upstream-url';
import { WbOauthService } from './wb-oauth.service';
import { WbClaimService } from './wb-claim.service';

/** 签到「今天」的时区边界（与上游活动日历一致；MiniMax 签到同款口径）。 */
const SIGNIN_TZ = 'Asia/Shanghai';
/** 每日检查时刻：本地 08:05（避开整点；与 MiniMax 签到一致）。 */
const DAILY_CHECK_HOUR = 8;
const DAILY_CHECK_MINUTE = 5;
const REQUEST_TIMEOUT_MS = 20_000;
/** 签到请求 UA（与额度拉取同款三段式，探针实测可用）。 */
const SIGNIN_UA = 'WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1';

export interface WbSigninPanel {
  /** 签到活动是否进行中。 */
  active: boolean | null;
  /** 今天是否已签（上游口径 —— 用户在官方客户端/网页领过即为 true）。 */
  todayCheckedIn: boolean | null;
  /** 连签天数。 */
  streak: number | null;
  /** 今日可领积分（未签时）。 */
  todayCredit: number | null;
  /** 活动期内累计已领。 */
  totalCredits: number | null;
  /** 活动名（如「Buddy加油站」，仅展示）。 */
  activityName: string | null;
}

export interface WbSigninResult {
  ok: boolean;
  /** 'synced'（确认今日已签）| 'pending'（今日未签，等用户在官方端领取）| 'unavailable' | 'error' */
  outcome: 'synced' | 'pending' | 'unavailable' | 'error';
  points: number | null;
  streak: number | null;
  message: string;
}

/** Asia/Shanghai 的本地日期（YYYY-MM-DD）—— 跨天幂等闸的键。 */
function localDate(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SIGNIN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d); // en-CA 输出 YYYY-MM-DD
}

@Injectable()
export class WbSigninService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WbSigninService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 进行中标志：同一轮不并发。 */
  private running = false;

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    @Inject(RelayConfigService) private readonly config: RelayConfigService,
    /* [v1.4.0] OAuth 领取域（可选注入：无 OAuth 槽时回落状态同步模式）。 */
    @Optional() @Inject(WbOauthService) private readonly oauth?: WbOauthService,
    @Optional() @Inject(WbClaimService) private readonly claim?: WbClaimService,
    /* 定时开关（测试里关掉，避免真起计时器）。 */
    @Optional() private readonly autoStart = true,
  ) {}

  onModuleInit(): void {
    if (this.autoStart === false) return;
    this.scheduleDaily();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 每 30 分钟醒来一次，命中「本地 08:05 之后且今天还没确认」才真打上游（幂等闸在 runDaily）。 */
  private scheduleDaily(): void {
    this.timer = setInterval(() => void this.runDaily(), 30 * 60 * 1000);
    this.timer.unref?.();
    void this.runDaily();
  }

  /**
   * 到点执行：有 OAuth 凭证 → **代领**（签到领取 + 任务轮 + 兑换，v1.4.0）；
   * 无 → 状态同步（只读，v1.3.0 语义，上游不允许 ck_ 代领）。
   */
  async runDaily(): Promise<void> {
    if (this.running) return;
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: SIGNIN_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    const [h, m] = local.split(':').map(Number);
    if (h < DAILY_CHECK_HOUR || (h === DAILY_CHECK_HOUR && m < DAILY_CHECK_MINUTE)) return; // 还没到点

    if (this.config.get().signin?.workBuddyEnabled === false) return; // 设置关掉了自动（实时读）

    const today = localDate();
    const targets = this.providers.listActive().filter((p) => p.protocol === 'openai');
    if (targets.length === 0) return;

    this.running = true;
    try {
      for (const provider of targets) {
        if (provider.wb_signin_checked_on === today) continue; // 今天已处理，幂等跳过
        if (this.claim && this.oauth?.configured(provider.id)) {
          /* OAuth 代领路径：签到领取 → 任务轮 → 连登兑换（单段失败不影响其余）。 */
          try {
            const report = await this.claim.runAll(provider);
            this.logger.log(
              `WorkBuddy 每日代领完成：${provider.name} 签到=${report.signin.outcome}（+${report.signin.points ?? 0}）` +
              ` 任务 claimed=${report.tasks.filter((t) => t.outcome === 'claimed').length}/${report.tasks.length}` +
              ` 兑换=${report.redeems.filter((r) => r.ok).length}/${report.redeems.length} —— 本轮积分 +${report.creditsGained}`,
            );
          } catch (err) {
            this.logger.warn(`WorkBuddy 每日代领失败：${provider.name} —— ${(err as Error).message}`);
          }
          continue;
        }
        const result = await this.signin(provider);
        if (result.outcome === 'synced') {
          this.logger.log(`WorkBuddy 签到状态已同步：${provider.name} 今日已签（连签 ${result.streak ?? '?'} 天）`);
        } else if (result.outcome === 'error') {
          this.logger.warn(`WorkBuddy 签到状态同步失败：${provider.name} —— ${result.message}`);
        }
        /* 'pending'（用户还没在官方端领）不打日志 —— 正常状态，静默等下一轮。 */
      }
    } finally {
      this.running = false;
    }
  }

  /** 查签到面板（只读）。 */
  async panel(provider: ProviderRow): Promise<WbSigninPanel> {
    const data = await this.call(provider);
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      active: typeof data.active === 'boolean' ? data.active : null,
      todayCheckedIn: typeof data.today_checked_in === 'boolean' ? data.today_checked_in : null,
      streak: num(data.streak_days),
      todayCredit: num(data.today_credit ?? data.daily_credit),
      totalCredits: num(data.total_credits),
      activityName: typeof data.activity_name === 'string' ? data.activity_name : null,
    };
  }

  /**
   * 同步一次签到状态（含幂等）。`force` 为 false 时，今天已确认直接返回 'synced'（不打上游）。
   * **不代领**：上游对 API key 关闭了 daily-checkin（403 原话见文件头）——
   * 今日未签时返回 'pending'，指引到官方客户端领取。
   */
  async signin(provider: ProviderRow, force = false): Promise<WbSigninResult> {
    const today = localDate();
    if (!force && provider.wb_signin_checked_on === today) {
      return { ok: true, outcome: 'synced', points: provider.wb_signin_last_points, streak: provider.wb_signin_streak, message: '今天已签到（上游已确认）。' };
    }

    let panel: WbSigninPanel;
    try {
      panel = await this.panel(provider);
    } catch (err) {
      return { ok: false, outcome: 'error', points: null, streak: null, message: (err as Error).message };
    }

    if (panel.active === false) {
      return { ok: true, outcome: 'unavailable', points: null, streak: panel.streak, message: '签到活动未进行中。' };
    }
    if (panel.todayCheckedIn === true) {
      /* 上游确认今天已签（用户在官方端领过）—— 落本地闸，今天不再查。 */
      this.providers.setWbSignin(provider.id, today, panel.streak, panel.todayCredit);
      return { ok: true, outcome: 'synced', points: panel.todayCredit, streak: panel.streak, message: '今天已签到（上游已确认）。' };
    }
    return {
      ok: true,
      outcome: 'pending',
      points: null,
      streak: panel.streak,
      message: `今日尚未签到：WorkBuddy 上游不允许 API 密钥代领（需官方客户端/网页的登录态），请在官方端领取（今日 ${panel.todayCredit ?? '?'} 积分）；本服务会自动同步签到状态。`,
    };
  }

  /** 打一次签到状态接口，返回 data 段；code 非 0 抛错（带上游 msg）。 */
  private async call(provider: ProviderRow): Promise<Record<string, unknown>> {
    const pkey = this.credential(provider);
    if (!pkey) throw new Error(`提供商 ${provider.name} 未配置凭证`);
    const res = await fetch(buildWbSigninUrl(provider.base_url), {
      method: 'POST',
      /* 头族 = 探针实测组合（完整桌面指纹 + X-User-Id；两轮 403 实测后定案，见文件头）。 */
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        authorization: `Bearer ${pkey}`,
        'user-agent': SIGNIN_UA,
        'x-user-id': 'relay-station',
        'x-agent-purpose': 'conversation',
        'x-agent-intent': 'craft',
        'x-ide-name': 'WorkBuddy',
        'x-ide-type': 'WorkBuddy',
        'x-ide-version': '5.8.0',
        'x-product': 'SaaS',
        'x-private-data': 'true',
        'x-codebuddy-request': '1',
        origin: 'https://www.codebuddy.cn',
        referer: 'https://www.codebuddy.cn/',
        'x-requested-with': 'XMLHttpRequest',
        'accept-language': 'zh-CN',
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`签到状态接口 HTTP ${res.status}`);
    const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: Record<string, unknown> };
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(String(body.msg ?? `上游业务码 ${body.code}`));
    }
    if (!body.data || typeof body.data !== 'object') throw new Error('签到响应缺少 data 段。');
    return body.data;
  }

  /** openai 提供商的 ck_ 凭证（文件优先，回落全局位 —— 与 quota-source/proxy 同规则）。 */
  private credential(provider: { id: string }): string {
    try {
      const key = readFileSync(join(resolveDataDir(), 'providers', `${provider.id}.key`), 'utf8').trim();
      if (key) return key;
    } catch {
      /* 回落全局位 */
    }
    return this.config.upstreamKey;
  }
}
