-- =============================================================================
-- 迁移 016：providers WorkBuddy 签到状态 —— WorkBuddy 每日签到自动化（2026-10-13 v1.3.0）
--
-- 背景：WorkBuddy（openai 协议）的积分同样靠**每日签到**攒（100/天 + 连签加成，
-- 实测 streak_days=10、total_credits=1000）。签到接口已从社区实现逆向 + 生产探针实测
-- 确认（POST /v2/billing/meter/{checkin-activity-status,daily-checkin}，Bearer = 转发
-- 已在用的 ck_ 密钥，与 MiniMax 的 OAuth 不同源），由 relay 代签。
--
-- 三列（全部增量、可空，旧行为零变化）。与 MiniMax 的 signin_* 三列（迁移 013）
-- 分开命名：两家的签到语义不同（MiniMax 是 OAuth 面板 day_no 周期，WorkBuddy 是
-- 连签日历 streak + 活动季 season），不共用列：
--   · wb_signin_checked_on   TEXT    最近一次**成功签到**的本地日期（YYYY-MM-DD，
--                                     上游时区口径 Asia/Shanghai）—— 幂等闸
--   · wb_signin_streak       INTEGER 最近一次查到的连签天数（checkin-activity-status
--                                     的 streak_days），仅展示
--   · wb_signin_last_points  INTEGER 最近一次领到的积分（daily_credit），仅展示
--
-- 幂等：入口按 user_version 短路（15 → 16 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE providers ADD COLUMN wb_signin_checked_on   TEXT;
ALTER TABLE providers ADD COLUMN wb_signin_streak       INTEGER;
ALTER TABLE providers ADD COLUMN wb_signin_last_points  INTEGER;

PRAGMA user_version = 16;

COMMIT;
