import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

export interface MetricsRow {
  requests: number;
  errors: number;
  credits: number;
  avgMs: number;
  clients: number;
}

export interface ModelSlice {
  model: string;
  displayName: string | null;
  requests: number;
  credits: number;
}

export interface ClientSlice {
  clientId: string;
  requests: number;
  credits: number;
}

export interface ClientDetail {
  clientId: string;
  rule: number;
  requests: number;
  credits: number;
  models: string[];
  lastSeenAt: number;
}

export interface RecentRow {
  id: number;
  ts: number;
  client: string;
  model: string;
  status: number;
  ms: number;
  credits: number;
  note: string;
}

@Injectable()
export class StatsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  metrics(from: number, to: number): MetricsRow {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(credits), 0) AS credits,
                COALESCE(AVG(ms), 0) AS avgMs,
                COUNT(DISTINCT client_id) AS clients
           FROM requests WHERE ts >= ? AND ts < ?`,
      )
      .get(from, to) as MetricsRow;
    return row;
  }

  byModel(from: number, to: number, limit = 20): ModelSlice[] {
    /* ⚠️ 目录侧先按 model id 去重再 JOIN（2026-10-11，与 overview.service 同一处缺陷）：
       `model_catalog` 主键是 `(provider_id, id)`，同一 id 可在多家提供商各有一行
       （原写法连 active 都没过滤，会配上更多行）—— 直接 JOIN 会让 COUNT/SUM 成倍放大。
       本方法当前**无调用方**（这个类只有 requestsForKey 在被用），改它只为不留地雷。
       代表行取 `provider_id` 最小者，与 `overview.service.ts` 的规则保持一致。 */
    return this.db
      .prepare(
        `SELECT r.model AS model, mc.display_name AS displayName,
                COUNT(*) AS requests, COALESCE(SUM(r.credits), 0) AS credits
           FROM requests r
           LEFT JOIN (
                  SELECT id, display_name,
                         ROW_NUMBER() OVER (PARTITION BY id ORDER BY provider_id) AS rn
                    FROM model_catalog
                ) mc ON mc.id = r.model AND mc.rn = 1
          WHERE r.ts >= ? AND r.ts < ?
          GROUP BY r.model
          ORDER BY credits DESC
          LIMIT ?`,
      )
      .all(from, to, limit) as ModelSlice[];
  }

  byClient(from: number, to: number, limit = 20): ClientSlice[] {
    return this.db
      .prepare(
        `SELECT client_id AS clientId, COUNT(*) AS requests, COALESCE(SUM(credits), 0) AS credits
           FROM requests WHERE ts >= ? AND ts < ?
          GROUP BY client_id ORDER BY credits DESC LIMIT ?`,
      )
      .all(from, to, limit) as ClientSlice[];
  }

  clientDetails(from: number, to: number): ClientDetail[] {
    const rows = this.db
      .prepare(
        `SELECT client_id AS clientId,
                COUNT(*) AS requests,
                COALESCE(SUM(credits), 0) AS credits,
                MAX(ts) AS lastSeenAt,
                (SELECT client_rule FROM requests r2
                  WHERE r2.client_id = r.client_id AND r2.ts >= ? AND r2.ts < ?
                  GROUP BY client_rule ORDER BY COUNT(*) DESC LIMIT 1) AS rule
           FROM requests r
          WHERE ts >= ? AND ts < ?
          GROUP BY client_id
          ORDER BY credits DESC`,
      )
      .all(from, to, from, to) as ClientDetail[];
    const modelStmt = this.db.prepare(
      'SELECT DISTINCT model FROM requests WHERE client_id = ? AND ts >= ? AND ts < ? ORDER BY model',
    );
    for (const row of rows) {
      row.models = (modelStmt.all(row.clientId, from, to) as Array<{ model: string }>).map(
        (m) => m.model,
      );
      row.rule = row.rule ?? 4;
    }
    return rows;
  }

  recent(from: number, to: number, limit = 8): RecentRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, client, model, status, ms, credits, note
           FROM requests WHERE ts >= ? AND ts < ?
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(from, to, limit) as RecentRow[];
  }

  requestsForKey(keyId: string, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE key_id = ? AND ts >= ?')
      .get(keyId, since) as { n: number };
    return row.n;
  }
}
