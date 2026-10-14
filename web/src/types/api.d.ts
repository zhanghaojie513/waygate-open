/**
 * 前后端共享的接口类型契约。
 * 依据：design/openapi.yaml（15 path / 19 schema） + design/api-contract.md §3。
 * 改动必须双方同步 —— 类型不一致应在编译期就红。
 */

/** /api/* 统一信封。code = 0 为成功。 */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  message: string;
  traceId?: string | null;
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/* ---------------- 认证 ---------------- */

export interface SessionState {
  authenticated: boolean;
  expiresAt: string | null;
}

export interface LoginResult {
  expiresAt: string;
}

export interface LoginRateLimited {
  retryAfterSeconds: number;
}

/* ---------------- 概览 ---------------- */

/** 额度端点未接入时 available=false，前端必须渲染 "--" + message，禁止编造数字。 */
export interface QuotaState {
  available: boolean;
  reason: 'quota_endpoint_not_configured' | 'quota_endpoint_error' | 'ok';
  remain: number | null;
  total: number | null;
  resetAt: string | null;
  stale: boolean;
  message: string;
}

export interface OverviewMetrics {
  requests: number;
  /**
   * 本窗口积分合计 —— **只含上游实扣**（`usage.credit`）。
   * 上游未回报的行（`credits IS NULL`）不计入，条数见 `creditsUnknownCount`。
   */
  creditsUsed: number;
  successRate: number;
  avgLatencyMs: number;
  activeClients: number;
  /** 本窗口输入（prompt）tokens 合计（task#62，替换不可得的订阅积分）。 */
  promptTokens: number;
  /** 本窗口输出（completion）tokens 合计。 */
  completionTokens: number;
  /** 本窗口总 tokens 合计。 */
  totalTokens: number;
  /** 本窗口缓存命中的 prompt tokens 合计。 */
  cachedTokens: number;
  /**
   * 缓存命中率 = cachedTokens / promptTokens，**取值 0..1**。
   *
   * ⚠️ **为 0 就是 0**（DeepSeek 系上游真实返回 `cached_tokens: 0`），这是真值，不是
   * 「上游未提供」—— 界面必须渲染成 `0.0%`，**不得**回退到任何「未提供」文案。
   */
  cacheHitRate: number;
  /**
   * [v0.5.8] 本窗口「上游未回报积分」的请求条数（`credits IS NULL`）。
   * 必须与 `creditsUsed` 一起展示 —— 否则合计看起来像全部消耗，其实只是已知部分。
   */
  creditsUnknownCount: number;
}

export interface TrendPoint {
  bucket: string;
  requests: number;
  credits: number;
  /** [v0.5.11] 本桶总 tokens —— 趋势图的主量纲（积分对 MiniMax 是未知/免费，token 才普适）。 */
  tokens: number;
  errors: number;
  /**
   * [v0.5.11] 本桶内按模型 token 消耗的前几名（服务端排好序、取前 5）。
   * tooltip 用 —— 回答「这个时段的 token 花在哪些模型上」；完整明细在按模型表。
   */
  models: Array<{ model: string; tokens: number }>;
}

export interface BreakdownItem {
  model: string | null;
  displayName: string | null;
  /**
   * 客户端的**稳定标识**（`spec-v4-client-id.md` §5）：rule-2 行 = 所用密钥的 `key_id`，
   * rule-4 行 = `'unidentified'`。
   *
   * ⛔ 只当键用（分组 / 过滤 / 比较），**不上屏** —— 用户看不懂 `k_3f9a21c7`（AC-C07）。
   * 模型维度的行（`byModel`）这里是 `null`。
   */
  clientId: string | null;
  /**
   * 客户端的**显示名**。它会随改名而变，所以**不能拿它当键** ——
   * 改名后按名字匹配会静默失配（AC-C06）。
   */
  client: string | null;
  requests: number;
  /** [v0.5.2] 本组总 tokens（prompt+completion）。byModel/byClient 都带。 */
  tokens?: number;
  /**
   * 本组积分（上游实扣）。
   *
   * [v0.6.4] **可空** —— byModel 行在「窗口内该模型全部请求都未回报 credit」时为 `null`
   * （MiniMax 系实测：usage 里没有 credit 字段，只扣账本）。前端渲染 `--` 并指引到账本，
   * **不得**当成 0（0 会被读成免费，与事实相反）。
   */
  credits: number | null;
  /**
   * [v0.6.4] 该行「上游未回报积分」的请求条数（仅 byModel 带）。
   * `credits === null` 时用它说明原因（「N 条均未回报」）。
   */
  creditsUnknownCount?: number;
  /**
   * **Token 占比**（分母 = 窗口 tokens 合计）。[v0.5.18 改口径] 原为积分占比。
   *
   * 用量页与概览页的模型/客户端表**都按 tokens 排序**，占比若按积分算就会错位：
   * 百分比自上而下不单调、条形长度与排序顺序互相矛盾（用户实测报障）。
   * 故统一为 token 占比 —— 与排序键、与条形长度同源。
   */
  share: number;
  /**
   * [v0.5.21] 该客户端消耗的**模型切片**（按 tokens 降序取前 5）。
   * 供「按客户端」模块的悬停提示回答「这个客户端的量花在哪些模型上」。
   * 仅 `byClient` 带此字段（服务端 CLIENT_MODEL_SLICE 截断）。
   */
  models?: Array<{
    model: string;
    displayName: string | null;
    requests: number;
    tokens: number;
    credits: number;
  }>;
  /** [v0.5.21] 该客户端命中的**真实模型数**（可能 > models.length，用于如实标注截断）。 */
  modelCount?: number;
  /**
   * 该模型的计费倍率。**仅模型维度（`byModel`）的行带此字段**，客户端维度为 `undefined`。
   *
   * `null` = **倍率未知**（本地倍率表缺这一项）。[v0.5.8] 它**只描述倍率本身**：
   * 积分一律取上游实扣（`usage.credit`），**不再依赖倍率**，所以倍率未知**不代表**
   * 该行积分是估的 —— 积分可不可信只看 `credits` 是不是 `null`。
   * 界面上仍应把 `null` 标成「倍率未知」，但**不得**显示成某个具体倍率（如 1.0）。
   */
  multiplier?: number | null;
  /**
   * 模型的计价标签（限时免费 / 限时折扣 / 夜间折扣 / 订阅优先），`null`/缺省 = 无标签。
   * 仅 `byModel` 的行带此字段 —— **这是「这行为什么便宜」的直接答案**。
   */
  tag?: string | null;
}

/**
 * 按「请求来自哪个工具」聚合的一行（`identify/ua-table.ts` 从 `requests.ua` 现解析）。
 *
 * 与 `byClient` 回答的是**两个不同的问题**：`byClient` 是「哪把密钥进来的」，
 * 本类型是「哪个工具发的」。同一把密钥被多个工具共用时，两者才会分开 ——
 * 那正是需要在界面上看见的情形。
 *
 * `tool` 为 `null` = UA 认不出来（没采到 / 不在关键词表里）—— 渲染成「未识别」，不编造。
 */
export interface ToolBreakdownItem {
  tool: string | null;
  requests: number;
  /** [v0.5.18] 本工具总 tokens —— 与 byModel/byClient 同口径。 */
  tokens: number;
  credits: number;
  /** **Token 占比**（与 byModel/byClient 同口径）。 */
  share: number;
}

export interface OverviewProvenance {
  creditsUsed: string;
  quotaRemain: string;
  note: string;
}

export interface OverviewData {
  window: TimeWindow;
  generatedAt: string;
  /** 固定窗口（最近 1 小时）的告警块，不随 window 参数变化（api-contract §3.4）。 */
  alerts: {
    /** 上游渠道校验（11128）拒绝次数与横幅阈值；count ≥ threshold 时概览页展示告警横幅。 */
    channelReject: { count: number; threshold: number };
  };
  quota: QuotaState;
  /** [v0.5.7] 各提供商的**真实**积分账本（MiniMax 有；WorkBuddy 上游未提供）。 */
  creditLedgers: CreditLedgerBlock[];
  metrics: OverviewMetrics;
  trend: TrendPoint[];
  byModel: BreakdownItem[];
  byClient: BreakdownItem[];
  /** [2026-10-08] 按「请求来自哪个工具」聚合（从 `ua` 现解析）。见 `ToolBreakdownItem`。 */
  byTool: ToolBreakdownItem[];
  /**
   * [2026-10-08] 认不出来的 UA 原文 + 请求数（TOP 10）—— `byTool` 里 `tool: null` 那桶的证据。
   * 空 UA 不在此列（那是「压根没采到」，不是「某个未知工具」）。
   */
  unknownUas: Array<{ ua: string; requests: number }>;
  recent: RequestLogRow[];
  provenance: OverviewProvenance;
}

/** [2026-10-08] 新增 'today'：本地零点到现在（日历日语义，不是滚动 24h）。 */
export type TimeWindow = 'today' | '1h' | '24h' | '7d' | '30d';

/* ---------------- 请求日志 ---------------- */

export interface RequestLogRow {
  id: number;
  ts: string;
  /**
   * 客户端**稳定标识**（rule-2 = 该请求所用密钥的 `key_id`；rule-4 = `'unidentified'`）。
   * 过滤 / 分组 / 比较一律用它（AC-C06）。⛔ 不上屏（AC-C07）。
   */
  clientId: string;
  /** 客户端显示**快照** —— 只用于渲染，不随密钥改名回填（`spec-v4-client-id.md` §4）。 */
  client: string;
  model: string;
  modelDisplay: string;
  status: number;
  upstreamCode: number | null;
  ms: number;
  queuedMs: number;
  firstByteMs: number | null;
  promptTokens: number;
  completionTokens: number;
  /** [v0.2.0] 输出里的思考 tokens（含在 completionTokens 内；旧行/未回报为 0）。 */
  reasoningTokens: number;
  /**
   * [2026-10-08] 缓存命中的输入 tokens。**为 0 就是 0**（真值，不是「上游未提供」）。
   *
   * 之所以要逐行看它：这是「这条为什么便宜」的答案 —— 上游对命中缓存的部分按缓存价
   * 计费，已体现在 `credits` 里（[v0.5.8] 本服务不再自设折扣系数）。
   * 此前只有窗口聚合值，看不出单条。
   */
  cachedTokens: number;
  /**
   * [v0.5.8] 本行积分 = 上游实扣（`usage.credit`）。
   * **`null` = 上游未回报该次费用（未知），不是 0** —— 界面渲染 `--`（`formatCredits`），
   * 并保留 `note` 里的 `credits_unknown` 供排查。本服务**不估算**。
   */
  credits: number | null;
  stream: boolean;
  retryCount: number;
  note: string;
  keyHint: string;
  /**
   * [2026-10-08] 从 `ua` 解析出的**工具名**（如 `Claude Code`），`null` = 认不出来。
   *
   * ⚠️ 显示用的**派生字段**，不是身份：`clientId` 仍是「哪把密钥」（`spec-v4-client-id.md` §2
   * 的不变量）。`byClient` 与 `clientId` 回答「哪把密钥进来的」，本字段回答「哪个工具发的」——
   * 同一把密钥被多个工具共用时两者才会分开。
   */
  tool: string | null;
  /**
   * [2026-10-09] 客户端发来的 User-Agent **原文**。
   *
   * 列表接口一直在返回它（`requests.service` 的 SELECT 里有 `r.ua`），只是此前前端类型
   * 没声明、表格没渲染 —— 于是界面只给出 `tool` 这个**判定结果**，不给依据。
   * 判定会错、也会随关键词表变化（实测 `ZCode/3.14.5 … runtime/node.js` 被判成 Node.js），
   * 只显示结论时用户无法判断"这个 Node.js 到底是谁"。UA 原文才是可行动的信息。
   */
  ua: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content: string;
}

export interface RequestDetail extends RequestLogRow {
  totalTokens: number;
  /** 命中的识别规则（1 显式声明 / 2 密钥归属 / 3 UA / 4 兜底）。当前只会是 2 或 4。 */
  clientRule: number;
  keyId: string | null;
  /**
   * 来源 IP。**服务端只监听回环**，所以这里取的是 nginx 覆写后的 XFF 末段
   * （见 `server/src/common/client-ip.ts`）；直连时为 `127.0.0.1`。
   */
  remoteIp: string | null;
  /** 客户端发来的 User-Agent 原文。`tool` 就是由它解析出来的（认不出为 `null`）。 */
  ua: string | null;
  messages: ChatMessage[];
  assistantPreview: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

/* ---------------- 密钥 ---------------- */

export type KeyScope =
  | { type: 'all' }
  | { type: 'family'; value: string }
  | { type: 'tag'; value: string }
  | { type: 'models'; value: string[] };

export interface ClientKeyRow {
  id: string;
  name: string;
  hint: string;
  scope: KeyScope;
  /** 首选提供商（= clients[0]）。 */
  client: string | null;
  /** [v0.4.20] 绑定的提供商有序数组，第 1 项优先级最高。 */
  clients: string[];
  /** [v0.4.35] IP 白名单（归一化条目：IPv4/IPv6 精确 + IPv4 CIDR），空 = 不限。 */
  ipWhitelist: string[];
  /** [v0.4.35] 最大 IP 数，null = 不限。 */
  maxIps: number | null;
  /** [v0.4.35] Token 配额（累计 total_tokens 上限），null = 不限。 */
  tokenQuota: number | null;
  /** [v0.4.35] 累计用量（仅设了限额的密钥返回）：不同来源 IP 数 / 累计 tokens。 */
  usedIps: number;
  usedTokens: number;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  requests24h: number;
}

/** POST /api/keys 的响应：明文只出现这一次。 */
export interface CreatedKey extends ClientKeyRow {
  key: string;
  warning: string;
}

export interface CreateKeyInput {
  name: string;
  scope: KeyScope;
  /** [v0.4.20] 绑定的提供商有序数组（第 1 项优先级最高）。优先于 client。 */
  clients?: string[];
  client?: string | null;
  /** [v0.4.35] IP 白名单（逐条校验：IPv4/IPv6/CIDR），空数组 = 不限。 */
  ipWhitelist?: string[];
  /** [v0.4.35] 最大 IP 数（正整数），空 = 不限。 */
  maxIps?: number | null;
  /** [v0.4.35] Token 配额（正整数），空 = 不限。 */
  tokenQuota?: number | null;
  expiresAt?: string | null;
}

/* ---------------- 客户端 ---------------- */

export interface ClientRow {
  /**
   * 客户端**稳定标识**（`spec-v4-client-id.md` §2）。
   * React key / 跳转参数 / 过滤值一律用它（AC-C06）。⛔ 不上屏（AC-C07）。
   */
  clientId: string;
  /** 显示名。改名只改它，**不动 `clientId`** —— 统计与筛选结果因此不受影响（AC-C01）。 */
  client: string;
  rule: 1 | 2 | 3 | 4;
  ruleLabel: string;
  requests: number;
  credits: number;
  models: string[];
  lastSeenAt: string | null;
  boundKeyIds: string[];
  named: boolean;
}

/**
 * [v0.6.0] 提供商维度用量（`GET /api/clients` 与 items 同窗口返回）。
 * 归因与请求日志「提供商」列同源：模型 id → 生效目录的 provider。
 * `providerId/provider` 为 null 的桶 = 窗口内请求的模型不在任何生效目录里（不冒充任何一家）。
 */
export interface ProviderUsageRow {
  providerId: string | null;
  provider: string | null;
  requests: number;
  tokens: number;
  credits: number;
  lastSeenAt: string | null;
}

/* ---------------- 设置 ---------------- */

export type SettingType = 'text' | 'number' | 'switch' | 'select' | 'badge' | 'action' | 'mapping';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingItem {
  key: string;
  label: string;
  value: unknown;
  type: SettingType;
  why: string;
  options?: SettingOption[];
  readonly?: boolean;
  requiresRestart?: boolean;
  tone?: 'normal' | 'warn';
  /**
   * [2026-10-08] 这一项**当前不产生任何行为**（依赖的功能未实现，或上游接口未供货）。
   *
   * 与 `readonly` 不是一回事：`readonly` = 改不了，`noop` = 改了也白改。
   * 前端据此把这些项收进「暂未生效」区 —— 不依赖用户去读 `why` 里那半句提醒
   * （十几项平铺的长列表里，那半句会被完全跳过）。
   */
  noop?: boolean;
}

export interface SettingGroup {
  id: string;
  label: string;
  items: SettingItem[];
}

export interface SettingsData {
  groups: SettingGroup[];
  version: number;
}

export interface SettingPatch {
  key: string;
  value: unknown;
}

export interface PutSettingsResult {
  requiresRestart: boolean;
  applied: number;
  version: number;
}

export type DangerAction = 'clearLogs' | 'resetKeys' | 'restoreDefaults';

export interface DangerResult {
  affected: { logs?: number; keys?: number | null };
}

/**
 * `PUT /api/settings/credential`（api-contract §3.8.1）的响应。
 *
 * 注意：**请求里带明文 `ck_…`，响应里只有掩码**。这是刻意的安全边界 ——
 * 上游访问密钥是出站密钥，任何能读回它的接口都等于密钥泄露通道。
 */
export interface CredentialUpdateResult {
  /** 掩码形态，如 `ck_x••••3f7a` */
  source: string;
  configured: boolean;
  /** true = 已落盘，重启后仍有效；false = 仅内存（数据目录不可写的环境） */
  persisted: boolean;
  /**
   * 落盘路径，便于排查。不含敏感内容。
   *
   * 落在 `RELAY_DATA_DIR` 下的 `upstream.key`（部署时即
   * `/var/lib/relay/upstream.key`），**不是** `.env` ——
   * systemd 的 `ProtectSystem=strict` 不允许进程写自己的 `.env`。
   */
  path: string;
}

/**
 * `POST /api/settings/credential/test` 的响应。
 *
 * 这是「先验后存」的落点：`PUT` 的上游访问密钥只写不可读，所以填错后没有任何
 * 自查手段。这条端点用一把**尚未保存**的 key 打一次最小请求，
 * 把「上游认不认这把上游访问密钥」这一个结论带回来。
 *
 * [注意] 响应里**不含**上游访问密钥的任何片段 —— 服务端不落盘、不回显。
 */
export interface CredentialTestResult {
  /** 上游是否接受了这把上游访问密钥。 */
  ok: boolean;
  /** 用哪个模型探的（便于理解为什么某个模型会失败）。 */
  model: string;
  /** 往返耗时（毫秒），让用户对上游快慢有感知。 */
  elapsedMs: number;
  /**
   * 上游的 5 位业务码。
   *
   * 关键区别：**11102 = 当前账号无此模型**，与「上游访问密钥无效」是两回事 ——
   * 前者说明 key 是好的、只是没订阅这个模型。前端必须分开成两种文案，
   * 否则用户会以为自己的 key 填错了而去反复重填。
   * 网络层失败（DNS / 超时）为 null。
   */
  upstreamCode: number | null;
  /**
   * 上游返回的 HTTP 状态码。
   *
   * **只有「根本没拿到响应」（fetch 抛异常 / 超时 / 中断）时才为 `null`**；
   * 拿到了响应就填真实状态码（**2xx 也填，不填 null**）。
   *
   * 为什么必须有它：`upstreamCode === null` 有**两种**来源 —— 真·网络失败，与
   * 「上游回了 401/403、但 body 里没有可提取的数字业务码」。只按 `upstreamCode === null`
   * 分类，会把「密钥被拒」误诊成「网络不通」，让用户去查一个没问题的地址。
   */
  httpStatus: number | null;
  /** 人类可读的失败原因；成功为 null。 */
  reason: string | null;
}

/**
 * `PATCH /api/models/catalog/:id` 的响应。
 *
 * 「停用」只改标志、**不删行** —— 订阅以后可能又开，`verified` 与历史都要留着。
 */
export interface ModelEnabledResult {
  id: string;
  enabled: boolean;
}

/**
 * `POST /api/auth/password/reset`（api-contract §3.1.3）的响应。
 *
 * [注意] `password` 是本接口**唯一一次**把管理口令明文交出来的机会。
 * 服务端不保存明文（库里只有 scrypt 哈希），所以：
 *   - 前端绝不能把它写进 localStorage / sessionStorage / URL
 *   - 弹层关闭即丢弃，不留在任何状态里
 *   - 不做「再次查看」—— 服务端根本没有第二份可回
 */
export interface AdminPasswordResetResult {
  /** 新的管理口令明文，16 字符。只在此响应里出现一次。 */
  password: string;
  /**
   * true = 哈希已落库，重启后仍有效；
   * false = 仅内存生效（数据库不可写），**重启会回到旧口令**。
   */
  persisted: boolean;
}

/**
 * `PUT /api/auth/password`（api-contract §3.1.4）的响应 —— 用户**自定义**管理口令。
 *
 * [注意] 与 `AdminPasswordResetResult` 的关键区别：**不含 `password` 字段**。
 * 口令是用户自己输入的，他本就知道明文；服务端刻意不回显，避免多开一条
 * 明文出现在响应体 / 前端 state / 日志里的通道。
 */
export interface AdminPasswordSetResult {
  /**
   * true = 哈希已落库，重启后仍有效；
   * false = 仅内存生效（数据库不可写），**重启会回到旧口令**。
   */
  persisted: boolean;
}

/* ---------------- 模型目录 ---------------- */

/**
 * 一个「自定义提供商」（api-contract §3.12，2026-10-08）。
 *
 * 形态是**多个已配置、单活**：恰有一个 `active: true`，它决定全局出站上游。
 * 激活由服务端完成三件事（改 active 行 + 载入凭证 + 写 settings 的 baseUrl），
 * 前端只需在成功后刷新模型目录。
 *
 * ⚠️ 凭证**只写不可读**：这里永远只有掩码（`ck_x••••3f7a`）。
 */
/** [v0.5.6] 签到面板（MiniMax Code 每日签到）。 */
export interface ProviderSigninPanel {
  available: boolean;
  reason?: string;
  message?: string;
  claimable?: boolean;
  streak?: number | null;
  todayPoints?: number | null;
  checkedOn?: string | null;
  lastPoints?: number | null;
  days?: Array<{ day_no: number; points: number; status: number; is_today: boolean }>;
}

/** [v0.5.7] 真实积分账本（MiniMax 有；WorkBuddy 上游未提供）。 */
export interface CreditLedgerBlock {
  providerId: string;
  providerName: string;
  available: boolean;
  granted: number | null;
  remaining: number | null;
  consumed: number | null;
  nextExpireAt: string | null;
  /** [v1.6.1] 历史累计消耗（仅 Qoder 用；与余额口径不同，单列以免混淆）。 */
  lifetimeConsumed?: number | null;
  stale: boolean;
  fetchedAt: string | null;
  message: string;
}

export interface GrowthTaskOutcome {
  code: string;
  title: string | null;
  outcome: 'claimed' | 'already' | 'accepted' | 'skipped' | 'error';
  reason?: string;
}

/** [v1.4.4] 任务面板行（GET /api/providers/:id/growth 透传上游 tasks，只读）。 */
export interface GrowthPanelTask {
  code: string;
  title: string | null;
  desc: string | null;
  /** claimed=已领 | in_progress=进行中 | accepted=已接单未完成。 */
  status: string | null;
  progress: { current: number; target: number } | null;
  rewardCredit: number | null;
  rewardEnergy: number | null;
  locked: boolean;
}

export interface GrowthPanelResult {
  ok: boolean;
  tasks: GrowthPanelTask[];
  message?: string;
}

export interface GrowthRunResult {
  ok: boolean;
  signin?: { outcome: string; points: number | null; streak: number | null; message: string };
  tasks?: GrowthTaskOutcome[];
  redeems?: Array<{ tier: string; ok: boolean; detail: string }>;
  creditsGained?: number;
  message?: string;
}

export interface ProviderItem {
  id: string;
  name: string;
  baseUrl: string;
  /** 凭证掩码。`未配置` = 还没填过凭证。 */
  credentialMask: string;
  /** 凭证是否已配置（文件存在且非空）。 */
  configured: boolean;
  /** 是否当前生效（列表里恰有一个 true）。 */
  active: boolean;
  /** [v0.5.0] 上游方言：openai（WorkBuddy）| anthropic（MiniMax mavis / M Plan）。 */
  protocol: 'openai' | 'anthropic' | 'qoder';
  /** [v0.5.0] 凭证生命周期：static（直发）| oauth_minimax（refresh→access）。 */
  credKind: 'static' | 'oauth_minimax';
  /** [v0.5.4] 该提供商自己分区的模型数 / 启用数。 */
  modelCount: number;
  modelEnabled: number;
  /** [v0.5.6] 签到状态（仅 MiniMax Code 客户端订阅有值）。 */
  signin: { checkedOn: string | null; streak: number | null; lastPoints: number | null };
  /**
   * [v1.6.0] Qoder 账本行。
   * [v1.6.1 更正] 上游**有**余额端点（`v2/me/usage`）：granted/remaining/consumed
   * 均为真实值（套餐内 + 资源包合计）；`nextExpireAt` 上游不提供故恒 null。
   * `lifetimeConsumed` 是历史累计消耗（与余额口径不同，单列）。
   */
  qoderCredits: { available: boolean; granted: number | null; remaining: number | null; consumed: number | null; nextExpireAt: string | null; lifetimeConsumed?: number | null; stale: boolean; fetchedAt: string | null; message: string } | null;
  /** [v1.4.1] WorkBuddy 账本行（quota 快照；仅 openai 提供商有，额度接口拉到过才有）。 */
  wbCredits: { remaining: number | null; granted: number | null; consumed: number | null; nextExpireAt: number | null; packages: Array<{ name: string; remain: number; size: number; used: number | null; expireAt: number | null }> } | null;
  /** [v1.4.0] WorkBuddy OAuth 领取域（签到代领/成长任务的前提；configured=已导入 .oauth 槽）。 */
  wbOAuth: { configured: boolean; uidMask: string | null; expiresAt: number | null };
  /** [v1.3.0] WorkBuddy 签到状态（仅 openai 提供商有值；与 MiniMax signin 分开：签到体系不同源）。 */
  wbSignin: { checkedOn: string | null; streak: number | null; lastPoints: number | null };
  /** [v0.5.7] 真实积分账本（仅 MiniMax oauth 提供商有）。 */
  credits: CreditLedgerBlock | null;
}

/**
 * 模型来源 —— 用户要能一眼看出**这个模型是从哪来的**：
 *   - `upstream`：运行时从上游目录端点拉到（本地倍率表未必有它）
 *   - `seed`：来自本地种子清单（上游拉取失败时的回落）
 *   - `manual`：人工添加
 */
export type ModelSource = 'upstream' | 'seed' | 'manual';

export interface CatalogModel {
  id: string;
  /**
   * [v0.5.13] 该模型归属的提供商显示名。请求日志的「提供商」按**模型 id → 目录**解析
   * （requests 无 provider_id，逐行服务方不可知）；密钥绑定名只是路由偏好，不能冒充提供商。
   */
  provider: string;
  displayName: string;
  family: string;
  tag: string | null;
  /**
   * 计费倍率。来源优先级：/v3/config 接口真实值（随目录刷新/每日同步更新）>
   * 内置快照 > `null` = 倍率未知（两边都没有该模型）。
   *
   * ⛔ 后端用 `1.0` 做计算兜底，但界面**不得**把 `null` 渲染成 `1.0` ——
   * 那等于把一个估算伪装成事实。未知就写「倍率未知」。
   */
  multiplier: number | null;
  source: ModelSource;
  verified: number;
  enabled: boolean;
  lastVerifiedAt: string | null;
}

export interface CatalogData {
  source: ModelSource;
  fetchedAt: string;
  upstreamReachable: boolean;
  models: CatalogModel[];
}

/**
 * `POST /api/models/catalog` 的响应 —— 「拉取 + 逐项实测」的结果摘要。
 *
 * `failed` 里的 id 是**实测未通过**的模型（多为账号没订阅）。
 * 它们会被标 `verified=0` 但**不会删除** —— 订阅以后可能又开。
 */
export interface CatalogRefreshResult {
  checked: number;
  ok: number;
  failed: string[];
  source: string;
  /** 上游模型清单是否拉到（false = 走了本地种子 + 已观测模型回落）。 */
  pulled?: boolean;
  /** /v3/config 真实倍率表是否拉到（false = 倍率沿用本地快照）。 */
  configPulled?: boolean;
  /** 本次同步倍率有变化的模型数（接口值覆盖了过期快照，或补上了未知项）。 */
  multipliersUpdated?: number;
  /** [v1.5.3] 按家明细（抽屉只显示当前家的数字；合计会让用户以为对不上）。 */
  perProvider?: Array<{ id: string; name: string; checked: number; ok: number; failed: string[] }>;
}
// @zbiti-ai:f:501:a5aa218a
