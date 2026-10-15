import { Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy.module';
import { AuthController } from './auth/auth.controller';
import { AdminCredentialService } from './auth/admin-credential.service';
import { SessionGuard } from './auth/session.guard';
import { ConsoleController } from './console.controller';
import { OverviewService } from './overview.service';
import { ClientsService } from './clients.service';
import { RequestQueryService } from './requests.service';
import { KeysService } from './keys.service';
import { SettingsService } from './settings.service';
import { CredentialService } from './credential.service';
import { ModelsService } from './models.service';
import { ProvidersService } from './providers.service';
import { ProvidersController } from './providers.controller';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ModelProbeService, PROBE_INTERVAL_MS } from '../catalog/probe';
import { CatalogSyncService, CATALOG_PROBE_INTERVAL_MS } from '../catalog/catalog-sync';
import { QuotaSourceService } from '../proxy/quota/quota-source.service';
import { CredentialImportService } from './credential-import.service';
import { DeviceImportService } from './device-import.service';

/**
 * 控制台 API 模块（`/api/*`，api-contract §3）。
 *
 * 两个控制器，鉴权方式不同：
 *   - `AuthController`    （`api/auth/*`）**不挂 Guard** —— 必须能在未登录时调用。
 *                         logout 是 POST，单独调 `assertOrigin` 做 CSRF 保护。
 *   - `ConsoleController` （其余 `/api/*`）整类挂 `SessionGuard`。
 *
 * 依赖注入说明：
 *   `ConfigModule` / `StoreModule` 都是 `@Global()`，所以 `RelayConfigService` 与
 *   各仓库可直接注入。这里注入的仓库是 `ClientKeysRepository`（密钥 CRUD）、
 *   `RequestsRepository`（danger 清日志）、`ModelCatalogRepository`（模型目录）。
 *
 * `SessionGuard` 需要在这里登记为 provider —— 它被 `@UseGuards(SessionGuard)`
 * 以**类**形式引用，Nest 会从当前模块的注入器里解析它的构造依赖。
 *
 * `CredentialService` 处理 `PUT /api/settings/credential`（上游凭证写入）。
 * 它**不是** settings 的一部分：契约里 `credential.source` 是只读项，
 * 写入必须走独立端点，详见 credential.service.ts 的文件头说明。
 */
@Module({
  // ProxyModule 导出 ProxyService：控制台概览要暴露并发占用/上限（task#37）。
  // 只 import 它的 export，不会重复注册它的控制器。
  imports: [ProxyModule],
  controllers: [AuthController, ConsoleController, ProvidersController],
  providers: [
    AdminCredentialService,
    SessionGuard,
    OverviewService,
    ClientsService,
    RequestQueryService,
    KeysService,
    SettingsService,
    CredentialService,
    // task#18：目录拉取/合并/实测拆成三个单元（守 300 行门禁）
    ModelProbeService,
    // ★ 原始类型（number）不能靠类型反射注入：显式令牌 + 值 provider。
    //   缺了这一行，CatalogSyncService 的第 5 参会找不到 provider，
    //   Nest 直接 UnknownDependenciesException → 应用起不来（线上真实事故）。
    { provide: CATALOG_PROBE_INTERVAL_MS, useValue: PROBE_INTERVAL_MS },
    CatalogSyncService,
    ModelsService,
    // 2026-10-08 自定义提供商：repo 在这里登记（StoreModule 不含它），
    // ProvidersService 依赖它 + CatalogSyncService（切换后重建目录）。
    ProvidersService,
    // 2026-10-09 按提供商记住模型启停（迁移 008）：CatalogSyncService 切换时快照/恢复。
    ProviderModelPrefsRepository,
    // task#53：额度来源（按 quota.pollSeconds 轮询上游额度端点）。
    // 启动即拉一次；`OverviewService` 消费它的最近快照。
    QuotaSourceService,
    // [v1.6.5] 从服务端所在机器的客户端登录态一键导入 MiniMax / Qoder 凭证。
    CredentialImportService,
    // [v1.6.11] 设备授权导入（控制台「导入」按钮）：选客户端 → 跳授权页 → 回来即已导入。
    DeviceImportService,
  ],
})
export class ApiModule {}
