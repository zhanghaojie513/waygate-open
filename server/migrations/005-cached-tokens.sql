-- =============================================================================
-- 迁移 005 → 005：requests / aggregates 增加 cached_tokens（task#62）
--
-- 背景（要修的病）：
--   「订阅剩余积分」上游取不到（额度端点实测 404，见 probe/03-upstream-verified.md），
--   控制台上那个数是空白/占位。改用**本地可算**的指标替换它，其中一项是
--   「缓存命中」—— 它依赖采集每次请求的缓存命中 prompt token 数。
--
--   真值字段：`usage.prompt_tokens_details.cached_tokens`。
--   ⚠️ 陷阱：顶层 `usage.cached_tokens` **恒为 0**（实测同一次调用
--   `cached_tokens:0` 而 `prompt_tokens_details.cached_tokens:7`），**绝不能用**。
--   采集侧的唯一实现见 server/src/proxy/usage-tokens.ts（有防陷阱回归测试）。
--
-- 本次变更：
--   - requests.cached_tokens   INTEGER NOT NULL DEFAULT 0
--   - aggregates.cached_tokens INTEGER NOT NULL DEFAULT 0
--   两列都是 ADD COLUMN + NOT NULL + DEFAULT 0 —— SQLite 允许对已有表做此操作，
--   **对旧行安全**（旧行自动补 0；历史请求本就没采过缓存命中，0 是诚实的）。
--
-- 幂等：由入口（applyForwardScript / tools/migrate-005.mjs）按 user_version 短路保证。
--   SQLite 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，裸跑第二遍会报
--   "duplicate column name"。**请勿绕过入口裸执行第二遍。**
--
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 5。
-- =============================================================================

BEGIN;

ALTER TABLE requests   ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aggregates ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;

PRAGMA user_version = 5;

COMMIT;

-- =============================================================================
-- 迁移后验证（迁移完执行；期望 5 / 两表均含 cached_tokens / 旧行值为 0）
-- =============================================================================
-- PRAGMA user_version;                         -- 期望 5
-- PRAGMA table_info(requests);                  -- 期望含 cached_tokens
-- PRAGMA table_info(aggregates);                -- 期望含 cached_tokens
-- SELECT COUNT(*) AS nonzero_legacy FROM requests WHERE cached_tokens <> 0;  -- 期望 0（旧行补 0）
-- =============================================================================
