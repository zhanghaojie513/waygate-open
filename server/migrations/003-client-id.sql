-- =============================================================================
-- 迁移 002 → 003：requests 增加稳定分组键 client_id（spec-v4-client-id 方案 A）
--
-- 背景（要修的病）：
--   日志那一列过去存的是**客户端名字**，而名字是给人看的、会变的。改名之后行仍在库里
--   但带着旧名，按新名分组 / 过滤 / 聚合**全部静默失配** —— 界面只会显示"越界从 1 次
--   变成 0 次"，**看起来像变好了**，而没有任何提示：不报错、不难看、只是那行悄悄不算数。
--   本次把「分组 / 过滤 / 聚合键」换成稳定的 client_id，名字降级为仅供渲染的快照
--   （requests.client 保留，但**不得再当键用**，见 schema.sql 的列注释）。
--
-- ⚠️ 破坏性变更的纪律（ADR-002 + DEPLOY-CHECKLIST §9.5，不得跳过）：
--   1. **先备份**：VACUUM INTO 到独立文件，确认备份可读，**再**执行本迁移。
--      relay.db 是唯一数据源，本迁移对 requests 做 DDL。
--   2. 手工执行（migrate.ts:33-35 明确"本服务不会自动改表"，低版本拒绝启动）。
--   3. 迁移后 PRAGMA user_version 必须为 3，否则服务拒绝启动（刻意设计，不要绕过）。
--
-- 执行入口（线上没装 sqlite3 CLI，与 002 同一模式）：
--   node tools/migrate-003.mjs
--   它内部：校验版本 -> VACUUM INTO 备份 -> 执行本文件 -> 回读验证。
--   ★ 幂等由入口保证：user_version >= 3 时直接短路，绝不重跑 DDL。
--
-- ⚠️ 关于"能否把本文件裸跑两遍"：
--   SQLite **不支持** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（3.53 实测语法错误），
--   裸跑第二遍会在 ADD COLUMN 处报 "duplicate column name"。因此**幂等性由执行入口
--   （migrate-003.mjs 的版本守卫）保证**；本文件其余语句均已写成 IF EXISTS / IF NOT EXISTS，
--   单独重跑它们都是无害 no-op。请勿绕过入口裸执行第二遍。
-- =============================================================================

BEGIN;

-- 1) 加列：NOT NULL + 默认值（SQLite 允许对已有表做此操作，空表/非空表皆可）
ALTER TABLE requests ADD COLUMN client_id TEXT NOT NULL DEFAULT 'unidentified';

-- 2) 回填：凡有 key_id 的旧行，身份就是那把密钥（识别规则第 2 条 = 密钥归属）。
--    没有 key_id 的行（env 种子密钥 / 未识别）保持默认的 'unidentified'（识别规则第 4 条）。
UPDATE requests
   SET client_id = key_id
 WHERE key_id IS NOT NULL AND key_id <> '';

-- 3) 索引换列：旧索引随分组键一起退役（分组键由 client 名字 -> client_id 稳定 id）
DROP INDEX IF EXISTS idx_requests_client_ts;
CREATE INDEX IF NOT EXISTS idx_requests_client_id_ts ON requests(client_id, ts DESC);

-- 4) aggregates 里的历史键：库里已存在的 dim='client' 聚合行，其 dim_value 仍是**名字**。
--    清掉它们，让聚合按新键（client_id）重建。
--    ★★ 这是**可重建的派生数据，不是数据丢失**：aggregates 只是 requests 的物化结果，
--       权威源始终是 requests（见 schema.sql 表头注释与 ADR-002）。真要立刻补回历史聚合，
--       可用 schema.sql 末尾"聚合重算"那段 SQL 从 requests 全量重算；不清也不会算错，
--       只是旧的按名字的 client 聚合行会与新键并存一段时间。
DELETE FROM aggregates WHERE dim = 'client';

-- 5) 版本号（user_version 参与事务，失败会连同上面的 DDL 一起回滚）
PRAGMA user_version = 3;

COMMIT;

-- =============================================================================
-- 迁移后验证（迁移完执行；期望 3 / 含 client_id / bad_backfill = 0）
-- =============================================================================
-- PRAGMA user_version;                        -- 期望 3
-- PRAGMA table_info(requests);                 -- 期望含 client_id
-- SELECT COUNT(*) AS bad_backfill FROM requests
--  WHERE key_id IS NOT NULL AND key_id <> '' AND client_id <> key_id;   -- AC-C03 期望 0
