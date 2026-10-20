-- =============================================================================
-- 迁移 019：providers.protocol 新增 'custom'（2026-10-20 v1.7.0）
--
-- 背景：新增「自定义提供商」—— 任意 OpenAI 兼容端点（DeepSeek / 硅基流动 /
-- OpenRouter / 本机 vLLM…），鉴权是静态 API key（Authorization: Bearer），
-- 与三家订阅制客户端的 OAuth 导入是两种正交的凭证形态。
--
-- 为什么必须改 CHECK 而不是复用 'openai'：openai 路径是 WorkBuddy 形状的
-- （OAuth 头、指纹 UA、/v2/chat/completions、111xx 重试梯、prompt 重写）。
-- 复用意味着在每个 openai 分支里再挖一层「custom 与否」的洞；独立协议值让
-- 所有分支按 protocol === 'custom' 一条线走，三家内置路径零改动。
--
-- SQLite 的 CHECK 约束不能 ALTER，只能整表重建（标准 12 步 procedure 的
-- 常规子集：新建 → 拷贝 → 换名 → 重建索引）。providers 行数是个位数、
-- 凭证不在表里（.key/.oauth 文件不受影响），重建代价为零风险。
--
-- 除 protocol 的 CHECK 集合外，列与约束与 v18 逐列相同，不增不删不改类型。
--
-- 幂等：入口按 user_version 短路（18 → 19 只跑一次）。
-- 不可逆：执行前按部署纪律先 VACUUM INTO 备份。
-- =============================================================================

BEGIN;

CREATE TABLE providers_v19 (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  base_url   TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0
             CHECK (active IN (0, 1)),
  protocol   TEXT    NOT NULL DEFAULT 'openai'
             CHECK (protocol IN ('openai', 'anthropic', 'qoder', 'custom')),
  chat_path  TEXT,
  cred_kind  TEXT    NOT NULL DEFAULT 'static'
             CHECK (cred_kind IN ('static', 'oauth_minimax')),
  access_expires_at INTEGER,
  signin_checked_on  TEXT,
  signin_streak      INTEGER,
  signin_last_points INTEGER,
  wb_signin_checked_on   TEXT,
  wb_signin_streak       INTEGER,
  wb_signin_last_points  INTEGER,
  wb_oauth_expires_at   INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO providers_v19 (
  id, name, base_url, active, protocol, chat_path, cred_kind,
  access_expires_at, signin_checked_on, signin_streak, signin_last_points,
  wb_signin_checked_on, wb_signin_streak, wb_signin_last_points,
  wb_oauth_expires_at, created_at, updated_at
)
SELECT
  id, name, base_url, active, protocol, chat_path, cred_kind,
  access_expires_at, signin_checked_on, signin_streak, signin_last_points,
  wb_signin_checked_on, wb_signin_streak, wb_signin_last_points,
  wb_oauth_expires_at, created_at, updated_at
FROM providers;

DROP TABLE providers;
ALTER TABLE providers_v19 RENAME TO providers;

CREATE INDEX idx_providers_active ON providers(active);

PRAGMA user_version = 19;

COMMIT;
