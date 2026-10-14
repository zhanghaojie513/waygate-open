import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { StoreModule } from './store/store.module';
import { ProxyModule } from './proxy/proxy.module';
import { ApiModule } from './api/api.module';

/**
 * 应用根模块。
 *
 * 四块：
 *   - ConfigModule：设置读写 + HMAC secret + 上游密钥（`@Global()`）
 *   - StoreModule ：SQLite + 迁移 + 5 个仓库（`@Global()`）
 *   - ProxyModule ：`/v1/*` 与 `/healthz`
 *   - ApiModule   ：`/api/*` 控制台（会话鉴权 + 11 组端点）
 *
 * 三个模块的响应形状互不混用（api-contract §0.1）：
 *   `/v1/*` → OpenAI 形状；`/api/*` → `{code,data,message}` 信封；`/healthz` → 裸 JSON。
 *   `/api/*` 的错误信封转换由 `ApiExceptionFilter` 承担，在 `main.ts` 全局注册。
 */
@Module({
  imports: [ConfigModule, StoreModule, ProxyModule, ApiModule],
})
export class AppModule {}
