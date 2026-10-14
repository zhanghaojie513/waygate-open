import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { extractBearer } from '../proxy/headers';
import { RelayConfigService } from '../config/config.service';
import { ClientKeysRepository, parseClients, parseIpWhitelist, type ClientKeyRow } from '../store/repositories/client-keys.repo';
import type { KeyScope } from '../store/repositories/client-keys.repo';
import { clientIpOf, describeUa } from '../common/client-ip';
import { ipAllowed } from '../common/ip-policy';
import { hashKey, looksLikeRelayKey, validateKey } from './keys';

/**
 * [v0.4.36] 标注「本路由跳过密钥策略（白名单/最大 IP 数/Token 配额）」。
 *
 * 唯一消费者是 `GET /v1/usage`：配额用尽的下游恰恰**最需要**查余量 —— 如果
 * 查询端点也被策略拦掉，「还剩多少」这个信息就死在了最需要它的时刻。
 * 密钥有效性/停用/过期仍然照常校验 —— 跳的只是配额层，不是鉴权层。
 */
export const SKIP_KEY_POLICY_KEY = 'relay:skipKeyPolicy';
export const SkipKeyPolicy = (): MethodDecorator => SetMetadata(SKIP_KEY_POLICY_KEY, true);

/** 通过鉴权后挂到 request 上的上下文，供代理层与日志写入使用。 */
export interface KeyContext {
  keyId: string;
  keyHint: string;
  client: string | null;
  scope: KeyScope;
  /** [v0.5.1] 绑定的提供商优先级链（名称，第 1 位最高）—— 多生效路由的取舍依据。 */
  clients: string[];
}

/** 承载 keyContext 的最小请求形状（Fastify request 兼容）。 */
export interface RequestWithKeyContext {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  keyContext?: KeyContext;
}

@Injectable()
export class ClientKeyGuard implements CanActivate {
  private readonly logger = new Logger(ClientKeyGuard.name);

  /*
   * ⚠️ 必须显式 `@Inject`，不能只靠 `design:paramtypes` 隐式注入。
   *
   * 隐式注入依赖 `emitDecoratorMetadata` 产的元数据：**tsc 构建（生产）有**，
   * 而 **esbuild / vitest 运行时不产**。于是同一个守卫在两边行为不同 ——
   * 生产正常，测试里 `this.keys` 却是 `undefined`，一调 `this.keys.findByHash(...)`
   * 就抛 TypeError，被错误过滤器映射成 **500**（而不是 401），看起来像"鉴权坏了"。
   * 这个坑由 `/v1/messages` 的装配 spec 暴露（2026-10-06）：`AnthropicKeyGuard`
   * 本身写了显式 `@Inject`，但它委托的这个 `ClientKeyGuard` 没写。
   *
   * 显式 token 与隐式推断的 token **完全相同**，所以这是行为等价的加固，不是语义变更。
   */
  constructor(
    @Inject(RelayConfigService) private readonly config: RelayConfigService,
    @Inject(ClientKeysRepository) private readonly keys: ClientKeysRepository,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithKeyContext>();
    const plain = extractBearer(req.headers['authorization']);

    if (!plain || !looksLikeRelayKey(plain)) {
      // 缺头 / 格式错 / 前缀不对 —— 不查库，直接拒绝
      this.auditReject('malformed_or_missing', null, req);
      throw this.reject('malformed_or_missing');
    }

    const row = this.keys.findByHash(hashKey(this.config.secret, plain));
    const result = validateKey(this.config.secret, plain, row);

    if (!result.ok) {
      // reason 只进日志，绝不进响应体（api-contract §1.2）
      this.auditReject(result.reason, row?.key_hint ?? null, req);
      throw this.reject(result.reason);
    }

    // ★ [v0.4.35] 密钥有效 ≠ 放行：还要过访问策略（IP 白名单 / 最大 IP 数 / Token 配额）。
    //   三项都不配置时零查询直通 —— 与旧版本行为完全一致。
    //   [v0.4.36] @SkipKeyPolicy() 的路由（如 /v1/usage）跳过配额层 —— 鉴权层照常。
    if (!this.shouldSkipPolicy(context)) {
      this.enforcePolicy(row!, this.clientIp(req));
    }

    // ★ 校验通过：更新 last_seen，并把上下文挂到 request 上
    this.keys.touch(row!.id, this.clientIp(req));
    req.keyContext = {
      keyId: row!.id,
      keyHint: row!.key_hint,
      client: row!.client,
      scope: result.scope,
      clients: parseClients(row!.clients),
    };
    return true;
  }

  /**
   * 路由是否标注了 @SkipKeyPolicy()。
   *
   * 不用 @nestjs/core 的 Reflector：它在 vitest 的 ESM 环境下 new/调用即抛
   * （实测），而它读元数据用的本来就是全局 `Reflect.getMetadata`（reflect-metadata
   * 补丁）—— 直接读全局，少一层在测试环境不稳定的依赖。生产同源：main.ts 引导时
   * 已 import 'reflect-metadata'。
   * 桩 context（旧测试）没有 getHandler/getClass —— 取不到元数据按**不跳过**处理，
   * 保守方向失效（宁可多拦一次策略，不放过一次该拦的）。
   */
  private shouldSkipPolicy(context: ExecutionContext): boolean {
    const get = (Reflect as { getMetadata?: (key: unknown, target: unknown) => unknown })
      .getMetadata;
    if (typeof get !== 'function') return false;
    try {
      const handler = typeof context.getHandler === 'function' ? context.getHandler() : undefined;
      const cls = typeof context.getClass === 'function' ? context.getClass() : undefined;
      const onHandler = handler === undefined ? undefined : get.call(Reflect, SKIP_KEY_POLICY_KEY, handler);
      const onClass = cls === undefined ? undefined : get.call(Reflect, SKIP_KEY_POLICY_KEY, cls);
      return (onHandler ?? onClass) === true;
    } catch {
      return false;
    }
  }

  /**
   * [v0.4.35] 密钥级访问策略（参考社区 workbuddy-manager 的「IP 管控 + 多密钥分发」）。
   *
   * 判定顺序（便宜的先走，全不配置时零查询）：
   *   1. IP 白名单非空且来源不命中 → 403 `ip_not_allowed`
   *      （来源取不到也拒绝 —— fail closed，见 ip-policy.ts `ipAllowed` 的论证）
   *   2. 最大 IP 数：来源是**新 IP** 且这把密钥历史上已用满名额 → 403 `max_ips_exceeded`
   *      老 IP 不受影响 —— 上限挡的是「密钥被转传播后的新增来源」，不是已有来源。
   *   3. Token 配额：累计 tokens 已达上限 → 429 `token_quota_exceeded`
   *      软校验：在请求**进入前**查累计，所以最后一笔可以超出（事后计数会包含它）。
   *
   * 与密钥无效的处置不同：这里是「密钥对、但策略拒绝」，返回 403/429 而不是笼统 401 ——
   * 下游工具需要能区分「密钥坏了去换」和「配额到了去充值/换密钥」。
   * 拒绝同样只写审计日志不落 requests 表（口径与 auditReject 一致，理由见其注释）。
   */
  private enforcePolicy(row: ClientKeyRow, ip: string | null): void {
    const whitelist = parseIpWhitelist(row.ip_whitelist);
    if (whitelist.length > 0) {
      if (!ipAllowed(ip, whitelist)) {
        this.logger.warn(
          `策略拒绝：ip_whitelist hint=${row.key_hint} ip=${ip ?? 'unknown'} ua=…`,
        );
        throw new ForbiddenException({
          error: {
            message: `This API key is not allowed from this IP address（IP 白名单拦截，IP：${ip ?? '未知'}）。`,
            type: 'invalid_request_error',
            code: 'ip_not_allowed',
            param: null,
          },
        });
      }
    }
    if (
      row.max_ips !== null &&
      ip !== null && ip !== '' && ip !== 'unknown' &&
      !this.keys.ipSeenForKey(row.id, ip)
    ) {
      const distinctIps = this.keys.distinctIpsForKey(row.id);
      if (distinctIps >= row.max_ips) {
        this.logger.warn(
          `策略拒绝：max_ips hint=${row.key_hint} ip=${ip} distinct=${distinctIps} max=${row.max_ips}`,
        );
        throw new ForbiddenException({
          error: {
            message: `This API key has reached its limit of ${row.max_ips} distinct IP addresses（已达最大 IP 数 ${row.max_ips}，当前 ${distinctIps}）。`,
            type: 'invalid_request_error',
            code: 'max_ips_exceeded',
            param: null,
          },
        });
      }
    }
    if (row.token_quota !== null) {
      const tokensUsed = this.keys.tokensUsedForKey(row.id);
      if (tokensUsed >= row.token_quota) {
        this.logger.warn(
          `策略拒绝：token_quota hint=${row.key_hint} used=${tokensUsed} quota=${row.token_quota}`,
        );
        throw new HttpException(
          {
            error: {
              message: `This API key has exhausted its token quota（Token 配额已用尽：${tokensUsed} / ${row.token_quota}）。`,
              type: 'invalid_request_error',
              code: 'token_quota_exceeded',
              param: null,
            },
          },
          429,
        );
      }
    }
  }

  /**
   * 密钥被拒绝时的**审计留痕**。
   *
   * ── 为什么只写日志、不落 `requests` 表（2026-10-08 的取舍） ──────────────
   *
   * 直觉上「有人在拿停用/过期的密钥打我的服务」应该出现在控制台里。但把拒绝落进
   * `requests` 表会**污染统计口径**：`overview.service.ts` 的每一处聚合都是
   * `FROM requests WHERE ts >= ? AND ts < ?`，`successRate = (总数 - status>=400) / 总数` ——
   * 掺进 401 行会让「请求成功率」凭空下跌、「请求数」虚高，而这两处**没有任何字段能把它们认出来**
   * （`client_id` 只能是 'unidentified'，因为根本没解析出密钥）。
   * 用一个更响的假信号换一个更弱的真信号，不划算。
   *
   * ⇒ 与「控制台登录失败」采取**同一种处置**（`auth.controller.ts` 的
   *   `登录失败（口令不正确）ip=… ua="…"`）：写进 stdout，由 journald 收集，
   *   需要时 `journalctl -u relay | grep 客户端密钥被拒绝` 就能看到来源 IP 与 UA。
   *   两条入站入口（控制台口令 / 客户端密钥）的失败留痕方式因此是一致的。
   *
   * ⚠️ 与成功路径的分工：`last_seen_at` / `last_seen_ip`（`keys.touch`）只在**成功**时更新，
   *    所以「密钥很久没被用过」这个信息不会被失败尝试刷新掉。
   */
  private auditReject(reason: string, keyHint: string | null, req: RequestWithKeyContext): void {
    this.logger.warn(
      `客户端密钥被拒绝：reason=${reason} hint=${keyHint ?? 'n/a'} ip=${this.clientIp(req) ?? 'unknown'}` +
        ` ua="${describeUa(req.headers)}"`,
    );
  }

  /** 对外统一 401，只带笼统文案，不区分 unknown/disabled/expired。 */
  private reject(_reason: string): UnauthorizedException {
    return new UnauthorizedException({
      error: {
        message: 'Invalid API key provided. 请检查密钥是否有效、是否被停用或已过期。',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        param: null,
      },
    });
  }

  /**
   * 客户端 IP。
   *
   * ⚠️ [2026-10-08 修] 这里曾经**自己取 XFF 的「首段」**（`split(',')[0]`）——
   * 那是本项目**明确论证过是错的**取法：Nginx 若用追加语义（`$proxy_add_x_forwarded_for`），
   * 首段就是**攻击者自己填的**值（见 `common/client-ip.ts` 文件头那一段踩坑记录：
   * 审计 IP 不可信 + 限流按 IP 分桶形同虚设）。同一仓库里两个模块对同一个头取了**不同的段**，
   * 而"哪个对"早有定论。
   *
   * 现在直接复用 `clientIpOf`（取**末段** = 紧邻的 Nginx 自己写入的那一段）——
   * 与鉴权审计、日志留痕同源，不再各写一份。
   *
   * 影响面：`last_seen_ip` 只落库、当前没有任何界面读它，所以这个 bug 一直是**潜伏**的
   * （没有可见的错误结果）—— 而这正是它值得顺手修掉的原因：等哪天有人拿它做审计或限流，
   * 才会以"IP 不对"的形式暴露，那时没人会想到是这里。
   */
  private clientIp(req: RequestWithKeyContext): string | null {
    const ip = clientIpOf(req);
    // `clientIpOf` 用 'unknown' 表示取不到；DB 列的语义是 NULL = 未知（schema.sql）。
    return ip === 'unknown' ? null : ip;
  }
}
