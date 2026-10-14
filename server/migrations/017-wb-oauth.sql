-- =============================================================================
-- 迁移 017：providers WorkBuddy OAuth 槽（2026-10-13 v1.4.0）
--
-- 背景：WorkBuddy 的签到领取/成长任务在上游属「用户会话域」，API 密钥（ck_）被明确
-- 拒绝（403 "API key not allowed"）。v1.4.0 引入第二凭证槽：providers/<id>.oauth 文件
-- 存桌面端 OAuth（accessToken/refreshToken/uid/domain），转发照旧走 ck_，两把凭证
-- 互不干扰。互踢实验实证（2026-10-13）：refresh 不作废旧 token、多会话共存——
-- 用户桌面端与 relay 的 OAuth 链可并存。
--
-- 一列（增量、可空）：
--   · wb_oauth_expires_at INTEGER  WorkBuddy OAuth access token 过期时刻（epoch ms；
--                                  只存时间不存令牌，与 access_expires_at 同纪律）
--
-- 幂等：入口按 user_version 短路（16 → 17 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE providers ADD COLUMN wb_oauth_expires_at INTEGER;

PRAGMA user_version = 17;

COMMIT;
