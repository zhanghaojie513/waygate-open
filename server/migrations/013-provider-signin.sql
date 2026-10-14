-- =============================================================================
-- 迁移 013：providers 签到状态 —— MiniMax Code 每日签到自动化（2026-10-11 v0.5.6）
--
-- 背景：MiniMax Code 的积分靠**每日签到**攒（400/天起，第 4/7 天 1000）。此前
-- 用户必须登客户端手动点，而登录会轮换 refresh token、把 relay 顶下线 ——
-- 两件事互斥。签到 API 已逆向确认（/minimax-cloud/api/v1/signin/{status,claim}，
-- Bearer = relay 已在维护的 access token），于是由 relay 代签，客户端不再需要登录。
--
-- 三列（全部增量、可空，旧行为零变化）：
--   · signin_checked_on   TEXT    最近一次**成功签到**的本地日期（YYYY-MM-DD，Asia/Shanghai）
--                                  —— 幂等闸：同一天不重复 claim（重复会被上游拒，白打）
--   · signin_streak       INTEGER 最近一次查到的连续天数（面板 day_no），仅展示
--   · signin_last_points  INTEGER 最近一次领到的积分，仅展示
--
-- 幂等：入口按 user_version 短路（12 → 13 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE providers ADD COLUMN signin_checked_on  TEXT;
ALTER TABLE providers ADD COLUMN signin_streak      INTEGER;
ALTER TABLE providers ADD COLUMN signin_last_points INTEGER;

PRAGMA user_version = 13;

COMMIT;
