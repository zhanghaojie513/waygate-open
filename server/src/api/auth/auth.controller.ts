/**
 * 控制台鉴权端点（api-contract §3.1 - §3.3）。
 *
 * ⚠️ 本控制器**整体不加 SessionGuard**，因为它必须能在未登录时被调用。
 *    login   —— 未登录是常态
 *    session —— 契约明确要求未登录返回 `authenticated:false` 而**不是 401**
 *               （避免控制台首屏报一片红）
 *    logout  —— 带着过期 cookie 调用也必须成功（幂等）
 *
 * 但 logout 是 POST，仍受 CSRF 约束，因此单独调用 `assertOrigin`。
 *
 * ⚠️ 两个 POST 都显式 `@HttpCode(200)`：Nest 对 `@Post` 默认回 201，
 *    而契约 §3.1/§3.2 只定义 200。
 */

import { Body, Controller, Get, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ok, RelayHttpError, ApiCode } from '../../common/errors';
import { RelayConfigService } from '../../config/config.service';
import { AdminCredentialService, BUILTIN_DEFAULT_PASSWORD } from './admin-credential.service';
import {
  buildClearCookie,
  buildSessionCookie,
  issueSession,
  verifySession,
  SESSION_COOKIE,
} from './session';
import { assertOrigin } from './origin';
import { LoginRateLimiter } from './rate-limit';
import { readCookie } from './session.guard';
import { clientIpOf, describeUa as describeUaHeaders, socketPeerOf } from '../../common/client-ip';
import type { ApiRequest } from '../api.types';

interface LoginBody {
  password?: unknown;
}

@Controller('api/auth')
export class AuthController {
  private readonly limiter = new LoginRateLimiter();
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly config: RelayConfigService,
    private readonly admin: AdminCredentialService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: LoginBody,
  ): Promise<unknown> {
    // login 也受 CSRF 保护：否则第三方页面能拿受害者浏览器当"口令猜测器"
    assertOrigin({
      method: req.method,
      origin: headerOf(req, 'origin'),
      host: headerOf(req, 'host'),
    });

    if (!this.admin.isConfigured()) {
      throw new RelayHttpError({
        httpStatus: 500,
        code: 'admin_password_unconfigured',
        apiCode: ApiCode.INTERNAL,
        message:
          '管理口令未配置：RELAY_ADMIN_PASSWORD_HASH 格式非法或 data/admin.hash 校验失败。请修正后重启服务。',
      });
    }

    // ★ IP 取 XFF 首段（真实客户端），而非 req.ip。
    //   Fastify 设了 trustProxy:false，req.ip 恒为 Nginx 的 127.0.0.1，
    //   直接用它会让「按 IP 限流」把所有用户算成同一个桶。
    const ip = clientIpOf(req);
    // 入口先查锁定：已锁就 429，不给"试探是否解锁"的机会
    const pre = this.limiter.status(ip);
    if (pre.locked) {
      // 锁定期间的尝试也要留痕 —— 否则看不到"有人在持续撞"
      this.logger.warn(
        `登录被限流拒绝 ip=${ip} ua="${describeUa(req)}" 剩余锁定 ${pre.retryAfterSeconds}s`,
      );
      throw this.tooMany(pre.retryAfterSeconds);
    }

    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      // ★ 不记录收到的值（哪怕是空/类型），避免任何形式的凭证侧信道
      this.logger.warn(`登录请求缺少 password 字段 ip=${ip} ua="${describeUa(req)}"`);
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: '缺少 password 字段。',
      });
    }

    const passed = await this.admin.verify(password);
    if (!passed) {
      const after = this.limiter.recordFailure(ip);
      // ★ 只记"失败"这个事实与来源，绝不记口令内容、长度或任何派生值
      this.logger.warn(
        `登录失败（口令不正确）ip=${ip}${peerSuffix(req, ip)} ua="${describeUa(req)}" ` +
          `累计失败 ${after.failures ?? '?'} 次${after.locked ? `，已锁定 ${after.retryAfterSeconds}s` : ''}`,
      );
      if (after.locked) throw this.tooMany(after.retryAfterSeconds);
      throw new RelayHttpError({
        httpStatus: 401,
        code: 'bad_password',
        apiCode: ApiCode.BAD_PASSWORD,
        message: '管理口令不正确',
      });
    }

    this.limiter.recordSuccess(ip);
    this.logger.log(`登录成功 ip=${ip}${peerSuffix(req, ip)} ua="${describeUa(req)}"`);
    const { token, expiresAt } = issueSession(this.config.secret);
    reply.header('set-cookie', buildSessionCookie(token));
    return ok({ expiresAt: expiresAt.toISOString() });
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: ApiRequest, @Res({ passthrough: true }) reply: FastifyReply): unknown {
    assertOrigin({
      method: req.method,
      origin: headerOf(req, 'origin'),
      host: headerOf(req, 'host'),
    });
    reply.header('set-cookie', buildClearCookie());
    // 无状态令牌：服务端无需作废操作，恒成功
    return ok({});
  }

  @Get('session')
  session(@Req() req: ApiRequest): unknown {
    // ★ 未登录返回 authenticated:false，**不返回 401**（契约 §3.3 的硬要求）
    const token = readCookie(req.headers['cookie'], SESSION_COOKIE);
    const result = verifySession(this.config.secret, token);
    if (!result.ok) return ok({ authenticated: false, expiresAt: null });
    return ok({
      authenticated: true,
      expiresAt: new Date(result.payload.exp * 1000).toISOString(),
    });
  }

  /**
   * [v1.6.25] 登录页用：当前是否仍在用**内置默认口令**，以及在用的话它是什么。
   *
   * ## 为什么可以返回明文
   * `waygate` 是**公开值**（README / 启动日志 / 源码里都有），不是秘密。把它交给
   * 登录页只是省掉「去终端里找口令」这一步，不增加任何暴露面。
   *
   * ## 两条硬约束
   * 1. **只在「确实是内置默认值」时才返回明文**。用户改过密、用了
   *    `RELAY_ADMIN_PASSWORD_HASH`、自定口令或随机生成 —— 一律返回
   *    `{ defaultInUse: false }`，一个字符都不给。
   * 2. **只对回环请求开放**。若实例被 `--host 0.0.0.0` 暴露到公网，这个接口会把
   *    「默认口令是 waygate」告诉所有人。所以非回环一律返回 `defaultInUse:false`
   *    （不是报错 —— 登录页不需要知道原因，也不该因此报红）。
   *
   * 用 `socketPeerOf`（真实 TCP 对端，忽略 XFF）判定，避免伪造头绕过。
   */
  @Get('bootstrap-hint')
  bootstrapHint(@Req() req: ApiRequest): unknown {
    const peer = socketPeerOf(req as never);
    const isLoopback =
      peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (!isLoopback || !this.admin.isBuiltinDefaultInUse()) {
      return ok({ defaultInUse: false, password: null });
    }
    return ok({ defaultInUse: true, password: BUILTIN_DEFAULT_PASSWORD });
  }

  private tooMany(retryAfterSeconds: number): RelayHttpError {
    return new RelayHttpError({
      httpStatus: 429,
      code: 'login_rate_limited',
      apiCode: ApiCode.RATE_LIMITED,
      message: `登录失败次数过多，已临时锁定。请 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试。`,
      data: { retryAfterSeconds },
      headers: { 'retry-after': String(retryAfterSeconds) },
    });
  }
}

/**
 * 当"取到的 IP"与"实际 TCP 对端"不一致时，补一段 peer= 后缀。
 *
 * 为什么会不一致：`ip` 来自 XFF 头（客户端可伪造），`req.ip` 是 socket 对端。
 * 正常情况下对端是 Nginx 的 `127.0.0.1`，而 XFF 是真实客户端 → 必然不同，
 * 所以这里**只在两者不是"回环 vs 非回环"的常规组合**时附注，避免每条日志都刷。
 * 具体：对端是回环（走了 Nginx）就不附注；对端**不是**回环却带着 XFF，
 * 说明有人直连并伪造了头 —— 这才是值得记的。
 */
function peerSuffix(req: ApiRequest, resolvedIp: string): string {
  const peer = req.ip ?? 'unknown';
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (isLoopback) return '';
  if (peer === resolvedIp) return '';
  return ` peer=${peer}(XFF 与直连对端不一致)`;
}

function headerOf(req: ApiRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 把 User-Agent 压成可安全写日志的一行（截断 + 去控制字符）。
 *
 * [2026-10-08] 实现已提到 `common/client-ip.ts` 的 `describeUa` —— 客户端密钥的拒绝留痕
 * （`auth/key.guard.ts`）需要同一份规则，而"两处各写一份"正是这个仓库反复踩的坑
 * （同一个 XFF 头曾在两个模块里取了不同的段）。这里只保留一个薄包装，
 * 免得改 4 个调用点。
 */
function describeUa(req: ApiRequest): string {
  return describeUaHeaders(req.headers);
}
