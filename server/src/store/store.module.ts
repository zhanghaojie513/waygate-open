import { Global, Module } from '@nestjs/common';
import { openDatabase, optimizeDatabase, DB_TOKEN, type Db } from './db';
import { runMigrations } from './migrate';
import { assertSchema } from './self-check';
import { AdminCredentialRepository } from './repositories/admin-credential.repo';
import { AggregatesRepository } from './repositories/aggregates.repo';
import { ClientKeysRepository } from './repositories/client-keys.repo';
import { ModelCatalogRepository } from './repositories/model-catalog.repo';
import { RequestsRepository } from './repositories/requests.repo';
import { StatsRepository } from './repositories/stats.repo';
import { ProvidersRepository } from './repositories/providers.repo';
import { RetentionService } from './retention.service';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Db => {
        const db = openDatabase();
        runMigrations(db);
        assertSchema(db);
        // 迁移完成后刷新查询规划统计（新表/新索引纳入；无统计时规划器只能靠启发式选索引）
        optimizeDatabase(db);
        return db;
      },
    },
    AdminCredentialRepository,
    AggregatesRepository,
    ClientKeysRepository,
    ModelCatalogRepository,
    RequestsRepository,
    StatsRepository,
    // [v0.5.0] 协议路由/令牌刷新/额度门控都要读活提供商 —— 全局提供（原只在 ApiModule）。
    ProvidersRepository,
    // task#37：按 logs.retainDays 每日清理过期请求行 + 聚合桶（契约 §6.5）。
    RetentionService,
  ],
  exports: [
    DB_TOKEN,
    AdminCredentialRepository,
    AggregatesRepository,
    ClientKeysRepository,
    ModelCatalogRepository,
    RequestsRepository,
    StatsRepository,
    ProvidersRepository,
  ],
})
export class StoreModule {}
