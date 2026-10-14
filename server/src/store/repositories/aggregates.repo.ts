import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

export interface AggregateDelta {
  requests: number;
  errors: number;
  /** [v0.5.8] null = 未知（聚合时按 0 计入总量，行本身仍如实标记）。 */
  credits: number | null;
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中 prompt tokens（口径见 proxy/usage-tokens.ts）。 */
  cachedTokens: number;
  totalMs: number;
}

export interface TrendPoint {
  bucket: string;
  requests: number;
  errors: number;
  credits: number;
}

const HOUR_BUCKET_LEN = 13; // 'YYYY-MM-DDTHH'
const DAY_BUCKET_LEN = 10; // 'YYYY-MM-DD'

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 小时桶 'YYYY-MM-DDTHH'（本地时区，与 schema.sql 的 bucket 约定一致）。 */
export function hourBucket(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
}

/** 天桶 'YYYY-MM-DD'（本地时区）。 */
export function dayBucket(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

@Injectable()
export class AggregatesRepository {
  private readonly upsertStmt;
  private readonly trendStmt;
  private readonly clearStmt;

  constructor(@Inject(DB_TOKEN) db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO aggregates
         (bucket, dim, dim_value, requests, errors, credits, prompt_tokens, completion_tokens, cached_tokens, total_ms, updated_at)
       VALUES (@bucket, @dim, @dimValue, @requests, @errors, @credits, @promptTokens, @completionTokens, @cachedTokens, @totalMs, @now)
       ON CONFLICT(bucket, dim, dim_value) DO UPDATE SET
         requests          = requests + excluded.requests,
         errors            = errors + excluded.errors,
         credits           = credits + excluded.credits,
         prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         cached_tokens     = cached_tokens + excluded.cached_tokens,
         total_ms          = total_ms + excluded.total_ms,
         updated_at        = excluded.updated_at`,
    );
    this.trendStmt = db.prepare(
      `SELECT bucket, SUM(requests) AS requests, SUM(errors) AS errors, ROUND(SUM(credits), 2) AS credits
         FROM aggregates
        WHERE dim = 'total' AND length(bucket) = @len AND bucket >= @from
        GROUP BY bucket ORDER BY bucket`,
    );
    this.clearStmt = db.prepare('DELETE FROM aggregates WHERE bucket < ?');
  }

  upsert(bucket: string, dim: string, dimValue: string, delta: AggregateDelta): void {
    this.upsertStmt.run({
      bucket,
      dim,
      dimValue,
      requests: delta.requests,
      errors: delta.errors,
      credits: delta.credits,
      promptTokens: delta.promptTokens,
      completionTokens: delta.completionTokens,
      cachedTokens: delta.cachedTokens,
      totalMs: delta.totalMs,
      now: Date.now(),
    });
  }

  /**
   * 按桶取趋势（ADR-002 设定的预聚合读口）。
   *
   * ⚠️ **当前没有任何生产调用方**（2026-10-08 实测：全仓 grep 无调用点）。
   * 控制台的趋势图走的是 `overview.service.ts` 对 `requests` 表的即时聚合 ——
   * 那里的注释说明了原因（天桶没有 model/client 维度，两个数据源必然漂移）。
   *
   * 那这张表为什么还在写？因为它**不是死数据**，而是 `tools/verify-all.mjs` 的 A11
   * 一致性闸的对照物：`requests` 合计必须等于 `aggregates` 的日桶合计。这条闸的价值在于
   * 它比对的是**两条独立的记账路径**（逐行落库 vs. 同事务内的增量 upsert）——
   * upsert 的累加逻辑写错时，只有它会把差异暴露出来。
   * 代价是每请求 5 次 upsert（同事务内），自用规模下可忽略。
   *
   * 所以：**别删这张表，也别以为它在给趋势图提速**。改 upsert 口径时，
   * A11 是那个会红的东西；本方法的调用方仍然为零，将来真要切过去再接线。
   */
  trend(fromBucket: string, bucketLen: number): TrendPoint[] {
    return this.trendStmt.all({ len: bucketLen, from: fromBucket }) as TrendPoint[];
  }

  clearBefore(bucket: string): number {
    return this.clearStmt.run(bucket).changes;
  }

  static hourBucketLength(): number {
    return HOUR_BUCKET_LEN;
  }

  static dayBucketLength(): number {
    return DAY_BUCKET_LEN;
  }
}
