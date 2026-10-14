import { Module } from '@nestjs/common';
import { ClientKeyGuard } from '../auth/key.guard';
import { ProxyController, HealthController } from './proxy.controller';
import { KeyUsageController } from './usage.controller';
import { ProxyLogger } from './proxy-log';
import { ProxyService } from './proxy.service';
import { MinimaxTokenService } from './anthropic-upstream/minimax-token.service';
import { MinimaxSigninService } from './anthropic-upstream/minimax-signin.service';
import { MinimaxCreditService } from './anthropic-upstream/minimax-credit.service';
import { WbSigninService } from './openai-upstream/wb-signin.service';
import { QoderActivityService } from './qoder-upstream/qoder-activity.service';
import { WbOauthService } from './openai-upstream/wb-oauth.service';
import { WbClaimService } from './openai-upstream/wb-claim.service';
import { AnthropicController } from './anthropic/anthropic.controller';
import { AnthropicKeyGuard } from './anthropic/anthropic-key.guard';

/**
 * 代理模块装配。
 *
 * `ConfigModule` 与 `StoreModule` 都标了 `@Global()`，其导出的 `RelayConfigService`
 * 与 5 个仓库在本模块可直接注入，无需再 import —— 少一层显式依赖，也避免
 * 将来有人误以为"不 import 就没有"。
 *
 * 三件 provider 的依赖链：
 *   ProxyService  ← RelayConfigService, ModelCatalogRepository, ProxyLogger
 *   ProxyLogger   ← RequestsRepository, ModelCatalogRepository
 *   ClientKeyGuard← RelayConfigService, ClientKeysRepository
 *
 * 注意 `ProxyLogger` 带 `@Injectable()`：本项目用 `emitDecoratorMetadata` 生成
 * `design:paramtypes`，而 TS 只为带装饰器的声明发射构造参数元数据 —— 不加就注入不了
 * （真链路实测：`this.requests` 为 undefined，落库静默失败）。
 */
@Module({
  controllers: [ProxyController, AnthropicController, HealthController, KeyUsageController],
  /* [v0.5.0] MinimaxTokenService：anthropic 提供商的 refresh→access 换新。
     [v1.3.0] WbSigninService：WorkBuddy（openai）每日签到代签。
     ProvidersRepository 由全局 StoreModule 提供，这里只补本模块的新服务。 */
  providers: [ProxyLogger, ProxyService, ClientKeyGuard, AnthropicKeyGuard, MinimaxTokenService, MinimaxSigninService, MinimaxCreditService, WbSigninService, WbOauthService, WbClaimService, QoderActivityService],
  exports: [ProxyService, MinimaxTokenService, MinimaxSigninService, MinimaxCreditService, WbSigninService, WbOauthService, WbClaimService, QoderActivityService],
})
export class ProxyModule {}
