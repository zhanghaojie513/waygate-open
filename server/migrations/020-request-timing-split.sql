-- =============================================================================
-- 迁移 020：requests 记录「网关自身开销」的分段（2026-10-21 v1.7.2）
--
-- 背景：`ms`（总耗时）与 `first_byte_ms` 只能回答「慢不慢」，回答不了
-- 「谁的慢」。实测口径核实（v1.7.2）：
--   · `first_byte_ms` = 请求进门 → 收到第一个 chunk（不是「发往上游起算」，
--     旧注释/旧 tooltip 描述有误，已在同版修正文案）；
--   · 它把「我方鉴权/路由/凭证」与「上游排队」混在一个数里。
--
-- 三列把它切开（全部可空，老行为 NULL = 未知）：
--   · auth_ms           请求进门        → 鉴权完成（KeyGuard：密钥/IP 策略/配额）
--   · prep_ms           鉴权完成        → 首次发往上游（路由解析 + 目录查找 + 凭证 + 组包）
--   · upstream_wait_ms  首次发往上游    → 首字节（纯上游侧：排队 + 思考）
--
-- ⇒ 我方开销 = auth_ms + prep_ms（**不落库**：派生量随时可加，落冗余列只会不一致）。
-- ⇒ ms = (auth_ms + prep_ms) + upstream_wait_ms + 流式输出时长（三者拼回总耗时）。
--
-- 为什么可空而不是 NOT NULL DEFAULT 0：
--   与迁移 014（credits 改可空）同一条纪律 —— 「未知」不能压成 0。失败行、迁移前的
--   老行、以及任何未打点的分支，界面上必须显示 `--`，而不是「0ms，很快」。
--   ⚠️ prep_ms 里藏着一个会走网络的动作：WorkBuddy access token 到期时
--   buildWorkBuddyHeaders 会触发一次 refresh 往返。单独成列就是为了让它可见 ——
--   否则用户看到「我方慢了 800ms」会误以为是代码问题。
--
-- 不加索引：这三列只用于详情展示与按窗口的聚合（窗口已由 idx_requests_ts 收窄），
-- 数据量级（自用工具）不需要额外索引，多一个索引就是多一份写放大。
--
-- 幂等：入口按 user_version 短路（19 → 20 只跑一次）。
-- =============================================================================

BEGIN;

ALTER TABLE requests ADD COLUMN auth_ms INTEGER;
ALTER TABLE requests ADD COLUMN prep_ms INTEGER;
ALTER TABLE requests ADD COLUMN upstream_wait_ms INTEGER;

PRAGMA user_version = 20;

COMMIT;
