/**
 * `providers` 的 HTTP 端点（api-contract §3.12，2026-10-08）。
 *
 * 独立成控制器而不是塞进 `ConsoleController`：那边已 297 行，贴着 300 行门禁；
 * 且「提供商」是一组完整的 CRUD 语义（列表/新增/改/激活/删除），自成一体更好找。
 *
 * 鉴权与其它 `/api/*` 相同（SessionGuard，整类挂）。
 * 激活是 PUT —— 语义是「把生效提供商设定为这个」，与 `PUT /api/settings/credential` 同一约定。
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { SessionGuard } from './auth/session.guard';
import { ProvidersService } from './providers.service';
import { MinimaxSigninService } from '../proxy/anthropic-upstream/minimax-signin.service';
import { WbSigninService } from '../proxy/openai-upstream/wb-signin.service';
import { WbOauthService } from '../proxy/openai-upstream/wb-oauth.service';
import { WbClaimService } from '../proxy/openai-upstream/wb-claim.service';
import { QoderActivityService } from '../proxy/qoder-upstream/qoder-activity.service';
import { MinimaxTokenService } from '../proxy/anthropic-upstream/minimax-token.service';
import { DeviceImportService } from './device-import.service';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ok } from '../common/errors';

@Controller('api/providers')
@UseGuards(SessionGuard)
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly signinSvc: MinimaxSigninService,
    private readonly wbSigninSvc: WbSigninService,
    private readonly wbOauthSvc: WbOauthService,
    private readonly wbClaimSvc: WbClaimService,
    private readonly qoderActivitySvc: QoderActivityService,
    private readonly repo: ProvidersRepository,
    private readonly minimaxTokens: MinimaxTokenService,
    private readonly deviceImport: DeviceImportService,
  ) {}

  @Get()
  list(): unknown {
    return ok(this.providers.list());
  }

  @Post()
  @HttpCode(200) // Nest 默认 201；本仓所有写方法统一 200（见 console.controller.ts 头注）
  create(@Body() body: Record<string, unknown>): unknown {
    return ok(this.providers.create(body));
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    return ok(this.providers.patch(id, body));
  }

  /** 启用 = 该提供商参与出站路由（多生效；含其目录同步，异步）。 */
  @Put(':id/activate')
  @HttpCode(200)
  activate(@Param('id') id: string): unknown {
    return ok(this.providers.activate(id));
  }

  /** [v0.5.1] 停用 = 退出出站路由（最后一个生效的不可停）。 */
  /** [v0.5.6] 查某提供商的签到面板（不领取）。[v1.3.0] 按协议分流：oauth_minimax → MiniMax 面板；openai → WorkBuddy 面板。 */
  @Get(':id/signin')
  @HttpCode(200)
  async signinPanel(@Param('id') id: string): Promise<unknown> {
    /* [2026-10-18] 提供商不存在是**资源错误**，走统一 404 信封（与 mustFind 一致）。
       此前返回 200 + {available:false, reason:'provider_not_found'} —— 调用方无法
       用状态码判断成败，只能解析 reason 字符串。其余 `available:false`
       （未授权 / 暂无数据）是**业务结果**，仍保留 200 + 结构化 payload。 */
    const row = this.repo.findById(id) ?? this.providers.mustFindOrThrow(id);
    if (row.cred_kind === 'oauth_minimax') {
      try {
        const panel = await this.signinSvc.panel(row);
        return ok({
          available: true,
          claimable: panel.claimable,
          streak: panel.streak,
          todayPoints: panel.todayPoints,
          checkedOn: row.signin_checked_on,
          lastPoints: row.signin_last_points,
          days: panel.days,
        });
      } catch (err) {
        return ok({ available: false, reason: 'error', message: (err as Error).message });
      }
    }
    if (row.protocol === 'openai') {
      try {
        const panel = await this.wbSigninSvc.panel(row);
        return ok({
          available: true,
          protocol: 'openai',
          claimable: panel.active !== false && panel.todayCheckedIn === false,
          streak: panel.streak,
          todayCredit: panel.todayCredit,
          totalCredits: panel.totalCredits,
          activityName: panel.activityName,
          checkedOn: row.wb_signin_checked_on,
          lastPoints: row.wb_signin_last_points,
        });
      } catch (err) {
        return ok({ available: false, reason: 'error', message: (err as Error).message });
      }
    }
    if (row.protocol === 'qoder') {
      try {
        const panel = await this.qoderActivitySvc.panel(row);
        return ok({
          available: true,
          protocol: 'qoder',
          claimable: panel.claimable,
          streak: panel.consecutiveDays,
          campaigns: panel.campaigns,
          checkedOn: row.signin_checked_on,
          lastPoints: row.signin_last_points,
        });
      } catch (err) {
        return ok({ available: false, reason: 'error', message: (err as Error).message });
      }
    }
    return ok({ available: false, reason: 'signin_not_supported', message: '该协议无签到接口。' });
  }

  /** [v0.5.6] 立即签到（幂等：今天签过则原样返回）。[v1.3.0] 按协议分流。
   * [v1.4.0] openai 分支：有 OAuth 槽 → 真领取；否则状态同步（上游不允许 ck_ 代领）。 */
  @Post(':id/signin')
  @HttpCode(200)
  async signinNow(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, message: '提供商不存在。' });
    if (row.cred_kind === 'oauth_minimax') {
      return ok(await this.signinSvc.signin(row, true));
    }
    if (row.protocol === 'openai') {
      if (this.wbOauthSvc.configured(id)) {
        try {
          const signin = await this.wbClaimSvc.claimSignin(row, true);
          return ok({ ok: signin.outcome !== 'error', ...signin });
        } catch (err) {
          return ok({ ok: false, outcome: 'error', points: null, streak: null, message: (err as Error).message });
        }
      }
      return ok(await this.wbSigninSvc.signin(row, true));
    }
    if (row.protocol === 'qoder') {
      return ok(await this.qoderActivitySvc.checkin(row, true));
    }
    return ok({ ok: false, message: '该协议无签到接口。' });
  }

  /** [v1.6.0] Qoder 积分概况（累计/峰值/连续活跃）。 */
  @Get(':id/credits')
  @HttpCode(200)
  async credits(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id) ?? this.providers.mustFindOrThrow(id);
    if (row.protocol !== 'qoder') return ok({ available: false, reason: 'not_qoder', message: '积分概况目前仅 Qoder CN 提供。' });
    try {
      return ok({ available: true, ...(await this.qoderActivitySvc.credits(row)) });
    } catch (err) {
      return ok({ available: false, reason: 'error', message: (err as Error).message });
    }
  }

  /** [v1.4.0] 导入 WorkBuddy OAuth 凭证（领取域：签到代领/成长任务）。body = 导出工具的 JSON。 */
  @Post(':id/oauth-import')
  @HttpCode(200)
  oauthImport(@Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, message: '提供商不存在。' });
    if (row.protocol !== 'openai') return ok({ ok: false, message: '只有 WorkBuddy（openai 协议）有 OAuth 领取域。' });
    try {
      this.wbOauthSvc.importCredential(row, body as never);
      return ok({ ok: true, message: 'OAuth 凭证已导入（转发仍走 API 密钥，互不影响）。' });
    } catch (err) {
      return ok({ ok: false, message: (err as Error).message });
    }
  }

  /* [v1.6.15] `POST /api/providers/:id/import-local` 已移除（用户口径）。
     它读的是**relay 服务端所在机器**的客户端登录态 —— 线上 relay 跑在服务器上，
     客户端在你本机，服务端永远读不到，只会恒定回 `unavailable`。
     那个能力属于「relay 与客户端同机」的本地启动场景（开源版 waygate-open 保留）。
     relay-station（线上/自托管服务器形态）的凭证入口统一为「重新导入授权」
     （官方设备授权，见下方 import-device/*）。 */

  /**
   * [v1.6.12] 设备授权导入 ①：申请授权，返回浏览器要打开的地址。
   *
   * 三种客户端各有自己的授权机制（见 device-import.service 文件头表格）。
   * 私有状态（device_code / code_verifier / state）**只存服务端**，不回传浏览器。
   */
  @Post(':id/import-device/start')
  @HttpCode(200)
  async importDeviceStart(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, message: '提供商不存在。' });
    return ok(await this.deviceImport.start(id, row.protocol as 'openai' | 'anthropic' | 'qoder'));
  }

  /**
   * [v1.6.12] 设备授权导入 ②：轮询取票。
   * `status='pending'` = 用户还没完成授权（前端继续轮询）；`done` = 已落盘凭证。
   */
  @Post(':id/import-device/poll')
  @HttpCode(200)
  async importDevicePoll(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, status: 'error', message: '提供商不存在。' });
    const result = await this.deviceImport.poll(id, row.protocol as 'openai' | 'anthropic' | 'qoder');
    /* 导入成功后失效缓存的 access token（否则出站仍用旧令牌，看起来"没生效"）。 */
    if (result.status === 'done' && row.protocol === 'anthropic') this.minimaxTokens.invalidate(id);
    return ok(result);
  }

  /** [v1.6.12] 取消进行中的授权（前端关闭弹窗时调用）。 */
  @Post(':id/import-device/cancel')
  @HttpCode(200)
  importDeviceCancel(@Param('id') id: string): unknown {
    this.deviceImport.cancel(id);
    return ok({ ok: true });
  }

  /** [v1.4.0] 删除 WorkBuddy OAuth 槽（回到纯状态同步模式）。 */
  @Delete(':id/oauth')
  @HttpCode(200)
  oauthRemove(@Param('id') id: string): unknown {
    this.wbOauthSvc.removeCredential(id);
    return ok({ ok: true, message: 'OAuth 凭证已删除。' });
  }

  /** [v1.4.4] 任务面板（只读）：每个任务的完成态/进度/奖励。需已导入 OAuth。 */
  @Get(':id/growth')
  @HttpCode(200)
  async growthPanel(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, message: '提供商不存在。' });
    if (row.protocol !== 'openai') return ok({ ok: false, message: '只有 WorkBuddy 有成长任务。' });
    if (!this.wbOauthSvc.configured(id)) {
      return ok({ ok: false, tasks: [], message: '未导入 WorkBuddy OAuth 凭证（任务面板需要桌面端登录态）。' });
    }
    try {
      const tasks = await this.wbClaimSvc.panelTasks(row);
      return ok({ ok: true, tasks });
    } catch (err) {
      return ok({ ok: false, tasks: [], message: (err as Error).message });
    }
  }

  /** [v1.4.0] 手动跑一轮领取（签到领取 + 任务轮 + 连登兑换；需已导入 OAuth）。 */
  @Post(':id/growth/run')
  @HttpCode(200)
  async growthRun(@Param('id') id: string): Promise<unknown> {
    const row = this.repo.findById(id);
    if (!row) return ok({ ok: false, message: '提供商不存在。' });
    if (row.protocol !== 'openai') return ok({ ok: false, message: '只有 WorkBuddy 有成长任务。' });
    if (!this.wbOauthSvc.configured(id)) {
      return ok({ ok: false, message: '未导入 WorkBuddy OAuth 凭证（领取域需要桌面端登录态，API 密钥不可用）。' });
    }
    try {
      const report = await this.wbClaimSvc.runAll(row);
      return ok({ ok: true, ...report });
    } catch (err) {
      return ok({ ok: false, message: (err as Error).message });
    }
  }

  @Put(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id') id: string): unknown {
    return ok(this.providers.deactivate(id));
  }

  /**
   * 试通一个提供商（不切换就能测）。
   * body `{ credential?: string, model?: string }` —— 省略 credential 用已保存的那把。
   * 与 `POST /api/settings/credential/test` 的区别：那个打**当前生效**的上游，
   * 这个打**指定提供商**的地址 —— 「先验后切」的落点。
   */
  @Post(':id/test')
  @HttpCode(200)
  test(@Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    return ok(this.providers.test(id, body?.credential, body?.model));
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string): unknown {
    this.providers.remove(id);
    return ok({ deleted: id });
  }
}
