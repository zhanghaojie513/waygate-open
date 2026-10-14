-- =============================================================================
-- 迁移 001 → 002：新增 admin_credential 表（控制台管理口令改为存数据库）
--
-- 执行方式（服务停止后执行，或在线执行均可 —— 本迁移只建表，不锁写）：
--   sqlite3 /var/lib/relay/relay.db < 002-admin-credential.sql
--
-- 前置：备份（强烈建议，虽然是纯增表操作）
--   sqlite3 /var/lib/relay/relay.db "VACUUM INTO '/var/lib/relay/backup/relay-premigrate-002.db'"
--
-- ⚠️ 本脚本必须在事务内执行，失败整体回滚。
-- ⚠️ 执行后必须把 PRAGMA user_version 置为 2，否则服务会拒绝启动。
--
-- 迁移是**幂等**的：全部使用 IF NOT EXISTS，重复执行不会报错。
--
-- 数据迁移说明：本次**不迁移** data/admin.hash 的既有值。
--   理由：AdminCredentialService 的加载顺序是
--     ① 环境变量 RELAY_ADMIN_PASSWORD_HASH
--     ② admin_credential 表
--     ③ 数据目录下的 admin.hash 文件（回落，见下）
--   保留文件回落意味着迁移后**原口令继续可用**，避免"升个版本把自己锁在门外"。
--   表为空时服务会读文件；一旦通过控制台改过一次密，表就有值并开始优先。
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_credential (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  hash        TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'generated',
  updated_at  INTEGER NOT NULL,
  rotated_at  INTEGER,

  CHECK (source IN ('generated', 'console'))
);

PRAGMA user_version = 2;

COMMIT;

-- =============================================================================
-- 验证（迁移后执行，应输出 2 与表结构）
-- =============================================================================
-- PRAGMA user_version;
-- .schema admin_credential
