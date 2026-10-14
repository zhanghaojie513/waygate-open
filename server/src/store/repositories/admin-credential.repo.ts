/**
 * 管理口令的持久化（admin_credential 表，恒为 id=1 的单行表）。
 *
 * ## 为什么单独一个 repo，而不是塞进 AdminCredentialService
 * 服务层要处理「环境变量 > 数据库 > 首次生成」的优先级、热更新、明文只出一次
 * 这些**策略**；repo 只管**存取**。分开之后：
 *   - 策略可以单测（注入一个假的 repo，不碰数据库）
 *   - 存储位置将来再变（比如换成系统 keyring）只改这一个文件
 *
 * ## 单行表的意义
 * `CHECK (id = 1)` 让「口令有且只有一条」这条约束由**数据库**保证，
 * 而不是靠调用方自觉。写的时候一律用 upsert，不需要先查再判断。
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db';

/** 单行表固定主键。 */
const SINGLETON_ID = 1;

export interface AdminCredentialRow {
  hash: string;
  source: 'generated' | 'console';
  updated_at: number;
  rotated_at: number | null;
}

@Injectable()
export class AdminCredentialRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** 读当前口令行。表为空（从未写过）时返回 null。 */
  get(): AdminCredentialRow | null {
    const row = this.db
      .prepare(
        'SELECT hash, source, updated_at, rotated_at FROM admin_credential WHERE id = ?',
      )
      .get(SINGLETON_ID) as AdminCredentialRow | undefined;
    return row ?? null;
  }

  /**
   * 写入（或覆盖）口令哈希。
   *
   * `rotatedAt` 只在「主动改密 / 重置」时传；首次生成不传（保持 NULL）。
   * 用 `ON CONFLICT(id) DO UPDATE` 而不是先删后插：单条语句原子完成，
   * 不会出现「删了旧的、新的还没写进去」的中间态。
   */
  upsert(hash: string, source: 'generated' | 'console', rotatedAt?: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO admin_credential (id, hash, source, updated_at, rotated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hash       = excluded.hash,
           source     = excluded.source,
           updated_at = excluded.updated_at,
           rotated_at = COALESCE(excluded.rotated_at, admin_credential.rotated_at)`,
      )
      .run(SINGLETON_ID, hash, source, now, rotatedAt ?? null);
  }
}
