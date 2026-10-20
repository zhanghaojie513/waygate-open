/**
 * 控制台主控制器（api-contract §3.4 - §3.11）。
 *
 * 整类挂 `SessionGuard`（cookie 会话 + Origin 校验）。
 *
 * ⚠️ 响应形状：本控制器**不用** Nest 的默认序列化，而是显式返回
 * `ok(...)` 信封。原因：契约 §0.1 要求 `/api/*` 一律 `{code,data,message}`，
 * 而 Nest 默认会把对象原样序列化（没有 code/message 外壳）。
 * 抛错时的信封由 `ApiExceptionFilter` 统一转换（见 api.filter.ts）。
 *
 * ⚠️ **所有写方法必须显式 `@HttpCode(200)`**。Nest 对 `@Post` 默认回 201，
 *    对 `@Put`/`@Patch`/`@Delete` 默认回 200 —— 契约 §3 全篇只定义了 200，
 *    没有 201。不写就会让前端把 201 当成异常分支。
 *    （这是冒烟脚本实测抓出来的：5 个端点全返 201。）
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ok } from '../common/errors';
import { RelayHttpError, ApiCode } from '../common/errors';
import { SessionGuard } from './auth/session.guard';
import { OverviewService } from './overview.service';
import { ClientsService } from './clients.service';
import { RequestQueryService } from './requests.service';
import { KeysService } from './keys.service';
import { SettingsService } from './settings.service';
import { CredentialService } from './credential.service';
import { ModelsService } from './models.service';
import { AdminCredentialService } from './auth/admin-credential.service';
import { ProxyService } from '../proxy/proxy.service';
import { resolveWindow } from './window';
import { queryInt, queryString, type ApiRequest } from './api.types';

/** 概览缓存有效期：足以合并切页/多标签的重复请求，又短到人眼几乎感知不到滞后。 */
const OVERVIEW_TTL_MS = 5_000;

@Controller('api')
@UseGuards(SessionGuard)
export class ConsoleController {
  constructor(
    private readonly overview: OverviewService,
    private readonly clients: ClientsService,
    private readonly requests: RequestQueryService,
    private readonly keys: KeysService,
    private readonly settings: SettingsService,
    private readonly credential: CredentialService,
    private readonly models: ModelsService,
    private readonly admin: AdminCredentialService,
    private readonly proxy: ProxyService,
  ) {}

  @Get('overview')
  getOverview(@Query() query: Record<string, string>): unknown {
    const spec = resolveWindow(query?.window);
    // 并发占用/上限随概览一起暴露（task#37）：槽位泄漏会让 active 单调上涨→永久 429，
    // 那是从外面看不见的失败状态，必须可观测。只挂会话保护端点，不进公开的 /healthz。
    // concurrency 每次现取（不进缓存）：它是瞬时状态，必须实时。
    return ok({ ...this.cachedOverview(spec), concurrency: this.proxy.stats() });
  }

  /**
   * 概览短 TTL 缓存（按窗口键）。
   *
   * 为什么：build() 对同一时间窗要跑约 9 条 `requests` 范围聚合，better-sqlite3 是同步的，
   * 执行期间整个事件循环（含正在转发的 SSE 流）都被占住。概览页与用量页共用这条端点、
   * 来回切页 / 多标签页 / 开发期 StrictMode 双发都会在几秒内重复算同一份结果。
   * 取舍：数据最多滞后 OVERVIEW_TTL_MS；本控制器内的写操作（设置 / 危险操作 / 目录 / 凭证 / 密钥）
   * 会立即清缓存，避免「刚清空日志，概览还显示旧数」这类困惑。
   */
  private readonly overviewCache = new Map<string, { at: number; payload: ReturnType<OverviewService['build']> }>();

  private cachedOverview(spec: ReturnType<typeof resolveWindow>): ReturnType<OverviewService['build']> {
    const now = Date.now();
    const hit = this.overviewCache.get(spec.key);
    if (hit && now - hit.at < OVERVIEW_TTL_MS) return hit.payload;
    const payload = this.overview.build(spec, now);
    this.overviewCache.set(spec.key, { at: now, payload });
    return payload;
  }

  /** 写操作后清概览缓存（下一次读取重新聚合）。 */
  private invalidateOverview(): void {
    this.overviewCache.clear();
  }

  @Get('clients')
  getClients(@Query() query: Record<string, string>): unknown {
    const spec = resolveWindow(query?.window);
    return ok(this.clients.list(spec));
  }

  @Get('requests')
  getRequests(@Req() req: ApiRequest): unknown {
    const q = req.query;
    const status = queryString(q, 'status');
    const fromRaw = queryString(q, 'from');
    const toRaw = queryString(q, 'to');
    const orderRaw = queryString(q, 'order');

    return ok(
      this.requests.list({
        page: queryInt(q, 'page', 1),
        limit: queryInt(q, 'limit', 20),
        status: status && status.trim() !== '' ? status : 'all',
        clientId: blankToUndefined(queryString(q, 'clientId')),
        model: blankToUndefined(queryString(q, 'model')),
        q: blankToUndefined(queryString(q, 'q')),
        from: parseTimeParam(fromRaw),
        to: parseTimeParam(toRaw),
        sort: queryString(q, 'sort'),
        order: orderRaw === 'asc' ? 'asc' : 'desc',
        cursor: blankToUndefined(queryString(q, 'cursor')),
      }),
    );
  }

  @Get('requests/:id')
  getRequestDetail(@Param('id') id: string): unknown {
    return ok(this.requests.detail(parseId(id)));
  }

  @Get('keys')
  listKeys(): unknown {
    return ok(this.keys.list());
  }

  @Post('keys')
  @HttpCode(200)
  createKey(@Body() body: unknown): unknown {
    const created = this.keys.create((body ?? {}) as Record<string, unknown>);
    this.invalidateOverview();
    return ok(created);
  }

  @Patch('keys/:id')
  @HttpCode(200)
  patchKey(@Param('id') id: string, @Body() body: unknown): unknown {
    const patched = this.keys.patch(id, (body ?? {}) as Record<string, unknown>);
    this.invalidateOverview();
    return ok(patched);
  }

  @Delete('keys/:id')
  @HttpCode(200)
  deleteKey(@Param('id') id: string): unknown {
    const removed = this.keys.remove(id);
    this.invalidateOverview();
    return ok(removed);
  }

  @Get('settings')
  getSettings(): unknown {
    return ok(this.settings.get());
  }

  @Put('settings')
  @HttpCode(200)
  putSettings(@Body() body: unknown): unknown {
    const result = this.settings.put(body);
    this.invalidateOverview();
    return ok(result);
  }

  @Post('settings/danger')
  @HttpCode(200)
  danger(@Body() body: unknown): unknown {
    const result = this.settings.danger(body);
    this.invalidateOverview(); // 清空日志等危险操作后概览必须立即反映
    this.requests.invalidateCounts(); // 日志列表的总数缓存同理
    return ok(result);
  }

  /**
   * 写入上游凭证（api-contract §3.8.1）。
   *
   * 为什么不是 `PUT /api/settings` 的一部分：契约里 `credential.source`
   * 是 `readonly: true` 的**只读展示项** —— 那是刻意的安全边界，上游凭证
   * 是出站凭证，能读回它等于能把服务端凭证偷走。所以单独开这条**只写**端点。
   *
   * 请求体 `{"key":"ck_..."}`；响应只回掩码，绝不回显明文。
   */
  @Put('settings/credential')
  @HttpCode(200)
  putCredential(@Body() body: unknown): unknown {
    const key = (body as { key?: unknown } | null | undefined)?.key;
    const result = this.credential.update(key);
    this.invalidateOverview();
    return ok(result);
  }

  @Get('models/catalog')
  getCatalog(@Query('provider') provider?: string): unknown {
    return ok(this.models.get(provider));
  }

  @Post('models/catalog')
  @HttpCode(200)
  async refreshCatalog(): Promise<unknown> {
    const result = await this.models.refresh();
    this.invalidateOverview(); // 目录变化影响概览的「模型→提供商」归属
    return ok(result);
  }

  /**
   * 启用 / 停用目录里的一个模型。
   *
   * 只改 `enabled` 标志，**不删行** —— 订阅以后可能又开，`verified`
   * 与历史都要留着。这是用户对「拉回来的模型清单」做取舍的落点。
   */
  @Patch('models/catalog/:id')
  @HttpCode(200)
  setModelEnabled(@Param('id') id: string, @Body() body: unknown, @Query('provider') provider?: string): unknown {
    const enabled = (body as { enabled?: unknown } | null | undefined)?.enabled;
    const result = this.models.setEnabled(id, enabled, provider);
    this.invalidateOverview();
    return ok(result);
  }

  /**
   * [v1.7.0] 给自定义提供商手动补一个模型（source='manual'）。
   *
   * 只对 protocol='custom' 开放 —— 内置三家的清单以上游接口为准，手填等于把猜测
   * 混进权威数据；自定义端点则可能没有 /v1/models，手填是唯一途径。
   * manual 行不会被替换式同步冲掉（replaceSync 只清非 manual）。
   */
  @Post('models/catalog/:providerId/manual-model')
  @HttpCode(200)
  addManualModel(@Param('providerId') providerId: string, @Body() body: unknown): unknown {
    const result = this.models.addManualModel(providerId, body);
    this.invalidateOverview();
    return ok(result);
  }

  /**
   * 用一把**尚未保存**的凭证试通上游。
   *
   * ## 为什么必须有这条
   *
   * `PUT /api/settings/credential` 是只写端点：写进去就只剩掩码，读不回来。
   * 于是用户填错一个 key 后没有任何自查手段 —— 只能等真实请求失败。
   * 这条端点把「先验后存」补上。
   *
   * ## 为什么不用 POST /api/models/catalog 代替
   *
   * 那条会把目录里每个模型都实测一遍（打满 17 次请求、消耗积分、60 秒冷却）。
   * 试通一个凭证只需一次最小请求。用前者既慢又贵，还会白白吃掉冷却配额。
   *
   * ## 安全
   *
   * 请求体里的 key 只在本进程栈内存在，不落盘、不进日志、不回显；
   * 响应只含「通不通 + 上游业务码 + 耗时」。
   */
  @Post('settings/credential/test')
  @HttpCode(200)
  async testCredential(@Body() body: unknown): Promise<unknown> {
    const key = (body as { key?: unknown } | null | undefined)?.key;
    return ok(await this.models.testCredential(key));
  }

  /**
   * 重置管理口令（api-contract §3.1.3）。
   *
   * ## 为什么放在 ConsoleController（受 SessionGuard 保护）而不是 auth 下
   * 重置口令是**已登录用户**的自我服务操作，不是"忘记口令"的自救通道。
   * 挂在 `SessionGuard` 后面意味着：必须先有有效会话才能改密 ——
   * 这挡掉了「未登录者暴力猜测 + 猜中即改密锁死管理员」这条路径。
   * （忘记口令的自救方式是删除 admin_credential 行/`admin.hash` 后重启，
   *  需要服务器 shell 权限，见 DEPLOY-CHECKLIST。）
   *
   * ## 为什么不需要请求体
   * 新口令由服务端**随机生成**（16 字符，去掉了易混字符），不接受客户端传入。
   * 好处：① 强度有下限保证；② 不存在"客户端传了个弱口令"的失败模式；
   * ③ 无需校验入参，端点面更小。将来若要支持自定义口令，再扩一个字段即可。
   *
   * ## 响应里的明文
   * `data.password` 是**唯一一次**能看到新口令明文的地方，前端必须要求用户
   * 立即复制。服务端不落盘、不进日志（见 AdminCredentialService.reset 的注释）。
   *
   * 密码学上这里存在一个取舍：重置成功后**旧口令立即失效**，
   * 而新口令若用户没保存住，就只能走 shell 自救。这是"热生效"的必然代价，
   * 已在契约里写明。
   */
  @Post('auth/password/reset')
  @HttpCode(200)
  resetAdminPassword(): unknown {
    const { plain, persisted } = this.admin.reset();
    return ok({ password: plain, persisted });
  }

  /**
   * **自定义**管理口令（api-contract §3.1.4，用户需求「管理口令能手动输入吗」）。
   *
   * ## 与 `reset` 的分工
   *   - `POST /auth/password/reset`：服务端生成随机 16 位，**回显**明文一次。
   *   - `PUT /auth/password`（本条）：用户自己输入，**不回显** ——
   *     他自己就知道明文，回显只多开一条泄漏通道。
   *
   * ## 为什么是 PUT 而不是 POST
   * PUT 的语义是「把资源设定为某个值」，与 `@Put('settings/credential')` 一致；
   * 而 reset 是「触发一次生成」，属于有副作用的动作，用 POST。两者语义不同，故分开。
   *
   * ## 安全边界（与 reset 一致）
   *   - 挂在 `SessionGuard` 后：必须先有有效会话 —— 挡住「未登录者猜口令 + 猜中即锁死」。
   *   - 明文仅在请求体里存在，服务端吃进即弃（`AdminCredentialService.setPassword`）。
   *   - 校验（长度 / 纯空白）在 service 层，失败抛 400/40001。
   */
  @Put('auth/password')
  @HttpCode(200)
  setAdminPassword(@Body() body: unknown): unknown {
    const password = (body as { password?: unknown } | null | undefined)?.password;
    return ok(this.admin.setPassword(password));
  }
}

function parseId(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: `请求 id 必须是正整数，收到「${raw}」。`,
    });
  }
  return n;
}

function blankToUndefined(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === '' ? undefined : v;
}

/** `from`/`to` 接受 ISO 字符串或 epoch 毫秒；非法一律 400（不静默忽略，否则筛不出数据会以为没日志）。 */
function parseTimeParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: `时间参数不是合法的 ISO 时间或 epoch 毫秒：${raw}`,
    });
  }
  return ms;
}
