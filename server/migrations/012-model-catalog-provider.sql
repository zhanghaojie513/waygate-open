-- =============================================================================
-- 迁移 012：model_catalog 归属提供商 —— 多提供商同时生效的地基（2026-10-11 v0.5.1）
--
-- 背景：此前「恰有一家 active 提供商」，model_catalog 隐式属于它（切换时清空重建）。
-- 多提供商同时生效后，各家要**各自维护各自的模型清单**，路由按
-- 「哪家启用的目录里有这个模型」+「密钥绑定的优先级链」决定。
--
-- 结构变更（表重建 —— SQLite 加列改不了主键）：
--   · 新增 provider_id TEXT NOT NULL（回填为当前 active 那家）
--   · 主键 id → (provider_id, id)：同一模型 id 可同时存在于多家目录
--   · 索引：display / enabled 重建，新增 provider 维度索引
--
-- provider_model_prefs 无需动：它本来就按 (provider_id, model_id) 存启停偏好。
--
-- 幂等：入口按 user_version 短路（11 → 12 只跑一次）。
-- =============================================================================

BEGIN;

CREATE TABLE model_catalog_v12 (
  provider_id       TEXT    NOT NULL,                -- -> providers.id：这份清单属于哪家
  id                TEXT    NOT NULL,                -- API ID，如 'kimi-k2.7'
  display_name      TEXT    NOT NULL,                -- 显示名，如 'Kimi-K2.7-Code'
  family            TEXT    NOT NULL,                -- 'kimi' | 'glm' | 'deepseek' | 'hy4' …
  tag               TEXT,                            -- 限时免费 / 限时折扣 / 夜间折扣 / 订阅优先
  multiplier        REAL,                            -- 计费权重；0.00 = 窗口期内免费；NULL = 倍率未知
  source            TEXT    NOT NULL DEFAULT 'seed', -- 'upstream' | 'seed' | 'observed' | 'manual'
  verified          INTEGER NOT NULL DEFAULT 0,      -- 1 = 最近一次实测通过
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_verified_at  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  CHECK (source  IN ('upstream', 'seed', 'observed', 'manual')),
  CHECK (verified IN (0, 1)),
  CHECK (enabled  IN (0, 1)),
  PRIMARY KEY (provider_id, id)
);

-- 回填：存量行属于当前 active 那家（迁移时刻仍是单活跃语义，归属无歧义）。
INSERT INTO model_catalog_v12
  (provider_id, id, display_name, family, tag, multiplier, source, verified, enabled, last_verified_at, created_at, updated_at)
SELECT
  (SELECT id FROM providers WHERE active = 1 LIMIT 1), id, display_name, family, tag, multiplier, source, verified, enabled, last_verified_at, created_at, updated_at
FROM model_catalog;

DROP TABLE model_catalog;
ALTER TABLE model_catalog_v12 RENAME TO model_catalog;

CREATE INDEX IF NOT EXISTS idx_model_catalog_display  ON model_catalog(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_model_catalog_enabled  ON model_catalog(enabled);
CREATE INDEX IF NOT EXISTS idx_model_catalog_provider ON model_catalog(provider_id);

PRAGMA user_version = 12;

COMMIT;
