import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

/** 数据目录。仓库内默认 ./data；部署时 systemd 把它指向 /var/lib/relay。 */
export function resolveDataDir(): string {
  const configured = (process.env.RELAY_DATA_DIR ?? '').trim();
  return configured || join(process.cwd(), 'data');
}

export const DB_PATH_TOKEN = 'RELAY_DB_PATH';
export const DB_TOKEN = 'RELAY_DB';

/**
 * 打开（必要时创建）数据库并施加 ADR-002 规定的三条 PRAGMA，外加一组性能 PRAGMA。
 * WAL 不能在事务内切换，因此 PRAGMA 一律在事务外执行。
 *
 * 性能 PRAGMA 的取舍（单进程、单连接、同步 better-sqlite3；部署机 2C2G）：
 *   - busy_timeout 5000：显式写出（不依赖驱动默认值），外部工具（verify-all / 备份）持锁时等待而非立刻 SQLITE_BUSY。
 *   - cache_size -16000：页缓存 16MB（默认约 2MB）。概览类窗口聚合反复扫 requests，热页留在进程内。
 *   - mmap_size 128MB：读走内存映射，省一次内核→用户态拷贝；映射页属于可回收的 page cache，不计入 V8 堆。
 *   - temp_store MEMORY：GROUP BY / ORDER BY 建的临时 B 树不落盘。
 *   - journal_size_limit 64MB：大批 DELETE（保留期清理）后 WAL 文件截回上限，不长期占盘。
 *   - optimize=0x10002：打开时对"缺统计/统计过期"的表按需 ANALYZE（SQLite ≥ 3.46 推荐的长连接用法），
 *     让查询规划器在多个相互重叠的 requests 索引间按真实分布选择，而非启发式。
 *   - analysis_limit 1000：显式掩码 0x10002 **不含** 0x10 位（「ANALYZE 时设临时 analysis_limit」只在默认掩码里），
 *     不设上限时首次启动（索引全无统计）会对 requests 全表 ANALYZE，大库下拖慢启动数秒。
 *     每个索引只采样约 1000 行，统计精度对索引选择已足够（https://www.sqlite.org/pragma.html#pragma_analysis_limit）。
 */
export function openDatabase(file?: string): Db {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(file ?? join(dir, 'relay.db'), { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -16000');
  db.pragma('mmap_size = 134217728');
  db.pragma('temp_store = MEMORY');
  db.pragma('journal_size_limit = 67108864');
  db.pragma('analysis_limit = 1000');
  return db;
}

/**
 * 让 SQLite 按需刷新查询规划统计（sqlite_stat1）。
 * 必须在 schema 迁移完成**之后**调用（新建的表/索引才会被纳入）；开销通常为毫秒级，
 * 由 retention 每日清理后再调一次，保证数据分布变化后统计不过期。
 */
export function optimizeDatabase(db: Db): void {
  db.pragma('optimize = 0x10002');
}
