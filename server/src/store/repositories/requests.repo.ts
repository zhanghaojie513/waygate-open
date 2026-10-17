import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, optimizeDatabase, type Db } from '../db';
import { createStmtCache } from '../cached-stmt';
import { keyUsageCacheFor, type KeyUsageCache } from '../key-usage-cache';
import { AggregatesRepository, dayBucket, hourBucket } from './aggregates.repo';

export interface RequestLogInput {
  ts: number;
  traceId: string;
  clientId: string;
  client: string;
  clientRule: number;
  keyId: string | null;
  keyHint: string | null;
  model: string;
  modelDisplay: string | null;
  status: number;
  upstreamCode: number | null;
  ms: number;
  queuedMs: number;
  firstByteMs: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 缓存命中的 prompt tokens（口径见 proxy/usage-tokens.ts）。 */
  cachedTokens: number;
  /** 输出里的思考 tokens（含在 completionTokens 内；缺省 0 —— 兼容旧调用/测试直构）。 */
  reasoningTokens?: number;
  /** [v0.5.8] null = 上游未回报该次费用（未知）。 */
  credits: number | null;
  stream: boolean;
  retryCount: number;
  note: string;
  remoteIp: string | null;
  ua: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

export interface RequestRow {
  id: number;
  ts: number;
  trace_id: string;
  client: string;
  client_rule: number;
  client_id: string;
  key_id: string | null;
  key_hint: string | null;
  model: string;
  model_display: string | null;
  status: number;
  upstream_code: number | null;
  ms: number;
  queued_ms: number;
  first_byte_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  credits: number;
  stream: number;
  retry_count: number;
  note: string;
  remote_ip: string | null;
  ua: string | null;
  request_body: string | null;
  response_body: string | null;
  created_at: number;
}

export interface RequestQuery {
  page: number;
  limit: number;
  status: string;
  clientId?: string;
  model?: string;
  q?: string;
  from?: number;
  to?: number;
  sort: string;
  order: 'asc' | 'desc';
}

const SORT_WHITELIST = new Set(['ts', 'ms', 'credits', 'status', 'prompt_tokens', 'completion_tokens']);

/** [v1.6.28] 落库时发现密钥已被删除（在途请求晚于删除）后追加的标记，见 writeLog。 */
export const ORPHANED_KEY_NOTE = 'key_deleted_inflight';

/** better-sqlite3 的 FK 违例：code 是 SQLITE_CONSTRAINT_FOREIGNKEY（787），message 含 FOREIGN KEY。 */
function isForeignKeyFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  return e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(String(e.message ?? ''));
}

@Injectable()
export class RequestsRepository {
  private readonly insertStmt;
  private readonly byIdStmt;
  private readonly deleteAllStmt;
  private readonly deleteBeforeStmt;
  private readonly deleteBeforeBatchStmt;
  private readonly logTx: (row: RequestLogInput) => { id: number; effectiveKeyId: string | null };
  /* 动态形状（WHERE 组合 / 排序白名单）的查询语句按 SQL 文本缓存 ——
     写不进构造器的有限模板走这里，热路径插入/点查仍走上面的构造器语句。 */
  private readonly stmt: ReturnType<typeof createStmtCache>;
  /** 密钥累计用量缓存（与 ClientKeysRepository 共享同一份）：写入后增量维护、删除后作废。 */
  private readonly usage: KeyUsageCache;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly aggregates: AggregatesRepository,
  ) {
    this.stmt = createStmtCache(db);
    this.usage = keyUsageCacheFor(db);
    this.insertStmt = db.prepare(
      `INSERT INTO requests
         (ts, trace_id, client_id, client, client_rule, key_id, key_hint, model, model_display, status,
          upstream_code, ms, queued_ms, first_byte_ms, prompt_tokens, completion_tokens,
          total_tokens, cached_tokens, reasoning_tokens, credits, stream, retry_count, note, remote_ip, ua, request_body,
          response_body, created_at)
       VALUES
         (@ts, @traceId, @clientId, @client, @clientRule, @keyId, @keyHint, @model, @modelDisplay, @status,
          @upstreamCode, @ms, @queuedMs, @firstByteMs, @promptTokens, @completionTokens,
          @totalTokens, @cachedTokens, @reasoningTokens, @credits, @stream, @retryCount, @note, @remoteIp, @ua, @requestBody,
          @responseBody, @createdAt)`,
    );
    this.byIdStmt = db.prepare('SELECT * FROM requests WHERE id = ?');
    this.deleteAllStmt = db.prepare('DELETE FROM requests');
    this.deleteBeforeStmt = db.prepare('DELETE FROM requests WHERE ts < ?');
    this.deleteBeforeBatchStmt = db.prepare(
      'DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE ts < ? LIMIT ?)',
    );
    /* 事务包装在构造期建一次复用（性能：原先每请求 db.transaction(...) 都新建一个包装函数）。 */
    this.logTx = db.transaction((row: RequestLogInput) => this.writeLog(row));
  }

  /** 一次请求 = 一行。与 aggregates 的递增在同一事务内（api-contract §6）。 */
  log(row: RequestLogInput): number {
    const { id, effectiveKeyId } = this.logTx(row);
    // 事务已提交才更新用量缓存（事务内更新的话，回滚会让缓存多计）。
    // 密钥已在途删除时 effectiveKeyId 为 null：那份计数已无归属，不再喂给缓存。
    this.usage.onInsert(effectiveKeyId, row.totalTokens, row.remoteIp);
    return id;
  }

  /** 事务体：插入请求行 + 5 个聚合桶递增（由构造期建好的 logTx 包在同一事务里执行）。 */
  private writeLog(row: RequestLogInput): { id: number; effectiveKeyId: string | null } {
    let info;
    let effectiveKeyId = row.keyId;
    try {
      info = this.insertStmt.run({
        ...row,
        reasoningTokens: row.reasoningTokens ?? 0,
        stream: row.stream ? 1 : 0,
        createdAt: Date.now(),
      });
    } catch (err) {
      /* [v1.6.28] 密钥在请求**在途期间**被删：`key_id` 的外键是 ON DELETE SET NULL，
         但那只在删除时清理**已有**子行；本请求晚于删除落库，INSERT 指向已消失的父行
         ⇒ FOREIGN KEY constraint failed，整行审计（tokens/积分/状态/耗时）被丢掉。
         （生产实证：2026-10-17 探针在流未结束时删临时密钥。）
         处置：把 key_id 降级为 NULL 重试一次，保住整行。client_id / key_hint 是文本
         快照、不受外键约束，仍能说明「这条是谁发的」—— 不改成 unidentified，那样会
         把已识别的流量错记成未识别，污染客户端排行。行上追加标记便于事后辨认。 */
      if (!isForeignKeyFailure(err) || row.keyId === null) throw err;
      effectiveKeyId = null;
      info = this.insertStmt.run({
        ...row,
        keyId: null,
        keyHint: row.keyHint ?? null,
        note: [row.note, ORPHANED_KEY_NOTE].filter(Boolean).join(','),
        reasoningTokens: row.reasoningTokens ?? 0,
        stream: row.stream ? 1 : 0,
        createdAt: Date.now(),
      });
    }
    const errors = row.status >= 400 ? 1 : 0;
    const delta = {
      requests: 1,
      errors,
      /* [v0.5.8] credits 可空（上游未回报 = 未知）。聚合表是**求和**口径，
         未知对合计的贡献就是 0 —— 这里 coalesce，行本身的 null 语义仍保留在 requests 表。 */
      credits: row.credits ?? 0,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedTokens: row.cachedTokens,
      totalMs: row.ms,
    };
    const hour = hourBucket(row.ts);
    const day = dayBucket(row.ts);
    this.aggregates.upsert(hour, 'model', row.model, delta);
    // 聚合键用 client_id（稳定），绝不用 client（名字快照，会随改名失效）
    this.aggregates.upsert(hour, 'client', row.clientId, delta);
    this.aggregates.upsert(hour, 'status', String(row.status), delta);
    this.aggregates.upsert(hour, 'total', '-', delta);
    this.aggregates.upsert(day, 'total', '-', delta);
    return { id: Number(info.lastInsertRowid), effectiveKeyId };
  }

  private buildWhere(q: RequestQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'success') clauses.push('status < 400');
    else if (q.status === 'error') clauses.push('status >= 400');
    else if (/^\d{3}$/.test(q.status)) {
      clauses.push('status = ?');
      params.push(Number(q.status));
    }
    if (q.clientId) {
      clauses.push('client_id = ?');
      params.push(q.clientId);
    }
    if (q.model) {
      clauses.push('model = ?');
      params.push(q.model);
    }
    if (q.q) {
      // 自由文本搜索：快照名（client）与「该客户端的**当前名**」都要能命中 ——
      // 否则改名后按新名就搜不到改名前的旧行（client_id 不变，故反查 client_keys）。
      clauses.push(
        '(model LIKE ? OR client LIKE ? OR note LIKE ?' +
          ' OR client_id IN (SELECT id FROM client_keys WHERE client LIKE ? OR name LIKE ?))',
      );
      const like = `%${q.q}%`;
      params.push(like, like, like, like, like);
    }
    if (typeof q.from === 'number') {
      clauses.push('ts >= ?');
      params.push(q.from);
    }
    if (typeof q.to === 'number') {
      clauses.push('ts <= ?');
      params.push(q.to);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  list(q: RequestQuery): { items: RequestRow[]; total: number } {
    const { sql, params } = this.buildWhere(q);
    const sort = SORT_WHITELIST.has(q.sort) ? q.sort : 'ts';
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(q.limit, 1), 200);
    const offset = (Math.max(q.page, 1) - 1) * limit;
    const total = (
      this.stmt(`SELECT COUNT(*) AS n FROM requests ${sql}`).get(...params) as { n: number }
    ).n;
    const items = this.stmt(
        `SELECT id, ts, trace_id, client, client_rule, client_id, key_id, key_hint, model, model_display,
                status, upstream_code, ms, queued_ms, first_byte_ms, prompt_tokens,
                completion_tokens, total_tokens, cached_tokens, reasoning_tokens, credits, stream, retry_count, note,
                remote_ip, ua, created_at
           FROM requests ${sql}
          ORDER BY ${sort} ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as RequestRow[];
    return { items, total };
  }

  findById(id: number): RequestRow | null {
    return (this.byIdStmt.get(id) as RequestRow | undefined) ?? null;
  }

  clearAll(): number {
    const run = this.db.transaction(() => {
      const n = this.deleteAllStmt.run().changes;
      this.stmt('DELETE FROM aggregates').run();
      return n;
    });
    const n = run();
    this.usage.invalidateAll(); // 行被删：累计用量缓存作废
    return n;
  }

  clearBefore(ts: number): number {
    const n = this.deleteBeforeStmt.run(ts).changes;
    if (n > 0) this.usage.invalidateAll();
    return n;
  }

  /**
   * 分批删除过期行：单批最多 `batch` 行，返回本批删除数（0 = 删完）。
   * 用于保留期清理 —— 一次性 DELETE 几十万行会同步持写锁、阻塞事件循环数秒并让 WAL 暴涨；
   * 分批后调用方可在批间让出事件循环（见 RetentionService.sweepIncremental）。
   */
  clearBeforeBatch(ts: number, batch: number): number {
    const n = this.deleteBeforeBatchStmt.run(ts, batch).changes;
    if (n > 0) this.usage.invalidateAll();
    return n;
  }

  /** 按需刷新查询规划统计（PRAGMA optimize），大批删除后数据分布变化时调用。 */
  optimize(): void {
    optimizeDatabase(this.db);
  }

  count(): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    return row.n;
  }

  /**
   * 「实际请求过的模型」—— status=200 且模型非空的去重清单（task#18）。
   *
   * 这是「按实际请求来」的最硬证据：**不依赖任何上游端点**，只从本机请求日志推导。
   * 用于把 observed 一路并进模型目录（来源标 observed，不与订阅清单混淆）。
   * display 取该模型最近一次的非空 model_display（可能为 NULL）。
   */
  observedModels(): Array<{ id: string; displayName: string | null }> {
    const rows = this.stmt(
        `SELECT model AS id, MAX(model_display) AS displayName
           FROM requests
          WHERE status = 200 AND model IS NOT NULL AND model <> ''
          GROUP BY model
          ORDER BY model ASC`,
      )
      .all() as Array<{ id: string; displayName: string | null }>;
    return rows;
  }
}
