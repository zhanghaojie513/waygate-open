/**
 * [v0.5.1] 内置模型种子的代码侧装载。
 *
 * 为什么从 schema.sql 挪出来：目录表加了 provider_id（NOT NULL）后，
 * 建表脚本里的静态 INSERT 拿不到提供商行（默认提供商由 providers.service
 * 在启动时创建，晚于建表）—— `INSERT OR IGNORE` 会把 NOT NULL 冲突**静默吞掉**，
 * 种子全灭（实测 0 行、无报错，最阴的失效形态）。
 *
 * 现在的时序：providers.service.ensureSeeded 建出默认提供商行之后调这里，
 * 把 dist/catalog/model-catalog.json 的 17 项种进它自己的分区。
 * seed() 是 INSERT OR IGNORE —— 幂等，不覆盖用户后来改过的字段。
 */

import { readAsset } from '../common/assets';
import type { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';

interface CatalogFile {
  models: Array<{ id: string; displayName: string; tag?: string | null; multiplier: number }>;
}

/** 把内置种子种进给定提供商的分区；返回新插入行数（已存在则 0）。 */
export function seedDefaultModels(catalog: ModelCatalogRepository, providerId: string): number {
  const parsed = JSON.parse(readAsset('catalog/model-catalog.json')) as CatalogFile;
  if (!parsed || !Array.isArray(parsed.models)) return 0;
  return catalog.seed(
    providerId,
    parsed.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      tag: m.tag ?? null,
      multiplier: m.multiplier,
    })),
  );
}
