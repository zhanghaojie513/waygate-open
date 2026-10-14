import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

/**
 * `provider_model_prefs` —— 按提供商记住「模型目录的启用/停用」（2026-10-08）。
 *
 * 存在理由：切换提供商时目录会被清空重建（旧清单对新上游是错的），
 * 用户对旧清单做的启停选择随之丢失。本表各存一份，切回来时恢复 ——
 * 把「单活」模型的固有代价消掉一层（完整解法是多活路由，那是下一阶段）。
 *
 * 快照时机 = 切走那一刻（`CatalogSyncService.resyncAfterProviderSwitch` 开头）；
 * 恢复时机 = 新提供商的目录拉取合并之后。上游已下线的模型 UPDATE 自然落空。
 *
 * [2026-10-09] **服务层负责在删提供商时连带删偏好**（本表无 FK ——
 * 偏好行允许比提供商行活得久一点，但那只是为了让迁移/清理可选；生产路径应当成对维护）。
 */
@Injectable()
export class ProviderModelPrefsRepository {
  private readonly saveStmt;
  private readonly clearStmt;
  private readonly listStmt;
  private readonly deleteProviderStmt;

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {
    /* 每行 upsert：偏好键是 (provider_id, model_id)，写两次同一对键 = 覆盖而非重复。 */
    this.saveStmt = db.prepare(
      `INSERT INTO provider_model_prefs (provider_id, model_id, enabled, updated_at)
       VALUES (@providerId, @modelId, @enabled, @now)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    );
    this.clearStmt = db.prepare('DELETE FROM provider_model_prefs WHERE provider_id = ?');
    this.listStmt = db.prepare('SELECT model_id, enabled FROM provider_model_prefs WHERE provider_id = ?');
    this.deleteProviderStmt = db.prepare('DELETE FROM provider_model_prefs WHERE provider_id = ?');
  }

  /**
   * 保存某提供商的启停偏好（整体快照：先清后写，保证与「当前目录状态」一一对应）。
   *
   * 为什么先清而不是只 upsert 增量：目录里被删掉的模型的偏好不该留在表里 ——
   * 否则切回来时会试图恢复一个不存在的模型（不会报错，但也没有意义）。
   */
  save(providerId: string, rows: Array<{ modelId: string; enabled: boolean }>): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.clearStmt.run(providerId);
      for (const r of rows) {
        this.saveStmt.run({ providerId, modelId: r.modelId, enabled: r.enabled ? 1 : 0, now });
      }
    })();
  }

  /** 读某提供商的偏好（快照；空 = 从未切换过，不需要恢复）。 */
  load(providerId: string): Array<{ modelId: string; enabled: boolean }> {
    return (this.listStmt.all(providerId) as Array<{ model_id: string; enabled: number }>).map((r) => ({
      modelId: r.model_id,
      enabled: r.enabled === 1,
    }));
  }

  /** 删提供商时连带删偏好（保持「成对」，避免孤儿行堆着）。 */
  deleteForProvider(providerId: string): void {
    this.deleteProviderStmt.run(providerId);
  }
}
