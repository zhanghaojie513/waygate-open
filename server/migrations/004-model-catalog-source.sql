-- =============================================================================
-- 迁移 004：model_catalog 支持「来源 = observed」与「倍率未知」
--
-- 背景（task #18）：
--   上游模型目录端点已确证为 GET /v2/enterprises/personal/models（见 probe/04-catalog-recheck.md）。
--   接入后模型来源从「seed 单值」变为三态：
--     upstream  上游目录拉到的（真订阅清单）
--     seed      随版本发布的本地种子（schema.sql 播种）
--     observed  实际成功调用过（requests.status=200）而得到的——不依赖任何上游端点
--     manual    人工写入（保留，历史兼容）
--   旧 CHECK 只允许 ('upstream','seed','manual')，无法落 observed。
--
--   同时：上游响应**不含倍率字段**，倍率只能来自本地映射；映射缺失的模型
--   必须能表达「未知」，而不是编一个 1.0。故本次一并把 multiplier 改为可空
--   （NULL = 倍率未知）。SQLite 无法 ALTER 掉 CHECK 约束或 NOT NULL，只能重建表。
--
-- 幂等：由入口（applyForwardScript / tools/migrate-004.mjs）按 user_version 短路保证，
--       本脚本自身**不可**重复执行（DROP/CREATE 会重置表）。
--
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 4。
-- =============================================================================

BEGIN;

CREATE TABLE model_catalog_new (
  id               TEXT    PRIMARY KEY,             -- API ID，如 'kimi-k2.7'
  display_name     TEXT    NOT NULL,                -- 显示名，如 'Kimi-K2.7-Code'
  family           TEXT    NOT NULL,                -- 'kimi' | 'glm' | 'deepseek' | 'hy4' …
  tag              TEXT,                            -- 限时免费 / 限时折扣 / 夜间折扣 / 订阅优先
  multiplier       REAL,                            -- 计费权重；NULL = 倍率未知（不编造 1.0）
  source           TEXT    NOT NULL DEFAULT 'seed', -- 'upstream' | 'seed' | 'observed' | 'manual'
  verified         INTEGER NOT NULL DEFAULT 0,      -- 1 = 最近一次实测通过
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  CHECK (source  IN ('upstream', 'seed', 'observed', 'manual')),
  CHECK (verified IN (0, 1)),
  CHECK (enabled  IN (0, 1))
);

INSERT INTO model_catalog_new
  (id, display_name, family, tag, multiplier, source, verified, enabled, last_verified_at, created_at, updated_at)
SELECT
  id, display_name, family, tag, multiplier, source, verified, enabled, last_verified_at, created_at, updated_at
FROM model_catalog;

DROP TABLE model_catalog;

ALTER TABLE model_catalog_new RENAME TO model_catalog;

CREATE INDEX IF NOT EXISTS idx_model_catalog_display ON model_catalog(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_model_catalog_enabled ON model_catalog(enabled);

PRAGMA user_version = 4;

COMMIT;

-- =============================================================================
-- 执行后自检（人工）：
--   PRAGMA user_version;                       -- 期望 4
--   SELECT COUNT(*) FROM model_catalog;        -- 期望与迁移前一致（17）
--   PRAGMA table_info(model_catalog);          -- multiplier 的 notnull 应为 0
-- =============================================================================
