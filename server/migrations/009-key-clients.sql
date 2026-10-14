-- =============================================================================
-- 迁移 009：client_keys.clients —— 密钥绑定**多个**提供商（2026-10-10 v0.4.20）
--
-- 背景（要支持的能力）：
--   此前一把密钥只能绑一个提供商（`client` 单值）。接入多个 WorkBuddy 订阅后，
--   用户希望一把密钥可以绑定多个提供商，并**指定优先级**（1 最高，依次递减）——
--   为后续「按优先级路由到不同上游」预留数据模型。
--
-- 设计：**新增列而不是改旧列**（向后兼容，代理热路径零改动）
--   · clients  TEXT NOT NULL DEFAULT '[]'  —— JSON 有序数组 ["WorkBuddy-A","WorkBuddy-B"]
--   · client   TEXT                        —— 保留，语义收窄为「首选提供商」= clients[0]
--   识别规则第 2 级（密钥归属）仍读 `client`（= 优先级最高那家），行为不变。
--   这样本次迁移纯增量：不动代理、不动识别、不动历史行的归因结果。
--
-- 历史行回填：把已有的单个 `client` 包成单元素数组，保证 clients 与 client 一致。
--
-- 幂等：由入口（tools/migrate-009.mjs 按 user_version 短路）保证。
-- =============================================================================

BEGIN;

ALTER TABLE client_keys ADD COLUMN clients TEXT NOT NULL DEFAULT '[]';

-- 回填：已有绑定的行 → 单元素数组（未绑定的保持 '[]'）
UPDATE client_keys
   SET clients = json_array(client)
 WHERE client IS NOT NULL AND client <> '' AND clients = '[]';

PRAGMA user_version = 9;

COMMIT;
