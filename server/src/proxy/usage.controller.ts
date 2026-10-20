/**
 * `GET /v1/usage` —— 密钥自查端点（v0.4.36，参考社区 workbuddy-manager 的同名能力）。
 *
 * 给**下游**用的：拿这把密钥查「我还能用吗、还剩多少」——
 *   · 不产生上游调用、不计费、不落 requests 表（纯读）；
 *   · 鉴权照常（密钥无效/停用/过期 401），但**跳过配额策略**（@SkipKeyPolicy）——
 *     配额用尽的下游恰恰最需要查余量，查询端点被自己拦掉是荒诞的。
 *
 * 为什么是独立控制器而不是塞进 ProxyController：那个类是「协议适配 + 手写原始
 * 响应」的转发面，三个 spec 手动 new 它构造 —— 本端点是纯只读 JSON，放一起
 * 会让两件不相干的事共享构造签名。独立成类，装配与测试都干净。
 */

import { Controller, Get, Inject, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClientKeyGuard, SkipKeyPolicy, type RequestWithKeyContext } from '../auth/key.guard';
import {
  ClientKeysRepository,
  parseIpWhitelist,
  parseScope,
} from '../store/repositories/client-keys.repo';

@Controller('v1')
@UseGuards(ClientKeyGuard)
export class KeyUsageController {
  constructor(
    @Inject(ClientKeysRepository) private readonly keys: ClientKeysRepository,
  ) {}

  @Get('usage')
  @SkipKeyPolicy()
  usage(@Req() req: RequestWithKeyContext): Record<string, unknown> {
    const ctx = req.keyContext!;
    const row = this.keys.findById(ctx.keyId);
    /* 守卫刚验过这把密钥，这里理论上不会 miss —— 但「守卫通过到控制器执行」之间
       密钥可能被并发删除。对下游来说等价于「密钥没了」。
       [2026-10-18 修] 此前直接 `return { object:'error', ... }` —— HTTP 状态仍是 **200**，
       注释写着「如实回 401」却没做到，客户端拿到 200 + error body 会当成成功。
       改为抛 RelayHttpError，由全局过滤器回 401（与其它鉴权失败路径一致）。 */
    if (!row) {
      /* 与 KeyGuard.reject() 同一形态（OpenAI 形状的 401），下游拿到的错误体一致。 */
      throw new UnauthorizedException({
        error: {
          message: 'Invalid API key provided. 请检查密钥是否有效、是否被停用或已过期。',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: null,
        },
      });
    }
    const usage = this.keys.usageForKey(ctx.keyId);
    const remain = (quota: number | null, used: number): number | null =>
      quota === null ? null : Math.max(0, quota - used);
    return {
      object: 'relay_key_usage',
      key_hint: row.key_hint,
      name: row.name,
      enabled: row.enabled === 1,
      expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      scope: parseScope(row.scope),
      usage: {
        requests_total: usage.requestsTotal,
        /* quota / remaining 为 null = 不限制 —— 与密钥列表的展示口径一致，
           下游不要把 null 当成 0。 */
        tokens: {
          used: usage.tokensUsed,
          quota: row.token_quota,
          remaining: remain(row.token_quota, usage.tokensUsed),
        },
        ips: {
          used: usage.distinctIps,
          quota: row.max_ips,
          remaining: remain(row.max_ips, usage.distinctIps),
        },
        ip_whitelist_count: parseIpWhitelist(row.ip_whitelist).length,
      },
    };
  }
}
