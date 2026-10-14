/**
 * MiniMax Code 每日签到（v0.5.6）。
 *
 * ## 为什么由 relay 代签
 * MiniMax Code 的积分靠每日签到攒（400/天起，第 4/7 天 1000）。此前必须登客户端手动点，
 * 而**登录会轮换 refresh token、把 relay 顶下线** —— 签到与反代互斥。签到 API 已从
 * 客户端资源包逆向确认，Bearer 就是 relay 已在维护的 access token，于是代签成立：
 * 客户端不再需要登录，凭证不再被轮换，积分照攒。
 *
 * ## 端点（逆向自客户端 app.asar，实测可用）
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai
 *   POST /minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai   body {}
 * 响应包 `base_resp.status_code`（非 0 即失败），数据在 `data`：
 *   status.days[]: { day_no, points, status(1 未到/2 可签/3 已签), is_today }
 *   claim: { claim_result:1, day_no, points, expire_at_ms, panel }
 *
 * ## 时区语义
 * `timezone_id` 决定「今天」的边界 —— 用 **Asia/Shanghai**（用户本地日历日），
 * 与客户端一致；缺参数上游报 1406010011 invalid timezone_id。
 *
 * ## 幂等
 * `signin_checked_on` 记最近成功签到的**本地日期**：同一天不再 claim（上游会拒，
 * 白打一次）。跨天判断用 Asia/Shanghai 的日历日，不是 UTC。
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProvidersRepository, type ProviderRow } from '../../store/repositories/providers.repo';
import { MinimaxTokenService } from './minimax-token.service';

const SIGNIN_BASE = 'https://agent.minimax.cn/minimax-cloud/api/v1/signin';
/** 签到「今天」的时区边界（与客户端本地一致）。 */
const SIGNIN_TZ = 'Asia/Shanghai';
/** 每日检查时刻：本地 08:05（避开整点；晚于大多数用户的起床时间）。 */
const DAILY_CHECK_HOUR = 8;
const DAILY_CHECK_MINUTE = 5;
const REQUEST_TIMEOUT_MS = 20_000;

/** 面板里今天那一格。 */
interface SigninDay {
  day_no: number;
  points: number;
  /** 1 = 未到，2 = 可签，3 = 已签。 */
  status: number;
  is_today: boolean;
}

export interface SigninPanel {
  days: SigninDay[];
  /** 今天可签（面板里 is_today 且 status=2）。 */
  claimable: boolean;
  /** 连续天数 = 今天在周期里的 day_no。 */
  streak: number | null;
  /** 今日应得积分（可签时）。 */
  todayPoints: number | null;
}

export interface SigninResult {
  ok: boolean;
  /** 'claimed' | 'already' | 'unavailable' | 'error' */
  outcome: 'claimed' | 'already' | 'unavailable' | 'error';
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
export class MinimaxSigninService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MinimaxSigninService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 进行中标志：同一轮不并发（定时与手动可能撞上）。 */
  private running = false;

  constructor(
    @Inject(ProvidersRepository) private readonly providers: ProvidersRepository,
    @Inject(MinimaxTokenService) private readonly tokens: MinimaxTokenService,
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

  /** 每 30 分钟醒来一次，命中「本地 08:05 之后且今天还没签」才真打上游（幂等闸在 runDaily）。 */
  private scheduleDaily(): void {
    this.timer = setInterval(() => void this.runDaily(), 30 * 60 * 1000);
    this.timer.unref?.();
    void this.runDaily(); // 启动即查一次（覆盖「昨天没签、今天开机」的场景）
  }

  /** 到点则对每个 oauth 提供商签到（幂等：同一天只签一次）。 */
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

    const today = localDate();
    const targets = this.providers.listActive().filter((p) => p.cred_kind === 'oauth_minimax');
    if (targets.length === 0) return;

    this.running = true;
    try {
      for (const provider of targets) {
        if (provider.signin_checked_on === today) continue; // 今天已签，幂等跳过
        const result = await this.signin(provider);
        if (result.outcome === 'claimed') {
          this.logger.log(`每日签到成功：${provider.name} +${result.points} 积分（连续第 ${result.streak ?? '?'} 天）`);
        } else if (result.outcome === 'error') {
          this.logger.warn(`每日签到失败：${provider.name} —— ${result.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 查签到面板（不领取）。 */
  async panel(provider: ProviderRow): Promise<SigninPanel> {
    const data = await this.call(provider, 'status');
    const days = Array.isArray(data.days) ? (data.days as SigninDay[]) : [];
    const today = days.find((d) => d.is_today) ?? null;
    return {
      days,
      claimable: today?.status === 2,
      streak: today?.day_no ?? null,
      todayPoints: today?.status === 2 ? today.points : null,
    };
  }

  /**
   * 签到一次（含幂等）。`force` 为 false 时，今天已签过直接返回 'already'（不打上游）。
   * 手动按钮传 force=true 可强制复查一次面板（仍不会重复 claim —— 上游自己会拒）。
   */
  async signin(provider: ProviderRow, force = false): Promise<SigninResult> {
    const today = localDate();
    if (!force && provider.signin_checked_on === today) {
      return { ok: true, outcome: 'already', points: provider.signin_last_points, streak: provider.signin_streak, message: '今天已经签过了。' };
    }

    let panel: SigninPanel;
    try {
      panel = await this.panel(provider);
    } catch (err) {
      return { ok: false, outcome: 'error', points: null, streak: null, message: (err as Error).message };
    }

    if (!panel.claimable) {
      /* 今天不可签（已签 / 活动未开）—— 记下日期，避免本轮反复打上游。 */
      if (panel.streak !== null) this.providers.setSignin(provider.id, today, panel.streak, provider.signin_last_points);
      return {
        ok: true,
        outcome: 'unavailable',
        points: null,
        streak: panel.streak,
        message: '今日不可签到（可能已签或活动未开始）。',
      };
    }

    try {
      const data = await this.call(provider, 'claim');
      const points = typeof data.points === 'number' ? data.points : null;
      const streak = typeof data.day_no === 'number' ? data.day_no : panel.streak;
      this.providers.setSignin(provider.id, today, streak, points);
      return { ok: true, outcome: 'claimed', points, streak, message: `签到成功 +${points ?? '?'} 积分。` };
    } catch (err) {
      return { ok: false, outcome: 'error', points: null, streak: panel.streak, message: (err as Error).message };
    }
  }

  /** 打一次签到接口，返回 data 段；base_resp.status_code 非 0 抛错（带上游 msg）。 */
  private async call(provider: ProviderRow, action: 'status' | 'claim'): Promise<Record<string, unknown>> {
    const token = await this.tokens.accessToken(provider);
    const url = `${SIGNIN_BASE}/${action}?timezone_id=${encodeURIComponent(SIGNIN_TZ)}`;
    const res = await fetch(url, {
      method: action === 'claim' ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(action === 'claim' ? { 'content-type': 'application/json' } : {}),
      },
      ...(action === 'claim' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`签到接口 HTTP ${res.status}`);
    const body = (await res.json()) as { base_resp?: { status_code?: number; status_msg?: string }; data?: Record<string, unknown> };
    const code = body.base_resp?.status_code;
    if (typeof code === 'number' && code !== 0) {
      throw new Error(body.base_resp?.status_msg ?? `上游业务码 ${code}`);
    }
    if (!body.data || typeof body.data !== 'object') throw new Error('签到响应缺少 data 段。');
    return body.data;
  }
}
