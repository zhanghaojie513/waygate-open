-- =============================================================================
-- 迁移 015：providers.protocol 放宽为三方言 —— 接入 Qoder CN（2026-10-11 v0.6.0）
--
-- 背景：Qoder CN 作为第三种出站方言接入（COSY 协议）。providers.protocol 的
--   CHECK 约束此前写死 ('openai','anthropic')，新值 'qoder' 被数据库直接拒绝
--   （实测：POST /api/providers → SqliteError: CHECK constraint failed）。
--
-- 结构变更：CHECK (protocol IN ('openai','anthropic')) → 加 'qoder'。
--   SQLite 改不了 CHECK 约束 → 表重建（迁移 012 / 014 同手法）。
--
-- 语义：qoder 的凭证是身份 JSON（token/refreshToken/uid/name/userType），
--   存 providers/<id>.key（与其它提供商同文件位），出站由 QoderCredentialStore
--   直读 —— 不写全局出站凭证位（与 anthropic 的 oauth 同纪律）。
--   cred_kind 保持 'static'（本服务不自动刷新 Qoder 令牌：刷新会轮换 refresh
--   token 顶掉桌面客户端登录，口径详见 qoder-upstream/credential.ts 头注）。
--
-- 幂等：入口按 user_version 短路（14 → 15 只跑一次）。
-- 存量数据原样保留（既有 openai/anthropic 行的所有列逐位照抄）。
-- =============================================================================

BEGIN;

CREATE TABLE providers_v15 (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  base_url   TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0
             CHECK (active IN (0, 1)),
  -- ★ 本次迁移的目标：三方言（openai=WorkBuddy / anthropic=mavis / qoder=Qoder CN）
  protocol   TEXT    NOT NULL DEFAULT 'openai'
             CHECK (protocol IN ('openai', 'anthropic', 'qoder')),
  chat_path  TEXT,
  cred_kind  TEXT    NOT NULL DEFAULT 'static'
             CHECK (cred_kind IN ('static', 'oauth_minimax')),
  access_expires_at INTEGER,
  signin_checked_on  TEXT,
  signin_streak      INTEGER,
  signin_last_points INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO providers_v15
  (id, name, base_url, active, protocol, chat_path, cred_kind,
   access_expires_at, signin_checked_on, signin_streak, signin_last_points, created_at, updated_at)
SELECT
   id, name, base_url, active, protocol, chat_path, cred_kind,
   access_expires_at, signin_checked_on, signin_streak, signin_last_points, created_at, updated_at
FROM providers;

DROP TABLE providers;
ALTER TABLE providers_v15 RENAME TO providers;

CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(active);

PRAGMA user_version = 15;

COMMIT;
