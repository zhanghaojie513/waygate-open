/**
 * 每把密钥累计用量的进程内缓存（Token 配额 / 最大 IP 数判定、/v1/usage、密钥列表共用）。
 *
 * ## 为什么需要
 * 「累计 tokens」「去重来源 IP 数」「总请求数」原本每次都对 `requests` 表里这把密钥的**全部历史行**
 * 现算（SUM / COUNT DISTINCT / COUNT）。better-sqlite3 是同步的 —— 实测每把密钥 10 万行时，
 * 仅 SUM(total_tokens) 一条就要 ~58ms，期间整个事件循环（含所有正在转发的 SSE 流）被占住；
 * 而配了 Token 配额的密钥**每个请求**都要过一次这条查询，且耗时随日志量线性增长。
 *
 * ## 一致性模型
 *   - 首次读取某把密钥的某一项时从库里算一次（懒加载），之后由写路径**增量维护**：
 *     `RequestsRepository.log()` 事务提交后调 `onInsert`，对已加载的项做 +tokens / +IP / +1。
 *   - 任何删除（清空日志 / 保留期清理）→ `invalidateAll()`，下次读取重新从库里算。
 *   - **进程外写入**（运维脚本直接改库，如 `tools/cleanup-test-requests.mjs`）：每次读取前比对
 *     `PRAGMA data_version` —— 它只在**其他连接**提交写入时变化（本连接自己的提交不变），
 *     变了就整体作废。单次 ~5µs，足够放在每次判定前。
 *   - 本缓存只服务于「用量判定 / 展示」，与 `requests` 表口径完全一致（同样的 WHERE 条件），
 *     不改变配额的软校验语义（进入前查累计，最后一笔可超出）。
 *
 * 每个数据库连接一份（WeakMap 按 Db 实例索引）：两个仓库各自构造时拿到的是同一份，
 * 测试里每个内存库互相隔离，无需改 DI。
 */
import type Database from 'better-sqlite3';
import type { Db } from './db';

interface Usage {
  /** 累计 total_tokens；null = 尚未加载 */
  tokens: number | null;
  /** 去重来源 IP 集合（与 SQL 同口径：排除 NULL 与空串）；null = 尚未加载 */
  ips: Set<string> | null;
  /** 总请求数；null = 尚未加载 */
  requests: number | null;
}

/** 变参语句类型（同 cached-stmt.ts：ReturnType<Db['prepare']> 会命中重载最后一个签名，把参数固定成单元素元组） */
type Statement = Database.Statement<unknown[], unknown>;

export class KeyUsageCache {
  private readonly entries = new Map<string, Usage>();
  private readonly versionStmt: Statement;
  private readonly tokensStmt: Statement;
  private readonly ipsStmt: Statement;
  private readonly countStmt: Statement;
  private version: number;

  constructor(db: Db) {
    this.versionStmt = db.prepare('PRAGMA data_version').pluck();
    this.tokensStmt = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) FROM requests WHERE key_id = ?').pluck();
    this.ipsStmt = db
      .prepare("SELECT DISTINCT remote_ip FROM requests WHERE key_id = ? AND remote_ip IS NOT NULL AND remote_ip <> ''")
      .pluck();
    this.countStmt = db.prepare('SELECT COUNT(*) FROM requests WHERE key_id = ?').pluck();
    this.version = this.versionStmt.get() as number;
  }

  /** 累计 tokens（与 `SUM(total_tokens) WHERE key_id = ?` 同值）。 */
  tokensUsed(keyId: string): number {
    const u = this.entry(keyId);
    if (u.tokens === null) u.tokens = this.tokensStmt.get(keyId) as number;
    return u.tokens;
  }

  /** 去重来源 IP 数（与 `COUNT(DISTINCT remote_ip)` 同口径）。 */
  distinctIps(keyId: string): number {
    const u = this.entry(keyId);
    if (u.ips === null) u.ips = new Set(this.ipsStmt.all(keyId) as string[]);
    return u.ips.size;
  }

  /** 总请求数（与 `COUNT(*) WHERE key_id = ?` 同值）。 */
  requestCount(keyId: string): number {
    const u = this.entry(keyId);
    if (u.requests === null) u.requests = this.countStmt.get(keyId) as number;
    return u.requests;
  }

  /**
   * 一行请求日志**已提交**后调用：只更新已加载的项（未加载的项下次读取时从库里算，自然包含这一行）。
   * 必须在事务提交之后调用 —— 若在事务内调用而事务随后回滚，缓存会多计。
   */
  onInsert(keyId: string | null | undefined, totalTokens: number, remoteIp: string | null | undefined): void {
    if (!keyId) return;
    const u = this.entries.get(keyId);
    if (!u) return;
    if (u.tokens !== null) u.tokens += totalTokens;
    if (u.ips !== null && remoteIp) u.ips.add(remoteIp);
    if (u.requests !== null) u.requests += 1;
  }

  /** 请求行被删除（清空 / 保留期清理）后调用：全部作废，下次读取重算。 */
  invalidateAll(): void {
    this.entries.clear();
  }

  /** 取（或建）某把密钥的条目；先检查是否有其他连接改过库。 */
  private entry(keyId: string): Usage {
    const v = this.versionStmt.get() as number;
    if (v !== this.version) {
      // 进程外有提交（运维脚本等）：增量已不可信，整体作废
      this.version = v;
      this.entries.clear();
    }
    let u = this.entries.get(keyId);
    if (!u) {
      u = { tokens: null, ips: null, requests: null };
      this.entries.set(keyId, u);
    }
    return u;
  }
}

const caches = new WeakMap<Db, KeyUsageCache>();

/** 取该数据库连接对应的唯一缓存实例（读写两侧必须共享同一份）。 */
export function keyUsageCacheFor(db: Db): KeyUsageCache {
  let c = caches.get(db);
  if (!c) {
    c = new KeyUsageCache(db);
    caches.set(db, c);
  }
  return c;
}
