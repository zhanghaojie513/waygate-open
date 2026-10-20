/**
 * `GET /api/clients`（api-contract §3.5 / §4 · spec-v4-client-id §4）。
 *
 * 输出契约里的几个派生字段都需要跨表拼装：
 *   - `ruleLabel`    —— rule 1/2/3/4 的人话名（前端不做映射，避免两处口径）
 *   - `boundKeyIds`  —— 该客户端名下绑了哪些密钥（client_id 即密钥 id，故恒为 0 或 1 个）
 *   - `named`        —— false 表示"未识别的兜底客户端"，前端用琥珀描边，**不告警**
 *
 * ★ 分组键是 `requests.client_id`（稳定），不是 `requests.client`（名字快照，会随改名失效）。
 *   显示名由 `resolveClientName` 按回落链解析（绑定名 → 密钥名 → 已删除的密钥 · 掩码）。
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../store/db';
import { createStmtCache } from '../store/cached-stmt';
import { round2, share, toIso, type WindowSpec, windowRange } from './window';
import { resolveClientName, UNIDENTIFIED_ID } from './client-name';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';

export type ClientRule = 1 | 2 | 3 | 4;

export const RULE_LABELS: Record<ClientRule, string> = {
  1: '显式声明',
  2: '密钥归属',
  3: 'User-Agent',
  4: '未识别',
};

export interface ClientItem {
  clientId: string;
  client: string;
  rule: ClientRule;
  ruleLabel: string;
  requests: number;
  credits: number;
  models: string[];
  lastSeenAt: string;
  boundKeyIds: string[];
  named: boolean;
  share: number;
}

/** 主聚合的一行：(client_id, model, client_rule) 粒度。 */
interface GroupRow {
  clientId: string;
  model: string;
  /** [v1.6.30] 实际路由到的提供商 id；null = 老行（未记录）或本地拒绝。 */
  providerId: string | null;
  rule: number | null;
  requests: number;
  tokens: number;
  credits: number;
  lastSeen: number;
  keyHint: string | null;
  boundName: string | null;
  keyName: string | null;
  keyExistsId: string | null;
}

/** 按客户端归并后的中间结果。 */
interface ClientAgg {
  clientId: string;
  requests: number;
  /** [2026-10-18] share 的分母口径是 **token**（契约 §3.4「share 口径」），
      故这里必须累计 tokens —— 此前只累计 credits 且用 credits 算 share，
      与 overview 的同名字段是两种量纲（同一个 `share` 两处含义不同）。 */
  tokens: number;
  credits: number;
  lastSeen: number;
  keyHint: string | null;
  boundName: string | null;
  keyName: string | null;
  keyExists: boolean;
  models: Set<string>;
  /** client_rule → 次数（取出现最多的作代表规则） */
  ruleCounts: Map<number | null, number>;
}

@Injectable()
export class ClientsService {
  /* 语句按 SQL 文本缓存：整个 list() 现在只有一条窗口查询，避免每次重新编译。 */
  private readonly stmt: ReturnType<typeof createStmtCache>;

  constructor(
    @Inject(DB_TOKEN) db: Db,
    /* [v0.6.0] byProvider 归因需要目录与提供商。@Optional：旧 spec 按位置构造不破。 */
    @Optional() private readonly providers?: ProvidersRepository,
    @Optional() private readonly catalog?: ModelCatalogRepository,
  ) {
    this.stmt = createStmtCache(db);
  }

  list(spec: WindowSpec, now = Date.now()): {
    items: ClientItem[];
    /* [v0.6.0] 提供商维度用量（与请求日志「提供商」同源归因）—— 提供商表三列直接用。
       此前前端靠「只有一家启用才可归属」的保守门槛，多生效下三列恒 —（用户报缺陷）。 */
    byProvider: Array<{ providerId: string | null; provider: string | null; requests: number; tokens: number; credits: number; lastSeenAt: string | null }>;
  } {
    const { from, to } = windowRange(spec, now);

    /* **一次扫描**按 (client_id, model, client_rule) 分组，客户端列表、模型清单、代表规则、
       byProvider 全部由这份结果在 JS 里归并。
       此前是 N+1：主查询里每个客户端一条相关子查询（代表规则）+ 每个客户端一条 DISTINCT model 查询
       + byProvider 再扫一遍窗口 —— 客户端越多，扫描次数线性增长。
       client_keys 在聚合**之后**才 JOIN（每组一行），主键 JOIN 不会放大计数。 */
    const groups = this.stmt(
      `WITH g AS (
         SELECT client_id, model, client_rule AS rule, provider_id,
                COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                COALESCE(SUM(credits), 0) AS credits,
                MAX(ts) AS lastSeen,
                MAX(key_hint) AS keyHint
           FROM requests WHERE ts >= ? AND ts < ?
          GROUP BY client_id, model, client_rule, provider_id
       )
       SELECT g.client_id AS clientId, g.model, g.provider_id AS providerId, g.rule,
              g.requests, g.tokens, g.credits, g.lastSeen, g.keyHint,
              ck.client AS boundName, ck.name AS keyName, ck.id AS keyExistsId
         FROM g
         LEFT JOIN client_keys ck ON ck.id = g.client_id`,
    ).all(from, to) as GroupRow[];

    // 按 client_id 归并
    const byClient = new Map<string, ClientAgg>();
    for (const g of groups) {
      let c = byClient.get(g.clientId);
      if (!c) {
        c = {
          clientId: g.clientId,
          requests: 0,
          tokens: 0,
          credits: 0,
          lastSeen: 0,
          keyHint: null,
          boundName: g.boundName,
          keyName: g.keyName,
          keyExists: g.keyExistsId !== null,
          models: new Set(),
          ruleCounts: new Map(),
        };
        byClient.set(g.clientId, c);
      }
      c.requests += g.requests;
      c.tokens += g.tokens;
      c.credits += g.credits;
      if (g.lastSeen > c.lastSeen) c.lastSeen = g.lastSeen;
      // 与原 SQL 的 MAX(r.key_hint) 同义：忽略 NULL，取字典序最大
      if (g.keyHint !== null && (c.keyHint === null || g.keyHint > c.keyHint)) c.keyHint = g.keyHint;
      c.models.add(g.model);
      c.ruleCounts.set(g.rule, (c.ruleCounts.get(g.rule) ?? 0) + g.requests);
    }

    const aggs = [...byClient.values()].sort((a, b) => b.credits - a.credits);
    const totalTokens = aggs.reduce((s, r) => s + r.tokens, 0);

    const items = aggs.map((r) => {
      const rule = normalizeRule(dominantRule(r.ruleCounts));
      // client_id 就是密钥 id：密钥还在则该客户端名下就这一把密钥，已删则没有。
      const boundKeyIds = r.keyExists ? [r.clientId] : [];
      return {
        clientId: r.clientId,
        client: resolveClientName({
          clientId: r.clientId,
          boundName: r.boundName,
          keyName: r.keyName,
          keyExists: r.keyExists,
          keyHint: r.keyHint,
        }),
        rule,
        ruleLabel: RULE_LABELS[rule],
        requests: r.requests,
        credits: round2(r.credits),
        // 模型清单按 id 排序（与原 SQL 的 ORDER BY model 一致）
        models: [...r.models].sort(),
        lastSeenAt: toIso(r.lastSeen),
        boundKeyIds,
        // 兜底客户端（client_id = 'unidentified'）本身不是命名过的客户端
        named: r.clientId !== UNIDENTIFIED_ID,
        /* [2026-10-18 修口径] 分母必须是 token、与 overview 的同名字段同量纲。
           此前是 `share(r.credits, totalCredits)` —— 同一个 `share` 在
           `/api/clients` 是积分占比、在 `/api/overview` 是 token 占比，
           而契约 §3.4「share 口径」只定义了一种（token ÷ 本窗口 totalTokens）。 */
        share: share(r.tokens, totalTokens),
      } satisfies ClientItem;
    });

    return { items, byProvider: this.byProvider(groups) };
  }

  /**
   * [v0.6.0] 按**目录归属的提供商**聚合用量 —— 归因口径与请求日志「提供商」列、
   * overview.byClient 完全同源（模型 id → 生效目录的 provider，同 id 先到先得）。
   * 模型不在任何生效目录里的行归到 providerId=null 桶（前端不显示在任一行上，不冒充）。
   * 数据直接复用 list() 的主聚合结果（同一窗口同一次扫描），不再单独查库。
   */
  private byProvider(groups: GroupRow[]): Array<{
    providerId: string | null;
    provider: string | null;
    requests: number;
    tokens: number;
    credits: number;
    lastSeenAt: string | null;
  }> {
    if (!this.providers || !this.catalog) return [];
    const providerName = new Map(this.providers.list().map((p) => [p.id, p.name]));
    const idByName = new Map([...providerName.entries()].map(([id, name]) => [name, id]));
    const providerByModel = new Map<string, string>();
    for (const row of this.catalog.allAcross(this.providers.listActive().map((p) => p.id))) {
      if (!providerByModel.has(row.id)) {
        providerByModel.set(row.id, providerName.get(row.provider_id) ?? row.provider_id);
      }
    }
    const bucket = new Map<string, { providerId: string | null; provider: string | null; requests: number; tokens: number; credits: number; lastSeen: number }>();
    for (const r of groups) {
      /* [2026-10-18] 空 model（模型解析前被本地拒绝，实测全是 429）不属于任何提供商，
         也不该落进「未归属」桶 —— overview 的 byProvider 同样排除它。
         两边口径必须一致，否则同一窗口下两个「提供商」视图的请求数对不上。
         （注意：byClient 的 items 仍包含这些行 —— 它们确实来自某把密钥，
           「这个客户端打了多少次」应当包含被拒的那几次。） */
      if (r.model === '') continue;
      /* [v1.6.30] 优先用真实路由结果；老行（无 provider_id）才按目录反解。
         反解按创建序，路由按密钥绑定优先 —— 两者可能指向不同的家。 */
      const name = r.providerId
        ? (providerName.get(r.providerId) ?? r.providerId)
        : (providerByModel.get(r.model) ?? null);
      const pid = name ? idByName.get(name) ?? null : null;
      const key = pid ?? '__unattributed__';
      let b = bucket.get(key);
      if (!b) {
        b = { providerId: pid, provider: name, requests: 0, tokens: 0, credits: 0, lastSeen: 0 };
        bucket.set(key, b);
      }
      b.requests += r.requests;
      b.tokens += r.tokens;
      b.credits += r.credits;
      if (r.lastSeen > b.lastSeen) b.lastSeen = r.lastSeen;
    }
    return [...bucket.values()].map((b) => ({
      providerId: b.providerId,
      provider: b.provider,
      requests: b.requests,
      tokens: b.tokens,
      credits: round2(b.credits),
      lastSeenAt: b.lastSeen ? toIso(b.lastSeen) : null,
    }));
  }
}

/** 出现次数最多的规则；并列时取规则号较小者（确定性，原 SQL 并列时顺序未定义）。 */
function dominantRule(counts: Map<number | null, number>): number | null {
  let best: number | null = null;
  let bestN = -1;
  for (const [rule, n] of counts) {
    const better = n > bestN || (n === bestN && rule !== null && (best === null || rule < best));
    if (better) {
      best = rule;
      bestN = n;
    }
  }
  return best;
}

function normalizeRule(raw: number | null): ClientRule {
  return raw === 1 || raw === 2 || raw === 3 || raw === 4 ? raw : 4;
}
