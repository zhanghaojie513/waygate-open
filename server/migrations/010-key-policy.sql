-- =============================================================================
-- 迁移 010：client_keys 密钥级访问策略 —— IP 白名单 / 最大 IP 数 / Token 配额
-- （2026-10-10 v0.4.35，参考社区 workbuddy-manager 的「IP 管控 + 多密钥分发」）
--
-- 三个新列都是**增量**（DEFAULT / NULL = 不限制），历史行为零变化：
--   · ip_whitelist TEXT NOT NULL DEFAULT '[]'
--       JSON 数组：IPv4/IPv6 精确地址 + IPv4 CIDR 网段（"203.0.113.0/24"）。
--       空 = 不限。非空时，来源 IP 不在名单内 → 403。
--   · max_ips INTEGER
--       这把密钥历史上最多允许**几个不同来源 IP**（按 requests.remote_ip 去重计数，
--       含历史行 —— 那些本来就是用过这把密钥的 IP）。新 IP 且已达上限 → 403。
--       防的是「密钥发出去之后被转传播」。
--   · token_quota INTEGER
--       累计 total_tokens 上限。入站时查 SUM（软校验：最后一笔可超出）→ 429。
--
-- 配套索引：idx_requests_key_ip —— 最大 IP 数判定每个请求都要做
-- COUNT(DISTINCT remote_ip)，没索引会全表扫。
--
-- ⚠️ IPv6 只支持精确匹配（不展开 :: 简写归一化之外的 CIDR 数学）。
--    本部署的真实来源都是 nginx 写入的 $remote_addr，IPv4 为主，够用且可预期。
--
-- 幂等：入口按 user_version 短路（9 → 10 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE client_keys ADD COLUMN ip_whitelist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_keys ADD COLUMN max_ips INTEGER;
ALTER TABLE client_keys ADD COLUMN token_quota INTEGER;

CREATE INDEX IF NOT EXISTS idx_requests_key_ip ON requests(key_id, remote_ip);

PRAGMA user_version = 10;

COMMIT;
