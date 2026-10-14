import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

/**
 * 模型行来源（task#18）。
 *   upstream  上游目录拉到的（真订阅清单）
 *   seed      随版本发布的本地种子
 *   manual    人工写入（历史保留）
 * 优先级（同 id 命中多源时取「更高」者）：upstream > manual > seed > observed。
 *
 * [v0.5.1] 目录按提供商分行：主键 (provider_id, id) —— 多提供商同时生效时
 * 各家各管各的清单；路由/展示按「启用提供商的目录并集」工作。
 */
/* [v1.5.0] 'observed' 已废除（目录=接口清单，见 catalog-sync.ts）——类型保留以兼容
   历史行读取（启动 purgeObserved 会清掉，但读取路径不该对旧值抛错）。 */
export type CatalogSource = 'upstream' | 'seed' | 'observed' | 'manual';

export interface ModelCatalogRow {
  provider_id: string;
  id: string;
  display_name: string;
  family: string;
  tag: string | null;
  multiplier: number | null; // NULL = 倍率未知（/v3/config 与本地快照都没有）
  source: CatalogSource;
  verified: number;
  enabled: number;
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SeedModel {
  id: string;
  displayName: string;
  tag: string | null;
  /** 可空：上游不给该模型的倍率（MiniMax 的种子全是 null —— 与库列一致，别造 1.0）。 */
  multiplier: number | null;
}

/** 同步合并要写入的一行（来自 pull.ts 的 mergeCatalog 结果）。 */
export interface CatalogUpsert {
  id: string;
  displayName: string;
  source: CatalogSource;
  multiplier: number | null;
  tag: string | null;
}

/** family = id 的第一个 '-' 分段（kimi-k2.7 -> kimi）。scope「仅某系」判定用它。 */
export function deriveFamily(id: string): string {
  const idx = id.indexOf('-');
  return idx > 0 ? id.slice(0, idx) : id;
}

@Injectable()
export class ModelCatalogRepository {
  private readonly seedStmt;
  private readonly byProviderStmt;
  private readonly byIdExactStmt;
  private readonly byIdStmt;
  private readonly byDisplayStmt;
  private readonly byNormalizedStmt;
  private readonly setVerifiedStmt;
  private readonly setEnabledStmt;
  private readonly mergeStmt;
  private readonly deleteProviderStmt;

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {
    this.seedStmt = db.prepare(
      `INSERT OR IGNORE INTO model_catalog
         (provider_id, id, display_name, family, tag, multiplier, source, verified, enabled, created_at, updated_at)
       VALUES (@providerId, @id, @display_name, @family, @tag, @multiplier, 'seed', 1, 1, @now, @now)`,
    );
    this.byProviderStmt = db.prepare(
      `SELECT * FROM model_catalog WHERE provider_id = ? ORDER BY id ASC`,
    );
    /* 三级查找都在给定提供商集合内做（多启用时的路由解析）。 */
    this.byIdExactStmt = db.prepare(
      `SELECT * FROM model_catalog WHERE provider_id = ? AND id = ?`,
    );
    this.byIdStmt = db.prepare(
      `SELECT * FROM model_catalog WHERE provider_id = ? AND lower(id) = lower(?)`,
    );
    this.byDisplayStmt = db.prepare(
      `SELECT * FROM model_catalog WHERE provider_id = ? AND lower(display_name) = lower(?)`,
    );
    this.byNormalizedStmt = db.prepare(
      `SELECT * FROM model_catalog
        WHERE provider_id = ? AND lower(replace(display_name, ' ', '-')) = lower(replace(?, ' ', '-'))`,
    );
    this.setVerifiedStmt = db.prepare(
      `UPDATE model_catalog SET verified = ?, last_verified_at = ?, updated_at = ? WHERE provider_id = ? AND id = ?`,
    );
    this.setEnabledStmt = db.prepare(
      `UPDATE model_catalog SET enabled = ?, updated_at = ? WHERE provider_id = ? AND id = ?`,
    );
    // 同步合并：新行按 entry 落库；已存在行更新 display_name/source/tag/倍率。
    // tag 一律跟随上游（v0.4.16 用户拍板：反代决定不了标签，按真实来）。
    // 倍率例外：manual（用户手填，历史保留）行的倍率不被覆盖；接口未给倍率（NULL）时保留本地值。
    // enabled / verified 仍保持本地（用户改动优先）。
    this.mergeStmt = db.prepare(
      `INSERT INTO model_catalog
         (provider_id, id, display_name, family, tag, multiplier, source, verified, enabled, created_at, updated_at)
       VALUES (@providerId, @id, @display_name, @family, @tag, @multiplier, @source, 0, 1, @now, @now)
       ON CONFLICT(provider_id, id) DO UPDATE SET
         display_name = excluded.display_name,
         source       = excluded.source,
         tag          = excluded.tag,
         multiplier   = CASE
                          WHEN model_catalog.source = 'manual' THEN model_catalog.multiplier
                          ELSE COALESCE(excluded.multiplier, model_catalog.multiplier)
                        END,
         updated_at   = excluded.updated_at`,
    );
    this.deleteProviderStmt = db.prepare(`DELETE FROM model_catalog WHERE provider_id = ?`);
  }

  /** 幂等：不覆盖用户后来改过的 multiplier / enabled / tag。 */
  seed(providerId: string, models: SeedModel[]): number {
    const now = Date.now();
    const tx = this.db.transaction((rows: SeedModel[]) => {
      let inserted = 0;
      for (const m of rows) {
        const info = this.seedStmt.run({
          providerId,
          id: m.id,
          display_name: m.displayName,
          family: deriveFamily(m.id),
          tag: m.tag,
          multiplier: Number.isNaN(m.multiplier) ? null : m.multiplier,
          now,
        });
        inserted += info.changes;
      }
      return inserted;
    });
    return tx(models) as number;
  }

  /** 某一家提供商的完整清单。 */
  all(providerId: string): ModelCatalogRow[] {
    return this.byProviderStmt.all(providerId) as ModelCatalogRow[];
  }

  /** 多提供商并集视图（控制台目录 /v1/models 用）；同 id 多家时保留全部行由调用方去重。 */
  allAcross(providerIds: string[]): ModelCatalogRow[] {
    const out: ModelCatalogRow[] = [];
    for (const pid of providerIds) out.push(...this.all(pid));
    return out;
  }

  /**
   * 三级查找（L1 精确 id / L2 显示名 / L3 规范化显示名），在给定提供商集合内。
   *
   * [v0.5.1] L1 拆两轮：**先全集合大小写敏感**，不中再全集合不敏感 ——
   * 多提供商同存时，`MiniMax-M3`（MiniMax 官方 id）与 `minimax-m3`（WorkBuddy
   * 转发名）会同时在不同分区，精确匹配必须优先，否则创建序在前的分
   * 区会把别人的模型"抢"走（实测踩过：路由到了错误协议的路径吃 400）。
   *
   * 返回**命中的 (提供商, 行) 列表** —— 多家目录都有这个模型时全量返回，
   * 排序/取舍由路由层按密钥优先级决定。
   */
  /** [v0.5.1] 仅精确 id 匹配（大小写敏感），跨给定提供商集合 —— 路由的第一轮。 */
  resolveExactAcross(input: string, providerIds: string[]): Array<{ providerId: string; row: ModelCatalogRow }> {
    const trimmed = input.trim();
    for (const pid of providerIds) {
      const exact = this.byIdExactStmt.get(pid, trimmed) as ModelCatalogRow | undefined;
      if (exact) return [{ providerId: pid, row: exact }];
    }
    return [];
  }

  /**
   * [v0.5.10] 与 `resolveExactAcross` 同，但返回**全部**精确命中（按 providerIds 顺序）。
   *
   * 为什么需要"全部"：多家目录同存一个 id 时，路由层要按「**声明优先于 observed**」取舍 ——
   * `source=observed` 只说明"见过这条请求"，不说明"这家提供它"。2026-10-11 真实事故：
   * observed 泄漏使 WorkBuddy 目录里出现 `MiniMax-M3.1-Flash-Preview`（幽灵行），
   * 第一轮精确匹配按顺序命中它，把 MiniMax 模型的请求抢去了 WorkBuddy。
   * 取舍策略放路由层（那里才有密钥优先级的编排语境），本方法只负责如实返回全部命中。
   */
  resolveExactAllAcross(input: string, providerIds: string[]): Array<{ providerId: string; row: ModelCatalogRow }> {
    const trimmed = input.trim();
    const out: Array<{ providerId: string; row: ModelCatalogRow }> = [];
    for (const pid of providerIds) {
      const exact = this.byIdExactStmt.get(pid, trimmed) as ModelCatalogRow | undefined;
      if (exact) out.push({ providerId: pid, row: exact });
    }
    return out;
  }

  /**
   * 三级查找（L1 精确 id / L2 显示名 / L3 规范化显示名），在给定提供商集合内。
   *
   * [v0.5.1] 注意：本方法的 L1 是**大小写不敏感**的（单家内的宽容匹配）。
   * 「先全集合精确、再逐家模糊」的跨家优先级由调用方（resolveRoute）编排 ——
   * `MiniMax-M3`（mavis 官方 id）与 `minimax-m3`（WorkBuddy 转发名）在不同分区
   * 并存时，精确匹配必须先于一切模糊匹配，否则创建序在前的分区会把别人的
   * 模型"抢"走（生产实测踩过：路由到错误协议的路径吃 400）。
   *
   * 返回**命中的 (提供商, 行) 列表** —— 多家目录都有这个模型时全量返回，
   * 排序/取舍由路由层按密钥优先级决定。
   */
  resolveAcross(input: string, providerIds: string[]): Array<{ providerId: string; row: ModelCatalogRow }> {
    const trimmed = input.trim();
    for (const pid of providerIds) {
      const hit =
        (this.byIdStmt.get(pid, trimmed) as ModelCatalogRow | undefined) ??
        (this.byDisplayStmt.get(pid, trimmed) as ModelCatalogRow | undefined) ??
        (this.byNormalizedStmt.get(pid, trimmed) as ModelCatalogRow | undefined);
      if (hit) return [{ providerId: pid, row: hit }];
    }
    return [];
  }

  findById(providerId: string, id: string): ModelCatalogRow | undefined {
    return this.byIdStmt.get(providerId, id) as ModelCatalogRow | undefined;
  }

  /** 11102 -> verified=0，绝不删除（订阅后可能又开）。 */
  setVerified(providerId: string, id: string, verified: boolean): void {
    this.setVerifiedStmt.run(verified ? 1 : 0, Date.now(), Date.now(), providerId, id);
  }

  setEnabled(providerId: string, id: string, enabled: boolean): void {
    this.setEnabledStmt.run(enabled ? 1 : 0, Date.now(), providerId, id);
  }

  /**
   * [v0.5.1] 清空**某一家**的目录（停用/删除该提供商时用；不动别家 —— 多生效模型
   * 的核心约束）。日常同步走 `mergeSync`（只增不减）。
   */
  clearProvider(providerId: string): void {
    this.deleteProviderStmt.run(providerId);
  }

  /**
   * [v1.5.0] **替换式**同步：清掉该提供商的旧行（manual 行保留 —— 用户显式登记的，
   * 自动流程不冲掉），插入本轮拉到的清单。新目录语义（用户拍板「纯接口口径」）：
   * 目录 = 上游清单接口本轮返回的列表，拉到什么就是什么；observed/种子合并全部
   * 废除（MiniMax 例外 —— 上游无清单端点，走 seedMinimaxCatalog 不经此方法）。
   *
   * [v1.5.1] **用户的启停选择必须跨替换存活**：先快照 enabled 再删除，插入时回填
   * （mergeStmt 的 ON CONFLICT 分支在 DELETE 后不再触发，硬编码 enabled=1 会把
   * 用户停用的模型静默重新启用 —— 旧「只增不减」语义天然保留，替换式必须显式补回）。
   *
   * [v1.5.3] **实测结论（verified / last_verified_at）同样必须跨替换存活**：同上原因，
   * mergeStmt 硬编码 verified=0，替换后所有行的「已实测」状态被抹掉 —— 症状是控制台
   * 显示「获取模型」成功（返回了实测结果）但列表可用标记与 last_verified_at 全空
   * （`safeDailySync` 每次启动/每日都走不含实测的 replaceSync，会周期性抹除）。
   */
  replaceSync(providerId: string, entries: CatalogUpsert[]): { inserted: number } {
    const now = Date.now();
    const purgeStmt = this.db.prepare(
      `DELETE FROM model_catalog WHERE provider_id = ? AND source != 'manual'`,
    );
    /* 替换前快照：用户字段（enabled）与实测结论（verified/last_verified_at）。 */
    const prevRows = this.db
      .prepare(`SELECT id, enabled, verified, last_verified_at FROM model_catalog WHERE provider_id = ?`)
      .all(providerId) as Array<{ id: string; enabled: number; verified: number; last_verified_at: number | null }>;
    const prev = new Map(prevRows.map((r) => [r.id, r]));
    const restoreStmt = this.db.prepare(
      `UPDATE model_catalog SET enabled = ?, verified = ?, last_verified_at = ? WHERE provider_id = ? AND id = ?`,
    );
    const tx = this.db.transaction((rows: CatalogUpsert[]) => {
      purgeStmt.run(providerId);
      for (const e of rows) {
        this.mergeStmt.run({
          providerId,
          id: e.id,
          display_name: e.displayName,
          family: deriveFamily(e.id),
          tag: e.tag,
          multiplier: e.multiplier,
          source: e.source,
          now,
        });
        /* 回填：停用选择 + 实测结论（新模型无历史 → 默认启用/未实测）。 */
        const p = prev.get(e.id);
        if (p !== undefined) restoreStmt.run(p.enabled, p.verified, p.last_verified_at, providerId, e.id);
      }
    });
    tx(entries);
    return { inserted: entries.length };
  }

  /** [v1.5.0] 清理历史 observed 行（启动幂等 —— 该 source 已废除，行不该再存在）。 */
  purgeObserved(): number {
    const info = this.db
      .prepare(`DELETE FROM model_catalog WHERE source = 'observed'`)
      .run();
    return info.changes;
  }

  /**
   * 把一次同步（上游 ∪ /v3/config ∪ 种子 ∪ observed）的结果落库（归属给定提供商）。
   * **只增不减**：绝不删除已有行；已存在行更新 display_name / source / 倍率
   * （倍率：接口权威、manual 行保护，语义见 mergeStmt 注释），enabled / tag / verified 不动。
   *
   * @returns 新增行数与更新行数（便于日志与测试断言）。
   */
  mergeSync(providerId: string, entries: CatalogUpsert[]): { inserted: number; updated: number } {
    const now = Date.now();
    const known = new Set((this.all(providerId) as ModelCatalogRow[]).map((r) => r.id));
    let inserted = 0;
    let updated = 0;
    const tx = this.db.transaction((rows: CatalogUpsert[]) => {
      for (const e of rows) {
        this.mergeStmt.run({
          providerId,
          id: e.id,
          display_name: e.displayName,
          family: deriveFamily(e.id),
          tag: e.tag,
          multiplier: e.multiplier,
          source: e.source,
          now,
        });
        if (known.has(e.id)) updated += 1;
        else {
          inserted += 1;
          known.add(e.id);
        }
      }
    });
    tx(entries);
    return { inserted, updated };
  }
}
