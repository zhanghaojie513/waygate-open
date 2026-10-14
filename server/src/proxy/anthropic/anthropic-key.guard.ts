/**
 * `/v1/messages` 的入站鉴权守卫。
 *
 * Anthropic 客户端用 `x-api-key` 头（不是 `Authorization: Bearer`）传密钥。本守卫
 * **只做头部归一化**（`x-api-key` → `Authorization: Bearer <key>`），随后**完全委托**
 * 既有 `ClientKeyGuard` —— 不复制任何校验逻辑、不绕过任何一步（hash 比对 / 停用 / 过期
 * 三步都在 `ClientKeyGuard` 内）。
 */

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ClientKeyGuard, type RequestWithKeyContext } from '../../auth/key.guard';

@Injectable()
export class AnthropicKeyGuard implements CanActivate {
  // 显式 @Inject：不依赖 `design:paramtypes`（esbuild/vitest 不产该元数据），
  // 让 DI 在 tsc 构建与测试运行时都成立。
  constructor(@Inject(ClientKeyGuard) private readonly inner: ClientKeyGuard) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithKeyContext>();
    const headers = req.headers;
    if (!headers['authorization'] && headers['x-api-key']) {
      const raw = headers['x-api-key'];
      const key = Array.isArray(raw) ? raw[0] : raw;
      if (key) headers['authorization'] = `Bearer ${key}`;
    }
    return this.inner.canActivate(context);
  }
}
