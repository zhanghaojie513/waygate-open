-- =============================================================================
-- 本文件是 design/schema.sql 的逐字副本（唯一权威 DDL）。
-- 改表结构请先改 design/schema.sql，再同步本文件。
-- =============================================================================
-- 驿站 · Relay v0.4.29 — SQLite Schema
-- 引擎：better-sqlite3 13.0.3（同步 API，无 ORM）
-- 文件位置：data/relay.db
-- 迁移版本：PRAGMA user_version = 21
--
-- 迁移规则（手写迁移，不用 ORM / 不用迁移框架）：
--   1. 本文件是 v1 的**完整建表 + 种子数据**，只在空库上跑一次。
--   2. 后续每次变更新增一个 design/migrations/00N-*.sql，并把 user_version +1。
--   3. 启动时校验：user_version 与代码期望值不一致 -> 拒绝启动并打印期望值，
--      绝不静默跑 ALTER（静默迁移是丢失数据的头号原因）。
--   4. 所有迁移在事务内执行；失败整体回滚。
--
-- 与 SPEC §6 的差异：本文件在 SPEC 最小字段集之外补了 9 个列（v3 新增 requests.client_id，
--   v4 把 model_catalog 的 source 扩为四态、multiplier 改为可空），理由见每张表头注释。
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 21;

-- -----------------------------------------------------------------------------
-- 1. requests —— 请求日志，权威数据源
--    一次客户端请求 = 一行。重试不新增行，只加 retry_count（build-plan §2.3）。
--    写入时机：流式结束（成功或失败）后一次性写，流式过程中禁止写库
--              （better-sqlite3 是同步 API，会阻塞事件循环）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,              -- epoch 毫秒，请求入队时刻
  trace_id           TEXT    NOT NULL,              -- UUIDv4，排障用；响应 error 带它
  client             TEXT    NOT NULL DEFAULT '未识别',  -- 显示名「快照」：写入当时的识别名。会随密钥改名而过期。
                                                        --   ⚠️ 仅供日志表直接渲染，**禁止**用作分组/过滤/聚合键（一律用 client_id）
  client_rule        INTEGER NOT NULL DEFAULT 4,    -- 1 显式声明 / 2 密钥归属 / 3 UA / 4 兜底
                                                        --   ⚠️ [2026-10-08 更正] 实际**只写 2**。原文写「只写 2/4」是错的：
                                                        --   `/v1` 每个端点都挂了守卫，通过就必设 keyContext，
                                                        --   于是 `keyContext ? 2 : 4` 恒为 2，4 那一支**不可达**
                                                        --   （rule-4 行只出现在测试夹具里）。见 spec-v4-client-id §6 第 1/5 条。
                                                        --   DEFAULT 4 因此也永远不会被用到（插入时总显式给值）。
  client_id          TEXT    NOT NULL DEFAULT 'unidentified',  -- 客户端稳定标识，分组/过滤/聚合的唯一键：
                                                        --   规则 2 -> 该请求所用密钥的 key_id；规则 4 -> 字面量 'unidentified'
  key_id             TEXT,                          -- -> client_keys.id，NULL 表示 env 种子密钥未落库
  key_hint           TEXT,                          -- 冗余一份便于日志表直接渲染，不随密钥改名而变
  model              TEXT    NOT NULL,              -- 映射后的上游 API ID（如 kimi-k2.7）
  model_display      TEXT,                          -- 显示名（如 Kimi-K2.7-Code），可为空
  status             INTEGER NOT NULL,              -- 我们返回给客户端的 HTTP 状态码
  upstream_code      INTEGER,                       -- 上游业务码 11101/11102/11128/11133，无则 NULL
  ms                 INTEGER NOT NULL DEFAULT 0,    -- 总耗时（入队 -> 流结束）
  queued_ms          INTEGER NOT NULL DEFAULT 0,    -- [注意] 本版并发闸**直接 429 不排队**，故此列恒 0（保留以备将来引入排队）
  first_byte_ms      INTEGER,                       -- 首字耗时；NULL = 未收到任何 chunk
                                                    --   [v1.7.3 口径修正] 起点是**body 解析完成**，
                                                    --   不是「发往上游」，也不是「请求进门」。
                                                    --   旧注释写「从发出请求到首字节」是错的（已更正）。
  /* [v1.7.2 / v1.7.3] 首字延迟的归因分段 —— 回答「慢在我方还是上游」。
     全部可空：NULL = 未记录（老行）；**绝不用 0 冒充**（与 credits 可空同一纪律，
     0 是「同毫秒完成」的真实值，与「没测到」不同）。
       ingress_ms       请求进门 → body 就绪（客户端上传 + 解析等待，属**客户端侧**成本）
       auth_ms          body 就绪 → 鉴权完成（KeyGuard：密钥 / IP 策略 / 配额）
       prep_ms          鉴权完成 → 首次发往上游（路由解析 + 目录查找 + 凭证 + 组包）
       upstream_wait_ms 首次发往上游 → 首字节（纯上游侧：排队 + 思考）
     ⇒ 我方开销 = auth_ms + prep_ms（派生量，**不落库**：落冗余列只会不一致）。
     ⚠️ auth_ms 的口径在 v1.7.3 变过：020→v1.7.2 之间的行含上传时间，
        那批行 ingress_ms 为 NULL，可据此识别。 */
  ingress_ms         INTEGER,
  auth_ms            INTEGER,
  prep_ms            INTEGER,
  upstream_wait_ms   INTEGER,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,    -- 缓存命中的 prompt tokens。
                                                    --   ⚠️ 只取 usage.prompt_tokens_details.cached_tokens
                                                    --   （回落 usage.prompt_cache_hit_tokens）；
                                                    --   顶层 usage.cached_tokens **恒 0 是假的，绝不用**。
                                                    --   见 server/src/proxy/usage-tokens.ts（task#62）
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,    -- 输出里的思考（reasoning）tokens，含在
                                                    --   completion_tokens 内（上游计费口径）。真值：
                                                    --   usage.completion_tokens_details.reasoning_tokens
                                                    --   （回落顶层 completion_thinking_tokens）。
                                                    --   v6 新增（2026-10-07）：拆开展示「思考/正文」。
  credits            REAL,                         -- [v0.5.8] **可空**：NULL = 上游未回报该次费用（未知）。
                                                    --   ⛔ 绝不用本地公式补数（反代项目铁律：一切以上游真实返回为准）。
                                                    --   已按 api-contract §2.1.6 四舍五入到 2 位。
  stream             INTEGER NOT NULL DEFAULT 1,    -- 客户端原始请求是否流式（1/0）
  retry_count        INTEGER NOT NULL DEFAULT 0,
  note               TEXT    NOT NULL DEFAULT '',   -- 逗号分隔标记，见下方 note 取值表
  remote_ip          TEXT,                          -- 来源 IP（自用场景，保留用于识别与排障）
  ua                 TEXT,                          -- User-Agent（用于 UA 关键词表匹配与补录）
  request_body       TEXT,                          -- 仅 logs.recordRequestBody=true 时写
  response_body      TEXT,                          -- 仅 logs.recordResponseBody=true 时写
  created_at         INTEGER NOT NULL,              -- epoch 毫秒，落库时刻
  provider_id        TEXT,                          -- [v1.6.30] 本次请求**实际路由到**的提供商 id。
                                                    --   NULL = 本列引入前的老行，或模型解析前即被本地拒绝。
                                                    --   ★ 为什么存事实而不是事后反解：同一模型 id 可能同时存在于
                                                    --     两家目录（MiniMax-M2.7 / M3 / M3.1 实测如此），
                                                    --     目录反解按「创建序先到先得」，而路由按「密钥绑定优先」——
                                                    --     两者不一致时统计会静默记到错误的那家，且无字段可查。
                                                    --   ★ 不加外键：提供商删除后历史用量仍应显示；归属是当时的事实快照。

  FOREIGN KEY (key_id) REFERENCES client_keys(id) ON DELETE SET NULL
);

-- note 取值（可多值，逗号分隔，顺序不重要）：
--   [注意] 这里**不再逐个列举**取值。原因是这份枚举曾与实现漂移：它列过 `model_alias` / `queued`
--   这类**契约里根本不存在、代码也不写**的 token，同时漏掉了后来新增的一批 —— 而读这份注释的人
--   会把它当成事实。**`note` 的写入侧唯一事实来源是契约 `api-contract.md` §2.1.6**（含动态取值族
--   `max_tokens_raised_<n>_to_<m>`、`upstream_<上游业务码>`）；门禁 `web/scripts/check-note-tokens.mjs`
--   机械比对「契约 ∪ 代码」是否都有可读映射。**改 token 请改契约，不要回来补这份清单。**

CREATE INDEX IF NOT EXISTS idx_requests_ts          ON requests(ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_id_ts ON requests(client_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts    ON requests(model, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_key_ts      ON requests(key_id, ts DESC);
-- [v0.4.35] 最大 IP 数判定按 (key_id, remote_ip) 去重计数 —— 每个入站请求都要查，必须有索引
CREATE INDEX IF NOT EXISTS idx_requests_key_ip      ON requests(key_id, remote_ip);
CREATE INDEX IF NOT EXISTS idx_requests_status_ts   ON requests(status, ts DESC);
-- 说明：MVP 阶段只建这 5 个。数据量 < 10 万条，LIKE 模糊查询走 idx_requests_model_ts 已够；
--       查询真的慢了再加，不预先铺复合索引。
--       v3：分组键由 client（名字）改为 client_id（稳定 id），idx_requests_client_ts 随之退役，
--           换成 idx_requests_client_id_ts（迁移见 design/migrations/003-client-id.sql）。

-- -----------------------------------------------------------------------------
-- 2. aggregates —— 预聚合（增量维护的物化结果）
--    权威源始终是 requests。写入时机：与 requests 插行在同一事务内 upsert。
--    bucket 格式：小时 'YYYY-MM-DDTHH'（本地时区）· 天 'YYYY-MM-DD'
--
--    [2026-10-08 更正] 本表**当前没有任何生产读方**。原文写的是「控制台趋势图与构成图的
--    唯一读源」—— 那不是事实，且已经误导过一次排障：控制台的趋势/构成图走的是
--    `api/overview.service.ts` 对 requests 表的即时聚合（理由见该文件头：天桶没有
--    model/client 维度，两个数据源必然漂移）。`AggregatesRepository.trend()` 调用方为零。
--
--    那它为什么还留着？因为它不是死数据，而是 `tools/verify-all.mjs` 的 **A11 一致性闸**的
--    对照物：`requests` 合计必须等于本表日桶合计。两条独立的记账路径互相校验 ——
--    增量 upsert 的累加逻辑写错时，只有这条闸会红。
--    ⇒ **别删它，也别以为它在提速**。改 upsert 口径时 A11 就是那个会响的警报。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aggregates (
  bucket             TEXT    NOT NULL,   -- '2026-10-03T14' | '2026-10-03'
  dim                TEXT    NOT NULL,   -- 'model' | 'client' | 'status' | 'total'
  dim_value          TEXT    NOT NULL,   -- 'kimi-k3' | 'k_3f9a21c7'（client_id，非名字）| '200' | '-'
  requests           INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,   -- status >= 400
  credits            REAL    NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,   -- 缓存命中 prompt tokens 的累计（口径同 requests.cached_tokens）
  total_ms           INTEGER NOT NULL DEFAULT 0,   -- 用于算平均耗时：total_ms / requests
  updated_at         INTEGER NOT NULL,

  PRIMARY KEY (bucket, dim, dim_value)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_aggregates_dim_bucket ON aggregates(dim, bucket);

-- -----------------------------------------------------------------------------
-- 3. client_keys —— 本机入站密钥
--    SPEC §6：只存 hash，不明文。明文仅在 POST /api/keys 的响应里出现一次。
--    补列说明（超出 SPEC 最小集的必要补充）：
--      key_hint   没有它就无法渲染 'sk-waygate-4f9c…7a2e'（SPEC §6 要求界面只显首尾各 4 位）。
--                 ⚠️ key_hint 是**签发时快照**。更名期（sk-relay- → sk-waygate-）签发的旧行
--                 会保留旧前缀；2026-10-11 晚存量密钥已全部重签，本库不再有旧前缀行
--                 （见 auth/keys.ts 文件头：旧前缀已退役，不再被接受）。
--      source     区分控制台创建与环境变量种子，避免启动时把用户删掉的 env 密钥复活
--      expires_at 密钥三态（启用 / 已停用 / 已过期）需要它
--
--    key_hash 算法：base64url(HMAC_SHA256(RELAY_SECRET, 完整密钥))
--      用 HMAC 而非裸 SHA256：库文件万一泄漏，没有 RELAY_SECRET 也做不了离线撞库。
--      24 位十六进制 = 96 bit 熵，不需要慢哈希（慢哈希会让每请求鉴权变慢）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_keys (
  id            TEXT    PRIMARY KEY,                -- 'k_' + 8 位随机 hex
  name          TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,            -- HMAC-SHA256，见上
  key_hint      TEXT    NOT NULL,                   -- 'sk-waygate-4f9c…7a2e'（签发时快照，见上方补列说明）
  scope         TEXT    NOT NULL DEFAULT '{"type":"all"}',  -- JSON：all|family|tag|models
  client        TEXT,                               -- 首选提供商名（= clients[0]，识别规则第 2 级用它归因）
  clients       TEXT    NOT NULL DEFAULT '[]',      -- [v0.4.29] 绑定的提供商有序数组（JSON），第 1 项优先
  ip_whitelist  TEXT    NOT NULL DEFAULT '[]',      -- [v0.4.35] IP 白名单（JSON 数组：IPv4/IPv6 精确 + IPv4 CIDR）；空 = 不限
  max_ips       INTEGER,                            -- [v0.4.35] 最大 IP 数：这把密钥历史上最多允许几个不同来源 IP；NULL = 不限
  token_quota   INTEGER,                            -- [v0.4.35] Token 配额：累计 total_tokens 上限（入站软校验）；NULL = 不限
  enabled       INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,                            -- epoch 毫秒；NULL = 长期有效
  source        TEXT    NOT NULL DEFAULT 'console', -- 'console' | 'env'
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  last_seen_ip  TEXT,

  CHECK (enabled IN (0, 1)),
  CHECK (source  IN ('console', 'env'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_keys_hash ON client_keys(key_hash);
CREATE INDEX        IF NOT EXISTS idx_client_keys_enabled ON client_keys(enabled);

-- -----------------------------------------------------------------------------
-- 4. model_catalog —— 模型表（运行时可刷新）
--    策略：上游拉取优先 / 本地种子回落 / 再并上「实际请求过的模型」（ADR-004 + task#18）。
--    种子数据来自 design/model-catalog.json（17 项，2026-10-03 逐个实测 HTTP 200），
--    随本文件播种。
--    补列说明：
--      family    id 的第一个 '-' 分段（kimi-k2.7 -> kimi）。scope='family' 判定需要它，
--                每次请求现算会拖慢热路径，落表更划算。
--      verified  上次实测是否通过。上游 11102 时标 0，但不删除（订阅以后可能又开）。
--      enabled   人为下架某个模型（控制台可切），与 verified 是两个独立维度。
--    v4 变更（迁移 004）：
--      source    由三态扩为四态，新增 'observed'（实际成功调用过，来自 requests.status=200）。
--                [v1.5.0] observed 机制已废除（目录 = 上游清单接口）——列取值保留兼容历史行。
--      multiplier 改为可空：v4 时上游目录不含倍率字段，本地映射表缺失时存 NULL = 「倍率未知」，
--                绝不编造一个 1.0 冒充真实倍率。
--                （v0.2.1 起 /v3/config 提供接口真实倍率并权威覆盖，见 catalog/v3-config.ts；
--                 NULL 仅剩「接口与快照都无该模型」一种含义。）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_catalog (
  provider_id      TEXT    NOT NULL,                -- [v0.5.1] -> providers.id：清单属于哪家（多提供商同时生效）
  id               TEXT    NOT NULL,                -- API ID，如 'kimi-k2.7'（主键的一半）
  display_name     TEXT    NOT NULL,                -- 显示名，如 'Kimi-K2.7-Code'
  family           TEXT    NOT NULL,                -- 'kimi' | 'glm' | 'deepseek' | 'hy4' …
  tag              TEXT,                            -- 限时免费 / 限时折扣 / 夜间折扣 / 订阅优先
  multiplier       REAL,                            -- 计费权重；0.00 = 窗口期内免费；NULL = 倍率未知
  source           TEXT    NOT NULL DEFAULT 'seed', -- 'upstream' | 'seed' | 'observed'(v1.5.0 废除,仅历史行) | 'manual'
  verified         INTEGER NOT NULL DEFAULT 0,      -- 1 = 最近一次实测通过
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  CHECK (source  IN ('upstream', 'seed', 'observed', 'manual')),
  CHECK (verified IN (0, 1)),
  CHECK (enabled  IN (0, 1)),
  PRIMARY KEY (provider_id, id)
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_display  ON model_catalog(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_model_catalog_enabled  ON model_catalog(enabled);
CREATE INDEX IF NOT EXISTS idx_model_catalog_provider ON model_catalog(provider_id);

-- -----------------------------------------------------------------------------
-- 5. admin_credential —— 控制台管理口令（v2 新增）
--
--    为什么放数据库而不是 data/admin.hash 文件：
--      口令哈希跟着 relay.db 一起进每日备份（`VACUUM INTO`），换机恢复时
--      不会漏拷一个单独的 hash 文件 —— 这是文件方案唯一但很实在的短板。
--
--    为什么用 id=1 的单行表而不是 key-value：
--      口令是**唯一且必须存在**的一条记录，用固定主键表达这个约束，
--      比在 KV 表里靠约定 key 名更不容易写错（UNIQUE(id) + CHECK 保证只有一行）。
--
--    ⚠️ 只存 scrypt 哈希，明文永不落盘、永不进日志。
--       存储串格式：scrypt$N$r$p$<salt_b64url>$<hash_b64url>（见 auth/password.ts）
--
--    来源优先级（见 AdminCredentialService）：
--      1. 环境变量 RELAY_ADMIN_PASSWORD_HASH（运维显式设定，最高）
--      2. 本表
--      3. 都没有 → 首次启动生成随机口令，写本表并打印一次
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_credential (
  id          INTEGER PRIMARY KEY CHECK (id = 1),    -- 恒为 1：单行表
  hash        TEXT    NOT NULL,                      -- scrypt 存储串，绝不放明文
  source      TEXT    NOT NULL DEFAULT 'generated',  -- 'generated' | 'console'
  updated_at  INTEGER NOT NULL,                      -- epoch 毫秒
  rotated_at  INTEGER,                               -- 最近一次主动改密时刻（首次生成为 NULL）

  CHECK (source IN ('generated', 'console'))
);

-- -----------------------------------------------------------------------------
-- 6. providers —— 上游提供商（v7 新增 · 2026-10-08「自定义提供商」）
--
--    形态是**多个已配置、单活**：N 行登记，恰有一行 active=1。
--    激活时由服务层把该行 base_url 写进 settings.upstream.baseUrl、
--    把该提供商的凭证文件载入 config.upstreamKey —— 代理热路径不改。
--
--    凭证**不在本表**：沿用「只写不可读」纪律，每提供商一个文件
--    <RELAY_DATA_DIR>/providers/<id>.key（600，原子写）。
--
--    首次启动若表为空，由 ProvidersService.ensureSeeded() 用现有
--    settings.upstream.baseUrl + upstream.key 种子出默认行（幂等）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT    PRIMARY KEY,             -- 'p_' + 8 位随机 hex
  name       TEXT    NOT NULL,                -- 人话名（如 WorkBuddy / 某订阅）
  base_url   TEXT    NOT NULL,                -- 上游基地址（https://…，不带尾斜杠）
  active     INTEGER NOT NULL DEFAULT 0
             CHECK (active IN (0, 1)),        -- 恰有一行为 1（服务层维护）
  protocol   TEXT    NOT NULL DEFAULT 'openai'
             CHECK (protocol IN ('openai', 'anthropic', 'qoder', 'custom')),  -- [v0.5.0] 上游方言；[v1.7.0] 新增 custom
                                                            --   （WorkBuddy=openai / mavis=anthropic / Qoder CN=qoder /
                                                            --    custom=任意 OpenAI 兼容端点，静态 API key 鉴权）
  chat_path  TEXT,                            -- [v0.5.0] 聊天端点路径；NULL = 协议默认
  cred_kind  TEXT    NOT NULL DEFAULT 'static'
             CHECK (cred_kind IN ('static', 'oauth_minimax')),  -- [v0.5.0] 凭证生命周期类型
  access_expires_at INTEGER,                  -- [v0.5.0] oauth access token 过期时刻（epoch ms；只存时间不存令牌）
  signin_checked_on  TEXT,                    -- [v0.5.6] 最近成功签到的本地日期（Asia/Shanghai）—— 当日幂等闸
  signin_streak      INTEGER,                 -- [v0.5.6] 连续签到天数（面板 day_no，仅展示）
  signin_last_points INTEGER,                 -- [v0.5.6] 最近一次领到的积分（仅展示）
  wb_signin_checked_on   TEXT,                -- [v1.3.0] WorkBuddy 最近成功签到日期 —— 当日幂等闸（与 MiniMax signin_* 分列：签到语义不同源）
  wb_signin_streak       INTEGER,             -- [v1.3.0] WorkBuddy 连签天数（checkin-activity-status.streak_days）
  wb_signin_last_points  INTEGER,             -- [v1.3.0] WorkBuddy 最近一次签到积分（daily_credit）
  wb_oauth_expires_at   INTEGER,              -- [v1.4.0] WorkBuddy OAuth access 过期时刻（epoch ms；令牌在 providers/<id>.oauth 文件）
  created_at INTEGER NOT NULL,                -- epoch 毫秒
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(active);

-- -----------------------------------------------------------------------------
-- 7. provider_model_prefs —— 按提供商记住模型的启用/停用（v8 新增 · 2026-10-08）
--
--    切换提供商会清空重建 model_catalog（旧清单对新上游是错的），用户对旧清单
--    做的启停选择随之丢失。本表各存一份，切回来时恢复 —— 把"单活"模型的
--    固有代价消掉一层（完整解法是多活路由，那是下一阶段）。
--
--    快照时机 = 切走那一刻（catalog-sync 的 resyncAfterProviderSwitch 开头）；
--    恢复时机 = 新提供商的目录拉取合并之后（上游已下线的模型自然落空）。
--
--    无外键到 providers：偏好行可以比提供商行活得久，删提供商时服务层连带清理。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_model_prefs (
  provider_id TEXT    NOT NULL,             -- -> providers.id
  model_id    TEXT    NOT NULL,             -- model_catalog.id
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at  INTEGER NOT NULL,             -- epoch 毫秒
  PRIMARY KEY (provider_id, model_id)
) WITHOUT ROWID;

-- =============================================================================
-- [v0.5.1] 内置模型种子已移至代码侧（catalog/seed-models.ts，由 providers.service
--           在默认提供商创建后调用）—— provider_id NOT NULL 后建表期的静态 INSERT
--           会被 INSERT OR IGNORE 静默吞掉（NOT NULL 冲突），种子全灭。

-- =============================================================================
-- 常用维护语句（不自动执行，供运维与迁移脚本引用）
-- =============================================================================

-- 日志保留清理：按 logs.retainDays 每日一次，与 aggregates 过期 bucket 一起清
-- DELETE FROM requests   WHERE ts < (strftime('%s','now','-30 days') * 1000);
-- DELETE FROM aggregates WHERE bucket < strftime('%Y-%m-%d','now','-30 days');

-- 聚合重算（控制台发现口径不一致时的修复入口，属危险操作）
-- ★ 实际操作请用 tools/cleanup-test-requests.mjs：含全量备份、行数守卫与
--   **全维度**（model/client/status/小时 total/天 total）重算，与 requests.repo.log()
--   的增量口径逐字对齐 —— 下面这段只示范 model 维度，手跑会缺维度。
-- DELETE FROM aggregates;
-- INSERT INTO aggregates (bucket, dim, dim_value, requests, errors, credits,
--                         prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
-- SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime'), 'model', model,
--        COUNT(*), SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),
--        SUM(credits), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(ms),
--        (CAST(strftime('%s','now') AS INTEGER) * 1000)
--   FROM requests GROUP BY 1, 3;

-- 一致性自检（发布前跑，三者必须相等，见 api-contract §3.4）
-- SELECT (SELECT ROUND(SUM(credits),2) FROM requests WHERE ts > ?) AS raw,
--        (SELECT ROUND(SUM(credits),2) FROM aggregates
--          WHERE dim='model' AND bucket > ?) AS agg;

-- 备份（在线热备，不锁写）
-- VACUUM INTO 'data/backup/relay-20261003.db';
