import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';
import { keyUsageCacheFor, type KeyUsageCache } from '../key-usage-cache';

export interface ClientKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_hint: string;
  scope: string;
  client: string | null;
  /** [v0.4.20] 绑定的提供商名有序数组（JSON 文本），第 1 项优先级最高。 */
  clients: string;
  /** [v0.4.35] IP 白名单（JSON 文本，条目已归一化），空数组 = 不限。 */
  ip_whitelist: string;
  /** [v0.4.35] 最大 IP 数；NULL = 不限。 */
  max_ips: number | null;
  /** [v0.4.35] Token 配额（累计 total_tokens 上限）；NULL = 不限。 */
  token_quota: number | null;
  enabled: number;
  expires_at: number | null;
  source: string;
  created_at: number;
  last_seen_at: number | null;
  last_seen_ip: string | null;
}

export interface CreateKeyInput {
  id: string;
  name: string;
  keyHash: string;
  keyHint: string;
  scope: string;
  client: string | null;
  /** [v0.4.20] 有序提供商数组的 JSON 文本（'[]' = 未绑定）。省略时由 client 推导。 */
  clients?: string;
  /** [v0.4.35] IP 白名单的 JSON 文本（'[]' = 不限）。 */
  ipWhitelist?: string;
  /** [v0.4.35] 最大 IP 数（null = 不限）。 */
  maxIps?: number | null;
  /** [v0.4.35] Token 配额（null = 不限）。 */
  tokenQuota?: number | null;
  expiresAt: number | null;
  source: 'console' | 'env';
}

/** [v0.4.20] 解析 clients 列（JSON 文本 → 字符串数组），脏数据按空数组处理。 */
export function parseClients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } catch {
    /* 脏数据按未绑定处理，不让它把密钥页打挂 */
  }
  return [];
}

export type KeyScope =
  | { type: 'all' }
  | { type: 'family'; value: string }
  | { type: 'tag'; value: string }
  | { type: 'models'; value: string[] };

export function parseScope(raw: string | null | undefined): KeyScope {
  if (!raw) return { type: 'all' };
  try {
    const parsed = JSON.parse(raw) as KeyScope;
    if (parsed && typeof parsed.type === 'string') return parsed;
  } catch {
    /* 脏数据按 all 处理，不让它把鉴权打挂 */
  }
  return { type: 'all' };
}

/** [v0.4.35] 解析 ip_whitelist 列（JSON 文本 → 字符串数组），脏数据按空名单处理。 */
export function parseIpWhitelist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } catch {
    /* 脏数据按不限处理 —— 白名单失效的失效模式是「放行」，与 parseClients 同思路 */
  }
  return [];
}

@Injectable()
export class ClientKeysRepository {
  private readonly insertStmt;
  private readonly byHashStmt;
  private readonly byIdStmt;
  private readonly listStmt;
  private readonly touchStmt;
  private readonly patchStmt;
  private readonly patchClientStmt;
  private readonly patchPolicyStmt;
  private readonly deleteStmt;
  private readonly deleteAllStmt;
  private readonly byClientStmt;
  private readonly ipSeenStmt;
  /** 密钥累计用量缓存（与 RequestsRepository 共享同一份，见 key-usage-cache.ts）。 */
  private readonly usage: KeyUsageCache;

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {
    this.usage = keyUsageCacheFor(db);
    this.insertStmt = db.prepare(
      `INSERT INTO client_keys
         (id, name, key_hash, key_hint, scope, client, clients, ip_whitelist, max_ips, token_quota, enabled, expires_at, source, created_at)
       VALUES (@id, @name, @keyHash, @keyHint, @scope, @client, @clients, @ip_whitelist, @max_ips, @token_quota, 1, @expiresAt, @source, @createdAt)`,
    );
    this.byHashStmt = db.prepare('SELECT * FROM client_keys WHERE key_hash = ?');
    this.byIdStmt = db.prepare('SELECT * FROM client_keys WHERE id = ?');
    this.listStmt = db.prepare('SELECT * FROM client_keys ORDER BY created_at DESC');
    this.touchStmt = db.prepare('UPDATE client_keys SET last_seen_at = ?, last_seen_ip = ? WHERE id = ?');
    this.patchStmt = db.prepare(
      `UPDATE client_keys SET
         name    = COALESCE(@name, name),
         enabled = COALESCE(@enabled, enabled)
       WHERE id = @id`,
    );
    /* client / clients 各一条语句：它们要能**被清空**（解绑），而 COALESCE 做不到 ——
       传 null 会被当成"没传"，原绑定被静默保留。走"字段存在才更新"的语义
       （服务层负责只在带了该字段时传进来）。两者服务端总是同时更新，保持一致。 */
    this.patchClientStmt = db.prepare('UPDATE client_keys SET client = @client, clients = @clients WHERE id = @id');
    /* [v0.4.35] 访问策略三列同理：要能清空（null = 不限），整组覆写 ——
       服务层把"没传的字段"回填成现值后调用，这里不区分部分/整体。 */
    this.patchPolicyStmt = db.prepare(
      'UPDATE client_keys SET ip_whitelist = @ipWhitelist, max_ips = @maxIps, token_quota = @tokenQuota WHERE id = @id',
    );
    this.deleteStmt = db.prepare('DELETE FROM client_keys WHERE id = ?');
    this.deleteAllStmt = db.prepare('DELETE FROM client_keys');
    this.byClientStmt = db.prepare('SELECT id FROM client_keys WHERE client = ?');
    /* [v0.4.35] 策略判定：「这个 IP 用过没」走 idx_requests_key_ip 点查（微秒级，直接查库）；
       累计 tokens / 去重 IP 数 / 总请求数是全量聚合，走 KeyUsageCache（见 key-usage-cache.ts）。 */
    this.ipSeenStmt = db.prepare('SELECT 1 AS hit FROM requests WHERE key_id = ? AND remote_ip = ? LIMIT 1');
  }

  create(input: CreateKeyInput): void {
    /* [v0.4.20] 兼容未传 clients 的调用方：从 client 单值推导。 */
    const clients = input.clients ?? JSON.stringify(input.client ? [input.client] : []);
    this.insertStmt.run({
      ...input,
      clients,
      ip_whitelist: input.ipWhitelist ?? '[]',
      max_ips: input.maxIps ?? null,
      token_quota: input.tokenQuota ?? null,
      createdAt: Date.now(),
    });
  }

  findByHash(hash: string): ClientKeyRow | null {
    return (this.byHashStmt.get(hash) as ClientKeyRow | undefined) ?? null;
  }

  findById(id: string): ClientKeyRow | null {
    return (this.byIdStmt.get(id) as ClientKeyRow | undefined) ?? null;
  }

  list(): ClientKeyRow[] {
    return this.listStmt.all() as ClientKeyRow[];
  }

  /**
   * 记录密钥最近一次使用（last_seen_at / last_seen_ip）。
   *
   * 性能：每个代理请求都会调到这里，原先每次都是一次独立的 UPDATE 提交。
   * 现在按 (密钥, IP) 节流：同一 IP 在 TOUCH_THROTTLE_MS 内重复使用只跳过写库；
   * IP 变化总是立即落库（last_seen_ip 不会滞后）。代价：last_seen_at 最多滞后 60 秒，
   * 对「多久没被用过」这一用途可忽略。节流表在进程内，重启后首个请求必写。
   */
  touch(id: string, ip: string | null, now: number = Date.now()): void {
    const last = this.lastTouch.get(id);
    if (last && last.ip === ip && now - last.at < ClientKeysRepository.TOUCH_THROTTLE_MS) return;
    this.touchStmt.run(now, ip, id);
    this.lastTouch.set(id, { at: now, ip });
  }

  private static readonly TOUCH_THROTTLE_MS = 60_000;
  /** 节流表：密钥 id → 上次落库的时间与 IP（密钥数量有限，不需要淘汰）。 */
  private readonly lastTouch = new Map<string, { at: number; ip: string | null }>();

  /**
   * 局部更新。`client`/`clients` 用**字段存在性**判定：带了任一才更新，且能传 null/[] 解绑。
   * 其余字段沿用 COALESCE（未带 = 不动）。理由见构造器里 patchClientStmt 的注释。
   *
   * [v0.4.20] 兼容单值调用：只传 `client`（不带 clients）时，clients 自动推成
   * `[client]` 或 `[]` —— 老调用方（测试 / 内部代码）无需改动。
   */
  patch(
    id: string,
    patch: { name?: string; enabled?: number; client?: string | null; clients?: string },
  ): void {
    this.patchStmt.run({
      id,
      name: patch.name ?? null,
      enabled: patch.enabled ?? null,
    });
    if ('client' in patch || 'clients' in patch) {
      const clientsJson =
        patch.clients !== undefined
          ? patch.clients
          : JSON.stringify(patch.client ? [patch.client] : []);
      this.patchClientStmt.run({ id, client: patch.client ?? null, clients: clientsJson });
    }
  }

  remove(id: string): number {
    return this.deleteStmt.run(id).changes;
  }

  /** [v0.4.35] 整组覆写访问策略（IP 白名单 JSON / 最大 IP 数 / Token 配额）。 */
  patchPolicy(id: string, policy: { ipWhitelist: string; maxIps: number | null; tokenQuota: number | null }): void {
    this.patchPolicyStmt.run({ id, ...policy });
  }

  /** [v0.4.35] 这把密钥的累计用量：不同来源 IP 数 + 累计 tokens + 总请求数（v0.4.36）。 */
  usageForKey(keyId: string): { distinctIps: number; tokensUsed: number; requestsTotal: number } {
    // 三项都走用量缓存：/v1/usage 与密钥列表不再每次对整段历史做 3 条全量聚合
    return {
      distinctIps: this.usage.distinctIps(keyId),
      tokensUsed: this.usage.tokensUsed(keyId),
      requestsTotal: this.usage.requestCount(keyId),
    };
  }

  /* 鉴权热路径专用的单项查询：配额判定只需要 tokens、IP 上限判定只需要去重 IP 数。
     走用量缓存：首次从库里算，之后随写入增量维护（原先每个请求都对整段历史做 SUM，
     每把密钥 10 万行时单次 ~58ms，期间事件循环被占住）。 */

  /** 累计 tokens（Token 配额判定用）。 */
  tokensUsedForKey(keyId: string): number {
    return this.usage.tokensUsed(keyId);
  }

  /** 不同来源 IP 数（最大 IP 数判定用）。 */
  distinctIpsForKey(keyId: string): number {
    return this.usage.distinctIps(keyId);
  }

  /** [v0.4.35] 这个来源 IP 是否用过这把密钥（最大 IP 数判定用：老 IP 不占新名额）。 */
  ipSeenForKey(keyId: string, ip: string): boolean {
    return (this.ipSeenStmt.get(keyId, ip) as { hit: number } | undefined) !== undefined;
  }

  removeAll(): number {
    return this.deleteAllStmt.run().changes;
  }

  idsByClient(client: string): string[] {
    return (this.byClientStmt.all(client) as Array<{ id: string }>).map((r) => r.id);
  }

  countByName(name: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM client_keys WHERE name = ?')
      .get(name) as { n: number };
    return row.n;
  }
}
