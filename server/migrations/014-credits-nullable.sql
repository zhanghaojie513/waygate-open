-- =============================================================================
-- 迁移 014：requests.credits 改为可空 —— 「未知」不再伪装成数字（2026-10-11 v0.5.8）
--
-- 背景（反代项目的口径铁律）：
--   credits 的**唯一权威来源**是上游 usage 里回报的 `credit` 字段（真实账单）。
--   此前上游不回报时会用**本地标定公式**（0.28 分/1K tokens × 倍率）补一个数 ——
--   那是我们自己的估算，不是上游事实。实测证据：MiniMax 的 6 条请求全部走了这条
--   兜底，其中 2 条记成 **40.18 积分**，而账户真实总消耗才 61.30；WorkBuddy 侧
--   2660 条里也有 165 条（6%）是估算。
--
--   反代的价值是"如实转达上游"。自造数字会让整个面板失去可信度 ——
--   用户一旦发现某个数是编的，就会怀疑所有数。所以：
--     **上游没回报 → 记 NULL（未知），绝不补一个看起来合理的数。**
--   与既有纪律一致：`model_catalog.multiplier` 可空 = 倍率未知；quota-block 的
--   「拿不到的字段一律 null」。
--
-- 结构变更：`credits REAL NOT NULL DEFAULT 0` → `credits REAL`（去掉 NOT NULL 与默认值）。
--   SQLite 改不了列的约束 → 表重建（迁移 012 已用过同样手法）。
--   存量数据原样保留（历史行里的估算值仍在，不追溯改写 —— 那是当时的记录）。
--
-- 幂等：入口按 user_version 短路（13 → 14 只跑一次）。
-- =============================================================================

BEGIN;

CREATE TABLE requests_v14 (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  trace_id           TEXT    NOT NULL,
  client             TEXT    NOT NULL DEFAULT '未识别',
  client_rule        INTEGER NOT NULL DEFAULT 4,
  client_id          TEXT    NOT NULL DEFAULT 'unidentified',
  key_id             TEXT,
  key_hint           TEXT,
  model              TEXT    NOT NULL,
  model_display      TEXT,
  status             INTEGER NOT NULL,
  upstream_code      INTEGER,
  ms                 INTEGER NOT NULL DEFAULT 0,
  queued_ms          INTEGER NOT NULL DEFAULT 0,
  first_byte_ms      INTEGER,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  -- ★ 本次迁移的目标：可空。NULL = 上游未回报该次调用的费用（未知），不是 0。
  credits            REAL,
  stream             INTEGER NOT NULL DEFAULT 1,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  note               TEXT    NOT NULL DEFAULT '',
  remote_ip          TEXT,
  ua                 TEXT,
  request_body       TEXT,
  response_body      TEXT,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (key_id) REFERENCES client_keys(id) ON DELETE SET NULL
);

INSERT INTO requests_v14
  (id, ts, trace_id, client, client_rule, client_id, key_id, key_hint, model, model_display,
   status, upstream_code, ms, queued_ms, first_byte_ms, prompt_tokens, completion_tokens,
   total_tokens, cached_tokens, reasoning_tokens, credits, stream, retry_count, note,
   remote_ip, ua, request_body, response_body, created_at)
SELECT
   id, ts, trace_id, client, client_rule, client_id, key_id, key_hint, model, model_display,
   status, upstream_code, ms, queued_ms, first_byte_ms, prompt_tokens, completion_tokens,
   total_tokens, cached_tokens, reasoning_tokens, credits, stream, retry_count, note,
   remote_ip, ua, request_body, response_body, created_at
FROM requests;

DROP TABLE requests;
ALTER TABLE requests_v14 RENAME TO requests;

CREATE INDEX IF NOT EXISTS idx_requests_ts           ON requests(ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_id_ts ON requests(client_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts     ON requests(model, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_key_ts       ON requests(key_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status_ts    ON requests(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_key_ip       ON requests(key_id, remote_ip);

PRAGMA user_version = 14;

COMMIT;
