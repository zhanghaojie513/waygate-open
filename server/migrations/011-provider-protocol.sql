-- =============================================================================
-- 迁移 011：providers 协议层 —— 多上游方言支持（2026-10-10 v0.5.0）
--
-- 背景：此前唯一的上游是 WorkBuddy（OpenAI 方言 /v2/chat/completions + ck_ 静态凭证）。
-- 接入 MiniMax Code 客户端积分（mavis 网关，Anthropic Messages 方言 + OAuth 令牌）后，
-- 上游差异从"只有地址不同"升级为"协议/路径/凭证生命周期都不同"。
--
-- 四个新列（全部增量，默认值 = 旧行为零变化）：
--   · protocol TEXT NOT NULL DEFAULT 'openai'
--       'openai' = WorkBuddy 方言（现状）；'anthropic' = Anthropic Messages 方言（mavis）。
--   · chat_path TEXT
--       NULL = 用协议默认路径；显式值覆盖（上游改路径时不用发版）。
--   · cred_kind TEXT NOT NULL DEFAULT 'static'
--       'static' = 静态凭证（ck_，文件里存的就是发出去的）；
--       'oauth_minimax' = 凭证文件存 refresh token（mmort_），出站前换 access token。
--   · access_expires_at INTEGER
--       oauth 刷新状态（epoch ms）。⚠️ 只存时间，不存令牌 —— 秘密一律在文件里
--       （沿用 providers 表"表里不放凭证"的纪律，见 providers.service 文件头）。
--       access token 本体放 <providersDir>/<id>.access，同样 0600、git 不进。
--
-- 幂等：入口按 user_version 短路（10 → 11 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE providers ADD COLUMN chat_path TEXT;
ALTER TABLE providers ADD COLUMN cred_kind TEXT NOT NULL DEFAULT 'static';
ALTER TABLE providers ADD COLUMN access_expires_at INTEGER;

PRAGMA user_version = 11;

COMMIT;
