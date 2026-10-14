import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

/** providers 表的一行（snake_case 与列名一致，仓储层不做命名转换）。 */
export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  active: number;
  /** [v0.5.0] 上游方言：'openai'（WorkBuddy）| 'anthropic'（mavis / Anthropic 兼容）。 */
  protocol: string;
  /** [v0.5.0] 聊天端点路径；NULL = 协议默认。 */
  chat_path: string | null;
  /** [v0.5.0] 凭证生命周期：'static'（发出去的就是文件里存的）| 'oauth_minimax'（refresh→access）。 */
  cred_kind: string;
  /** [v0.5.0] oauth access token 过期时刻（epoch ms）；非敏感，令牌本体在文件里。 */
  access_expires_at: number | null;
  /** [v0.5.6] 最近成功签到的本地日期（Asia/Shanghai，YYYY-MM-DD）—— 当日幂等闸。 */
  signin_checked_on: string | null;
  /** [v0.5.6] 连续签到天数 / 最近领到的积分（仅展示）。 */
  signin_streak: number | null;
  signin_last_points: number | null;
  /** [v1.3.0] WorkBuddy 签到（与 MiniMax signin_* 分列：签到语义不同源）。 */
  wb_signin_checked_on: string | null;
  wb_signin_streak: number | null;
  wb_signin_last_points: number | null;
  /** [v1.4.0] WorkBuddy OAuth access 过期时刻（epoch ms；令牌在 .oauth 文件）。 */
  wb_oauth_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  active: boolean;
  /** [v0.5.0] 缺省 'openai'（旧行为）。 */
  protocol?: string;
  /** [v0.5.0] 缺省 'static'（旧行为）。 */
  credKind?: string;
}

@Injectable()
export class ProvidersRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly byIdStmt;
  private readonly activeStmt;
  private readonly clearOneStmt;
  private readonly activeListStmt;
  private readonly setActiveStmt;
  private readonly patchStmt;
  private readonly deleteStmt;
  private readonly countStmt;

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO providers (id, name, base_url, active, protocol, cred_kind, created_at, updated_at)
       VALUES (@id, @name, @baseUrl, @active, @protocol, @credKind, @now, @now)`,
    );
    this.listStmt = db.prepare('SELECT * FROM providers ORDER BY created_at ASC');
    this.byIdStmt = db.prepare('SELECT * FROM providers WHERE id = ?');
    this.activeStmt = db.prepare('SELECT * FROM providers WHERE active = 1');
    /* [v0.5.1] 多生效：全量列表 + 单行停用。 */
    this.activeListStmt = db.prepare('SELECT * FROM providers WHERE active = 1 ORDER BY created_at ASC');
    this.clearOneStmt = db.prepare('UPDATE providers SET active = 0, updated_at = ? WHERE id = ?');
    this.setActiveStmt = db.prepare('UPDATE providers SET active = 1, updated_at = ? WHERE id = ?');
    this.patchStmt = db.prepare(
      `UPDATE providers SET
         name      = COALESCE(@name, name),
         base_url  = COALESCE(@baseUrl, base_url),
         updated_at = @now
       WHERE id = @id`,
    );
    this.deleteStmt = db.prepare('DELETE FROM providers WHERE id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM providers');
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  list(): ProviderRow[] {
    return this.listStmt.all() as ProviderRow[];
  }

  findById(id: string): ProviderRow | undefined {
    return this.byIdStmt.get(id) as ProviderRow | undefined;
  }

  /** 当前生效的提供商。理论上恒有一行；表空（未种子）时返回 undefined。 */
  findActive(): ProviderRow | undefined {
    return this.activeStmt.get() as ProviderRow | undefined;
  }

  create(input: CreateProviderInput): void {
    this.insertStmt.run({
      ...input,
      active: input.active ? 1 : 0,
      protocol: input.protocol ?? 'openai',
      credKind: input.credKind ?? 'static',
      now: Date.now(),
    });
  }

  /**
   * [v0.5.1] 激活 = 置位**且不再互斥**（多提供商同时生效）。
   * 单条 UPDATE 无中间态问题；找不到行仍抛错（调用方 404 语义）。
   */
  activate(id: string): void {
    const info = this.setActiveStmt.run(Date.now(), id);
    if (info.changes === 0) throw new Error(`providers.activate：找不到 ${id}`);
  }

  /** [v0.5.1] 停用（是否保留至少一家由服务层把关）。 */
  deactivate(id: string): void {
    this.clearOneStmt.run(Date.now(), id);
  }

  /** [v0.5.1] 全部生效中的提供商（多生效路由的候选全集），按创建序稳定。 */
  listActive(): ProviderRow[] {
    return this.activeListStmt.all() as ProviderRow[];
  }

  patch(id: string, patch: { name?: string; baseUrl?: string }): void {
    this.patchStmt.run({ id, name: patch.name ?? null, baseUrl: patch.baseUrl ?? null, now: Date.now() });
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  /** [v0.5.6] 记一次成功签到（日期 + 连续天数 + 本次积分）。 */
  setSignin(id: string, checkedOn: string, streak: number | null, points: number | null): void {
    this.db
      .prepare(
        'UPDATE providers SET signin_checked_on = ?, signin_streak = ?, signin_last_points = ?, updated_at = ? WHERE id = ?',
      )
      .run(checkedOn, streak, points, Date.now(), id);
  }

  /** [v1.4.0] 记录 WorkBuddy OAuth access 过期时刻（刷新器调用；只落时间不落令牌）。 */
  setWbOAuthExpiry(id: string, expiresAt: number): void {
    this.db
      .prepare('UPDATE providers SET wb_oauth_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(expiresAt, Date.now(), id);
  }

  /** [v1.3.0] 记一次 WorkBuddy 成功签到（日期 + 连签天数 + 本次积分）。 */
  setWbSignin(id: string, checkedOn: string, streak: number | null, points: number | null): void {
    this.db
      .prepare(
        'UPDATE providers SET wb_signin_checked_on = ?, wb_signin_streak = ?, wb_signin_last_points = ?, updated_at = ? WHERE id = ?',
      )
      .run(checkedOn, streak, points, Date.now(), id);
  }

  /** [v0.5.0] 记录 oauth access token 过期时刻（刷新器调用；只落时间不落令牌）。 */
  setAccessExpiry(id: string, expiresAt: number): void {
    this.db
      .prepare('UPDATE providers SET access_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(expiresAt, Date.now(), id);
  }
}
