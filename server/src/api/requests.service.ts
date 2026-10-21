/**
 * `GET /api/requests` 与 `GET /api/requests/:id` 的读取逻辑（api-contract §3.6 / §3.7）。
 *
 * 两条硬约束：
 *   1. **列表不返回 requestBody / responseBody**（体积大且默认关闭）
 *   2. 详情里 `requestBody` / `responseBody` **仅在对应开关为 true 时才有值**，
 *      否则恒 `null` —— 注意：开关判断要在**读取时**做，而不是"库里没有就返回 null"。
 *      因为开关一旦被关掉，旧数据可能还留在库里；直接返回会违背用户"关闭记录"的意图。
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../store/db';
import { createStmtCache } from '../store/cached-stmt';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError, ApiCode } from '../common/errors';
import { round2OrNull, toIso } from './window';
import { resolveClientName } from './client-name';
import { parseAssistantPreview, parseMessages } from './request-body';
import { detectTool } from '../identify/ua-table';

export interface RequestListItem {
  id: number;
  ts: string;
  clientId: string;
  client: string;
  model: string;
  modelDisplay: string | null;
  /**
   * [v1.6.33] 本请求**实际路由到的**提供商 id（迁移 018 落库的事实列）。
   *
   * ★ 为什么必须由后端给、前端不能自己算：按模型目录反解在同名模型上**必然歧义** ——
   * `MiniMax-M3.1-Flash` 同时出现在「MiniMax Code」与「MiniMax Code2」两家的目录里，
   * 反解只能取到先注册的那家，于是**永远显示不成 Code2**（用户实测报障）。
   * `null` = 模型解析前就被本地拒绝（无归属），或迁移前的老行（那时没这一列）。
   */
  providerId: string | null;
  status: number;
  upstreamCode: number | null;
  ms: number;
  queuedMs: number;
  firstByteMs: number | null;
  /** [v1.7.2] 分段计时；null = 未知（老行/失败行/未打点）。我方开销 = authMs + prepMs。 */
  authMs: number | null;
  /** [v1.7.2] 进门 → body 就绪（客户端上传 + 解析等待）。**不是**我方开销。 */
  ingressMs: number | null;
  prepMs: number | null;
  upstreamWaitMs: number | null;
  promptTokens: number;
  completionTokens: number;
  /** [v0.2.0] 输出里的思考 tokens（含在 completionTokens 内；旧行/未回报为 0）。 */
  reasoningTokens: number;
  /** [v0.2.0/2026-10-08] 缓存命中的输入 tokens。为 0 就是 0（真值，非「未提供」）。 */
  cachedTokens: number;
  /**
   * [v0.5.8] 本行积分 = 上游实扣（`usage.credit`）。
   * **`null` = 上游未回报该次费用（未知），不是 0** —— 前端渲染 `--`，本服务不估算。
   */
  credits: number | null;
  stream: boolean;
  retryCount: number;
  note: string;
  keyHint: string | null;
  /**
   * [2026-10-08] 从 `ua` 解析出的**工具名**（如 `Claude Code`）。`null` = 认不出来。
   *
   * ⚠️ 这是**显示用的派生字段**，不是身份 —— `clientId` 仍然是「哪把密钥」
   * （`spec-v4-client-id.md` §2 的不变量，见 `identify/ua-table.ts` 文件头）。
   * 之所以放在列表里：日志表要能一眼回答「这条请求是哪个工具发的」。
   */
  tool: string | null;
  /**
   * [2026-10-09] User-Agent **原文**（列表行也带上了）。
   *
   * 此前只有详情接口返回它，列表只给 `tool` —— 于是界面只给**判定结果**、不给依据。
   * 而判定会错：实测 `ZCode/3.14.5 ai-sdk/provider-utils/… runtime/node.js`
   * 被判成 `Node.js`（末尾那个 `node` 兜底关键词先命中）。用户看到「Node.js」
   * 无从知道那到底是谁 —— UA 原文才是可行动的信息。
   * 体量可控：它是**短字符串**（落库为原始 UA），与 `request_body` / `response_body`
   * 那种整段对话不是一个量级。
   */
  ua: string | null;
}

export interface RequestDetail extends RequestListItem {
  totalTokens: number;
  clientRule: number;
  keyId: string | null;
  remoteIp: string | null;
  ua: string | null;
  messages: Array<{ role: string; content: string }>;
  assistantPreview: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

interface RawRow {
  id: number;
  ts: number;
  client: string;
  client_rule: number;
  client_id: string;
  key_id: string | null;
  key_hint: string | null;
  model: string;
  model_display: string | null;
  /** [v1.6.30] 实际路由到的提供商 id（迁移 018）；迁移前的老行为 null。 */
  provider_id: string | null;
  status: number;
  upstream_code: number | null;
  ms: number;
  queued_ms: number;
  first_byte_ms: number | null;
  auth_ms: number | null;
  ingress_ms: number | null;
  prep_ms: number | null;
  upstream_wait_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  /** 可空：NULL = 上游未回报（未知），**不是 0**（v0.5.8）。 */
  credits: number | null;
  stream: number;
  retry_count: number;
  note: string;
  remote_ip: string | null;
  ua: string | null;
  request_body?: string | null;
  response_body?: string | null;
  /** 以下三列来自 LEFT JOIN client_keys，用于把 client_id 解析成**当前**显示名（而非快照） */
  bound_name: string | null;
  key_name: string | null;
  key_exists_id: string | null;
}

export interface ListOptions {
  page: number;
  limit: number;
  status?: string;
  clientId?: string;
  model?: string;
  q?: string;
  from?: number;
  to?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  /** 游标：上一页最后一行的 `${ts}_${id}`（来自响应的 nextCursor）；仅 sort=ts 时生效。 */
  cursor?: string;
}

/** 筛选总数缓存有效期（见 RequestQueryService.countCached）。 */
const COUNT_TTL_MS = 5_000;
/** 总数缓存的条目上限（不同搜索词各占一条）。 */
const COUNT_CACHE_MAX = 200;

/** 解析游标 `${ts}_${id}`；缺省返回 null，格式不对直接 400（静默忽略会让用户翻到错误的页）。 */
function parseCursor(raw: string | undefined): { ts: number; id: number } | null {
  if (raw === undefined || raw === '') return null;
  const m = /^(\d{1,15})_(\d{1,15})$/.exec(raw);
  if (!m) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: `分页游标格式不正确：${raw}`,
    });
  }
  return { ts: Number(m[1]), id: Number(m[2]) };
}

@Injectable()
export class RequestQueryService {
  /* 列表/详情查询按 SQL 文本缓存语句：筛选组合 × 排序白名单的形状有限，
     避免每次翻页/筛选都重新编译同一条 SQL。 */
  private readonly stmt: ReturnType<typeof createStmtCache>;

  constructor(
    @Inject(DB_TOKEN) db: Db,
    private readonly config: RelayConfigService,
  ) {
    this.stmt = createStmtCache(db);
  }

  list(opts: ListOptions): {
    items: RequestListItem[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const status = opts.status ?? 'all';
    if (status === 'success') clauses.push('r.status < 400');
    else if (status === 'error') clauses.push('r.status >= 400');
    else if (/^\d{3}$/.test(status)) {
      clauses.push('r.status = ?');
      params.push(Number(status));
    }
    if (opts.clientId) {
      clauses.push('r.client_id = ?');
      params.push(opts.clientId);
    }
    if (opts.model) {
      clauses.push('r.model = ?');
      params.push(opts.model);
    }
    if (opts.q) {
      // 自由文本搜索：快照名（client）与「该客户端的**当前名**」都要能命中 ——
      // 否则改一次名，按新名就搜不到改名前的旧行（client_id 不变，故走 client_keys 反查）。
      clauses.push(
        '(r.model LIKE ? OR r.client LIKE ? OR r.note LIKE ?' +
          ' OR r.client_id IN (SELECT id FROM client_keys WHERE client LIKE ? OR name LIKE ?))',
      );
      const like = `%${opts.q}%`;
      params.push(like, like, like, like, like);
    }
    if (typeof opts.from === 'number') {
      clauses.push('r.ts >= ?');
      params.push(opts.from);
    }
    if (typeof opts.to === 'number') {
      clauses.push('r.ts <= ?');
      params.push(opts.to);
    }

    // 排序字段白名单：直接拼进 SQL，不做参数化（SQLite 不允许占位符出现在 ORDER BY）
    const SORTABLE = new Set(['ts', 'ms', 'credits', 'status']);
    const sort = opts.sort && SORTABLE.has(opts.sort) ? opts.sort : 'ts';
    const order = opts.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(opts.limit, 1), 200);
    const page = Math.max(opts.page, 1);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.countCached(where, params);

    /* 游标（keyset）分页：只在按时间排序时生效（默认排序，也是日志页唯一用到的排序）。
       OFFSET 分页翻到第 N 页要先扫过并丢弃前 (N-1)*limit 行，越往后越慢；
       游标直接从上一页最后一行的 (ts, id) 之后接着走 idx_requests_ts 索引，每页代价恒定，
       并且翻页期间有新请求写入也不会让下一页出现重复行。
       没有游标（第一页 / 跳页 / 其他排序）时回落 OFFSET，契约保持兼容。 */
    const cursor = sort === 'ts' ? parseCursor(opts.cursor) : null;
    /* 同 ts 的并列行按 id **反向**排：索引 idx_requests_ts 是 (ts DESC, rowid 升序)，
       这样整个 ORDER BY 与索引物理顺序完全一致，不需要额外的临时排序（EXPLAIN 已核对）。 */
    const tieOrder = order === 'DESC' ? 'ASC' : 'DESC';
    const pageClauses = [...clauses];
    const pageParams = [...params];
    if (cursor) {
      // 拆成「ts 范围 + 同 ts 内按 id 续接」：ts 的范围条件能直接走索引，id 只在同毫秒的少量行上过滤
      pageClauses.push(order === 'DESC' ? 'r.ts <= ? AND (r.ts < ? OR r.id > ?)' : 'r.ts >= ? AND (r.ts > ? OR r.id < ?)');
      pageParams.push(cursor.ts, cursor.ts, cursor.id);
    }
    const pageWhere = pageClauses.length ? `WHERE ${pageClauses.join(' AND ')}` : '';
    const offset = cursor ? 0 : (page - 1) * limit;

    // 多取 1 行判断 hasMore（游标模式下 offset 不可用，也不再依赖可能稍旧的 total）
    const fetched = this
      .stmt(
        `SELECT r.id, r.ts, r.client, r.client_rule, r.client_id, r.key_id, r.key_hint,
                r.model, r.model_display, r.provider_id, r.status, r.upstream_code, r.ms, r.queued_ms, r.first_byte_ms, r.auth_ms, r.ingress_ms, r.prep_ms, r.upstream_wait_ms,
                r.prompt_tokens, r.completion_tokens, r.reasoning_tokens, r.cached_tokens, r.total_tokens, r.credits, r.stream,
                r.retry_count, r.note, r.remote_ip, r.ua,
                ck.client AS bound_name, ck.name AS key_name, ck.id AS key_exists_id
           FROM requests r
           LEFT JOIN client_keys ck ON ck.id = r.client_id
           ${pageWhere}
          ORDER BY r.${sort} ${order}, r.id ${tieOrder}
          LIMIT ? OFFSET ?`,
      )
      .all(...pageParams, limit + 1, offset) as RawRow[];
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows[rows.length - 1];

    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page,
      limit,
      hasMore,
      // 仅按时间排序时给出下一页游标；其他排序只能走 OFFSET
      nextCursor: hasMore && sort === 'ts' && last ? `${last.ts}_${last.id}` : null,
    };
  }

  /**
   * 筛选命中总数的短 TTL 缓存（按 WHERE 文本 + 参数）。
   *
   * 为什么：COUNT(*) 要把命中范围整段数一遍（无筛选时就是全表），而翻页时筛选条件不变、
   * 每页都重算同一个数。取舍：总数最多滞后 COUNT_TTL_MS（新请求还在写入，本来就是动态值）；
   * hasMore 由「多取一行」判断，不受这点滞后影响。清空日志等写操作会调 invalidateCounts()。
   */
  private readonly countCache = new Map<string, { at: number; n: number }>();

  private countCached(where: string, params: unknown[]): number {
    const key = `${where}\u0000${JSON.stringify(params)}`;
    const now = Date.now();
    const hit = this.countCache.get(key);
    if (hit && now - hit.at < COUNT_TTL_MS) return hit.n;
    const n = (this.stmt(`SELECT COUNT(*) AS n FROM requests r ${where}`).get(...params) as { n: number }).n;
    // 搜索词组合无上限 → 超过上限整体清空，防止缓存随不同搜索词无限增长
    if (this.countCache.size >= COUNT_CACHE_MAX) this.countCache.clear();
    this.countCache.set(key, { at: now, n });
    return n;
  }

  /** 日志被批量删除（清空 / 危险操作）后调用：让下一次列表重新计数。 */
  invalidateCounts(): void {
    this.countCache.clear();
  }

  detail(id: number): RequestDetail {
    const row = this
      .stmt(
        `SELECT r.id, r.ts, r.client, r.client_rule, r.client_id, r.key_id, r.key_hint,
                r.model, r.model_display, r.provider_id, r.status, r.upstream_code, r.ms, r.queued_ms, r.first_byte_ms, r.auth_ms, r.ingress_ms, r.prep_ms, r.upstream_wait_ms,
                r.prompt_tokens, r.completion_tokens, r.reasoning_tokens, r.cached_tokens, r.total_tokens, r.credits, r.stream,
                r.retry_count, r.note, r.remote_ip, r.ua, r.request_body, r.response_body,
                ck.client AS bound_name, ck.name AS key_name, ck.id AS key_exists_id
           FROM requests r
           LEFT JOIN client_keys ck ON ck.id = r.client_id
          WHERE r.id = ?`,
      )
      .get(id) as RawRow | undefined;

    if (!row) {
      throw new RelayHttpError({
        httpStatus: 404,
        code: 'request_not_found',
        apiCode: ApiCode.NOT_FOUND,
        message: `请求日志 #${id} 不存在（可能已被按保留策略清理）。`,
      });
    }

    const settings = this.config.get();
    const messages = parseMessages(row.request_body ?? null);
    const assistantPreview = parseAssistantPreview(row.response_body ?? null);

    return {
      ...this.toListItem(row),
      totalTokens: row.total_tokens,
      clientRule: row.client_rule,
      keyId: row.key_id,
      remoteIp: row.remote_ip,
      ua: row.ua,
      messages,
      assistantPreview,
      // ★ 开关是"是否记录"的权威；关掉后即便旧数据还在库里也不返回
      requestBody: settings.logs.recordRequestBody ? (row.request_body ?? null) : null,
      responseBody: settings.logs.recordResponseBody ? (row.response_body ?? null) : null,
    };
  }

  private toListItem(r: RawRow): RequestListItem {
    return {
      id: r.id,
      ts: toIso(r.ts),
      clientId: r.client_id,
      // ★ 显示的是**当前名**（经回落链解析），不是写入时的快照列 —— 否则改一次名，
      //   客户端列表显示新名、这一行仍显示旧名（契约 §9.2 的"同一行两个名字"）。
      client: resolveClientName({
        clientId: r.client_id,
        boundName: r.bound_name,
        keyName: r.key_name,
        keyExists: r.key_exists_id !== null,
        keyHint: r.key_hint,
      }),
      model: r.model,
      modelDisplay: r.model_display,
      /* [v1.6.33] 事实列：本请求实际路由到哪家。前端据此显示提供商 ——
         不再自己按模型目录反解（同名模型反解必然歧义，见 RequestListItem 注释）。 */
      providerId: r.provider_id ?? null,
      status: r.status,
      upstreamCode: r.upstream_code,
      ms: r.ms,
      queuedMs: r.queued_ms,
      firstByteMs: r.first_byte_ms,
      authMs: r.auth_ms,
      ingressMs: r.ingress_ms,
      prepMs: r.prep_ms,
      upstreamWaitMs: r.upstream_wait_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      reasoningTokens: r.reasoning_tokens,
      cachedTokens: r.cached_tokens,
      // ★ round2OrNull：round2(null) 会算出 0，把「未知」变成「没花钱」（v0.5.8 口径铁律）。
      credits: round2OrNull(r.credits),
      stream: r.stream === 1,
      retryCount: r.retry_count,
      note: r.note,
      keyHint: r.key_hint,
      // 工具名从 UA 现解析（读取时解释，不是写入时固化）—— 关键词表可随时增补，
      // 改完立刻对历史行生效，不需要回填数据。
      tool: detectTool(r.ua)?.tool ?? null,
      // UA 原文同屏给出：判定结果会错，原文才是可行动的依据（见接口字段注释）。
      ua: r.ua,
    };
  }
}
