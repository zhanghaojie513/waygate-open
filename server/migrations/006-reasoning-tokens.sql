-- =============================================================================
-- 迁移 006：requests 增加 reasoning_tokens（2026-10-07 v0.2.0）
--
-- 背景（要修的病）：
--   「输出 tokens」里其实含思考 tokens（上游计费口径：completion_tokens 包含
--   reasoning）。ZCode 长会话一条回复 130 输出里 98 是思考 —— 不拆开展示，
--   「这条为什么这么贵/这么慢」就不可解释。
--
--   真值字段：`usage.completion_tokens_details.reasoning_tokens`
--   （回落顶层 `usage.completion_thinking_tokens`；两处都见于 2026-10-07 校准探针实测）。
--
-- 本次变更：
--   - requests.reasoning_tokens INTEGER NOT NULL DEFAULT 0
--   ADD COLUMN + NOT NULL + DEFAULT 0 —— 对旧行安全（旧行自动补 0；
--   历史请求未采集过思考数，0 是诚实的）。aggregates 不加（暂无按思考聚合的需求）。
--
-- 幂等：由入口（tools/migrate-006.mjs 按 user_version 短路）保证。
--   SQLite 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，勿裸跑第二遍。
--
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 6。
-- =============================================================================

BEGIN;

ALTER TABLE requests ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;

PRAGMA user_version = 6;

COMMIT;

-- =============================================================================
-- 迁移后验证（期望 6 / requests 含 reasoning_tokens / 旧行值为 0）
-- =============================================================================
-- PRAGMA user_version;                                        -- 期望 6
-- PRAGMA table_info(requests);                                 -- 期望含 reasoning_tokens
-- SELECT COUNT(*) AS nonzero_legacy FROM requests WHERE reasoning_tokens <> 0;  -- 期望 0
-- =============================================================================
