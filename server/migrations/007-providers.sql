-- =============================================================================
-- 迁移 007：providers 表（2026-10-08 v0.3.x · 自定义提供商）
--
-- 背景（要修的病）：
--   出站上游是**硬编码单例**（settings.upstream.baseUrl + 一把 ck_）。
--   「反代其他客户端订阅」需要能登记多个上游并切换，但不想为此把
--   client_keys / 代理热路径全部重写。
--
-- 选定的形态（用户拍板，2026-10-08）：**多个已配置、单活**——
--   · providers 表登记 N 个提供商（名称 / baseUrl）；
--   · 恰好一行 active=1；
--   · 激活时把该行的 baseUrl 写进既有 settings.upstream.baseUrl、
--     把该提供商的凭证文件载入既有 config.upstreamKey ——
--     **代理热路径一行不改**（resolveUpstreamBase / buildUpstreamHeaders 原样工作）。
--
-- 为什么 active 是表内列而不是 settings 键：
--   settings.json 的形状由 EDITABLE_KEYS 严格校验，加键要动 defaults/types/校验三处；
--   表内列 + "恰有一行" 的不变式由服务层维护，一处即可。
--
-- 凭证存储：**不在本表**。沿用「只写不可读」纪律，每提供商一个文件
--   `<RELAY_DATA_DIR>/providers/<id>.key`（600，原子写）。表里只存 baseUrl 与名称。
--
-- 种子（为什么不在本迁移里做）：默认行要从 settings.json 读 baseUrl、
--   要复制 upstream.key 文件 —— SQL 做不到，由服务启动时的
--   ProvidersService.ensureSeeded() 完成（幂等：表非空即跳过）。
--
-- 幂等：由入口（tools/migrate-007.mjs 按 user_version 短路）保证。
--   SQLite 支持 `CREATE TABLE IF NOT EXISTS`，但为与其余迁移保持同一纪律，仍勿裸跑第二遍。
--
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 7。
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS providers (
  id         TEXT    PRIMARY KEY,             -- 'p_' + 8 位随机 hex
  name       TEXT    NOT NULL,                -- 人话名（如 WorkBuddy / 某订阅）
  base_url   TEXT    NOT NULL,                -- 上游基地址（https://…，不带尾斜杠）
  active     INTEGER NOT NULL DEFAULT 0
             CHECK (active IN (0, 1)),        -- 恰有一行为 1（服务层维护）
  created_at INTEGER NOT NULL,                -- epoch 毫秒
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(active);

PRAGMA user_version = 7;

COMMIT;

-- =============================================================================
-- 迁移后验证（期望 7 / 表空 —— 首次启动由服务种子默认行）
-- =============================================================================
-- PRAGMA user_version;                       -- 期望 7
-- PRAGMA table_info(providers);              -- 期望 5 列
-- SELECT COUNT(*) FROM providers;            -- 期望 0（种子在启动时做）
-- =============================================================================
