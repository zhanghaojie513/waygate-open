import type Database from 'better-sqlite3';
import type { Db } from './db';

/** 变参语句类型：调用点都是 `.get(a, b)` / `.all(...params, limit, offset)` 展开，
    不能用 `ReturnType<Db['prepare']>` —— 它会命中 prepare 重载的最后一个签名，
    把参数固定成单元素元组（TS2554 Expected 1 arguments）。 */
type AnyStatement = Database.Statement<unknown[], unknown>;

/** 按 SQL 文本缓存的 prepare：同一文本只编译一次，之后复用语句对象。
 *
 * better-sqlite3 的 prepare 是同步编译；概览聚合 / 明细筛选这类查询路径若每次
 * 调用都内联 `db.prepare(...)`，等于每个请求都重付一遍编译成本（语句模板其实
 * 只有有限几种形状：窗口桶 × 筛选组合）。SQL 全部来自代码里的固定模板 ——
 * 动态部分（WHERE 子句、ORDER BY 白名单、hour/day 桶）取值集合有限，
 * 缓存大小天然有界，不需要淘汰策略。
 *
 * 热路径的插入/点查仍建议走构造器一次性 prepare（见 requests.repo.ts 的先例）；
 * 本帮助器面向「模板有限但写不进构造器」的动态查询。 */
export function createStmtCache(db: Db): (sql: string) => AnyStatement {
  const cache = new Map<string, AnyStatement>();
  return (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
}
