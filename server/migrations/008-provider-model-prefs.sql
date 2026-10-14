-- =============================================================================
-- 迁移 008：provider_model_prefs 表（2026-10-08 v0.4.x · 按提供商记住模型启停）
--
-- 背景（要修的病）：
--   切换提供商时目录会被**清空重建**（旧清单对新上游是错的 —— 见迁移 007），
--   用户对旧清单做的启用/停用选择随之丢失，切回来要重选。
--   这是"单活"模型的固有代价 —— 完整解法是多活（按模型路由），但那要
--   动 model_catalog 的命名空间。**先把症状消掉**：按提供商各存一份启停偏好，
--   切回来时恢复。
--
-- 为什么存"全部行的状态"而不是只存"被停用的"：
--   model_catalog 目前新行默认 enabled=1，只存停用集看似够用 —— 但那依赖
--   "默认启用"这个假设。哪天出现默认停用的行（比如上游标记不可用），
--   "用户显式启用过"就再也存不下来了。每提供商只有十几到几十行，全存不贵。
--
-- 快照时机：**切走那一刻**（resyncAfterProviderSwitch 开头）。
--   只在切换时写、不在每次 toggle 时写 —— 偏好只在"切走再切回"时才有意义，
--   平时多写只是无谓的落库点。
--
-- 幂等：由入口（tools/migrate-008.mjs 按 user_version 短路）保证。
--
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 8。
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS provider_model_prefs (
  provider_id TEXT    NOT NULL,             -- -> providers.id（无 FK：偏好行可以比提供商行活得久，删提供商时服务层负责连带清理）
  model_id    TEXT    NOT NULL,             -- model_catalog.id（恢复时 UPDATE ... WHERE id=?，上游已下线的模型自然落空）
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at  INTEGER NOT NULL,             -- epoch 毫秒
  PRIMARY KEY (provider_id, model_id)
) WITHOUT ROWID;

PRAGMA user_version = 8;

COMMIT;

-- =============================================================================
-- 迁移后验证
-- =============================================================================
-- PRAGMA user_version;                                    -- 期望 8
-- PRAGMA table_info(provider_model_prefs);                -- 期望 4 列
-- SELECT COUNT(*) FROM provider_model_prefs;             -- 期望 0（首启后按需产生）
-- =============================================================================
