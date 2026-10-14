/**
 * 控制台会话 Guard（api-contract §1.4 / §1.5）。
 *
 * 职责（按顺序，任一失败即短路）：
 *   1. **CSRF**：`POST/PUT/PATCH/DELETE` 校验 `Origin` === `Host`，否则 403/40301
 *   2. **会话**：cookie `relay_sid` 验签 + 未过期 + sub==='admin'，否则 401/40102
 *
 * 顺序不能调换：先挡跨站（403）再谈身份（401）。
 * 若先验会话，跨站攻击者可以从响应里区分"cookie 有效/无效"，白拿一个会话探测 oracle。
 *
 * ⚠️ 与 `ClientKeyGuard` 的区别：
 *   - ClientKeyGuard 保护 `/v1/*`，读 `Authorization`，挂 `req.keyContext`
 *   - 本 Guard 保护 `/api/*`（login / session 除外），读 cookie，挂 `req.admin`
 */

import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { RelayRequest } from '../api.types';
import { RelayHttpError, ApiCode } from '../../common/errors';
import { RelayConfigService } from '../../config/config.service';
import { assertOrigin } from './origin';
import { SESSION_COOKIE, verifySession, type SessionPayload } from './session';

export interface AdminContext {
  sub: 'admin';
  payload: SessionPayload;
}

/** cookie 头的最小解析：只找我们关心的那一个，不引 cookie 库。 */
export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    // cookie 值不含 ';'，但可能被引号包住
    return part.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly config: RelayConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RelayRequest>();
    // 1) CSRF：写方法必须有同源 Origin
    assertOrigin({
      method: req.method,
      origin: header(req.headers, 'origin'),
      host: header(req.headers, 'host'),
    });

    // 2) 会话 cookie
    const token = readCookie(req.headers['cookie'], SESSION_COOKIE);
    const result = verifySession(this.config.secret, token);
    if (!result.ok) {
      // reason 只进日志：对外统一一句话，前端只看 401 就跳登录页
      this.logger.warn(`控制台会话被拒绝：reason=${result.reason} path=${req.url ?? '?'}`);
      throw new RelayHttpError({
        httpStatus: 401,
        code: 'no_session',
        apiCode: ApiCode.NO_SESSION,
        message: '会话缺失或已过期，请重新登录。',
      });
    }

    req.admin = { sub: 'admin', payload: result.payload };
    return true;
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}
