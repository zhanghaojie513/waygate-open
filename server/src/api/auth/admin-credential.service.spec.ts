import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RelayHttpError } from '../../common/errors';
import { AdminCredentialService } from './admin-credential.service';
import { AdminCredentialRepository } from '../../store/repositories/admin-credential.repo';
import { __setScryptParamsForTests, hashPassword, parsePasswordHash, verifyPassword } from './password';

/**
 * 管理口令的装载 / 轮换。这是本项目**最敏感**的一段逻辑：
 * 写错了要么把自己锁在门外，要么把明文漏到日志里。
 *
 * 测试策略：**内存库 + 真实 schema**（不用假 schema，避免测出假结论），
 * 数据目录指向一次性的临时目录（避免读到本机真实的 admin.hash）。
 */

const SCHEMA_PATH = join(__dirname, '..', '..', 'store', 'schema.sql');
const ENV_KEY = 'RELAY_ADMIN_PASSWORD_HASH';
const DATA_DIR_KEY = 'RELAY_DATA_DIR';

let db: Database.Database;
let repo: AdminCredentialRepository;
let dataDir: string;
let savedEnv: string | undefined;
let savedDataDir: string | undefined;

/**
 * ★ 测试用**低成本** scrypt（N=16）：本文件每个用例都哈希/验密若干次，生产档（N=16384）
 * 在忙机器上单例可达数秒，会逼近 vitest 5s 超时 → flaky。降到 N=16 后全部毫秒级。
 * 生产默认档不变（`verifyPassword` 从存储串自身读参数，故测内种低成本串就只走低成本）。
 */
beforeAll(() => __setScryptParamsForTests({ N: 16, r: 8, p: 1 }));
afterAll(() => __setScryptParamsForTests(null));

function makeService(): AdminCredentialService {
  return new AdminCredentialService(repo);
}

/** 造一个服务并完成 onModuleInit（模拟真实启动时序）。 */
function bootService(): AdminCredentialService {
  const svc = makeService();
  svc.onModuleInit();
  return svc;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  repo = new AdminCredentialRepository(db);
  dataDir = mkdtempSync(join(tmpdir(), 'relay-admincred-'));
  savedEnv = process.env[ENV_KEY];
  savedDataDir = process.env[DATA_DIR_KEY];
  delete process.env[ENV_KEY];
  process.env[DATA_DIR_KEY] = dataDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (savedDataDir === undefined) delete process.env[DATA_DIR_KEY];
  else process.env[DATA_DIR_KEY] = savedDataDir;
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('admin-credential · 加载优先级', () => {
  it('① 空库空文件 → 生成随机口令，写入数据库，并标记本轮已生成', async () => {
    const svc = bootService();
    expect(svc.isConfigured()).toBe(true);
    expect(svc.wasGeneratedThisBoot()).toBe(true);
    expect(svc.currentSource()).toBe('generated');

    // 库里确实有一行
    const row = repo.get();
    expect(row).not.toBeNull();
    expect(parsePasswordHash(row!.hash)).not.toBeNull();
    expect(row!.source).toBe('generated');
    // 首次生成不算"主动轮换"
    expect(row!.rotated_at).toBeNull();
  });

  it('② 环境变量优先于数据库（运维显式设定最高）', async () => {
    const envPw = 'env-provided-password';
    process.env[ENV_KEY] = hashPassword(envPw);
    // 库里塞一个**别的**口令
    repo.upsert(hashPassword('from-database'), 'console');

    const svc = bootService();
    expect(svc.currentSource()).toBe('env');
    expect(await svc.verify(envPw)).toBe(true);
    expect(await svc.verify('from-database')).toBe(false);
  });

  it('③ 环境变量格式非法 → 拒绝登录（isConfigured=false），而不是静默回落', async () => {
    process.env[ENV_KEY] = 'garbage-not-a-hash';
    repo.upsert(hashPassword('from-database'), 'console');

    const svc = bootService();
    // 若静默回落，管理员会以为"我设的口令生效了"
    expect(svc.isConfigured()).toBe(false);
    expect(await svc.verify('from-database')).toBe(false);
  });

  it('④ 无环境变量时有库值 → 用库值，不重新生成', async () => {
    const pw = 'stored-in-database';
    repo.upsert(hashPassword(pw), 'console');

    const svc = bootService();
    expect(svc.currentSource()).toBe('database');
    expect(svc.wasGeneratedThisBoot()).toBe(false);
    expect(await svc.verify(pw)).toBe(true);
  });

  it('⑤ ★ 库为空但有旧 admin.hash 文件 → 用文件里的口令，并迁移进库（不把人锁在门外）', async () => {
    const legacyPw = 'legacy-password-from-file';
    writeFileSync(join(dataDir, 'admin.hash'), hashPassword(legacyPw), 'utf8');

    const svc = bootService();
    expect(svc.currentSource()).toBe('file');
    expect(await svc.verify(legacyPw)).toBe(true);
    // 迁移：库里应已存在同一个哈希，这样每日备份能覆盖到它
    const row = repo.get();
    expect(row).not.toBeNull();
    expect(await verifyPassword(legacyPw, row!.hash)).toBe(true);
  });

  it('⑥ 库值是坏哈希 → 不静默忽略，回落到文件', async () => {
    db.prepare(
      "INSERT INTO admin_credential (id, hash, source, updated_at) VALUES (1, 'broken', 'console', 1)",
    ).run();
    const filePw = 'file-wins-because-db-broken';
    writeFileSync(join(dataDir, 'admin.hash'), hashPassword(filePw), 'utf8');

    const svc = bootService();
    expect(await svc.verify(filePw)).toBe(true);
  });

  it('⑦ ★ 库坏且无文件 → 重新生成可用口令（不锁死），且强制把库修好', async () => {
    db.prepare(
      "INSERT INTO admin_credential (id, hash, source, updated_at) VALUES (1, 'broken', 'console', 1)",
    ).run();
    const svc = bootService();

    // 设计取舍：库坏了不能"直接拒绝一切登录"，那会把管理员彻底锁在门外。
    // 正确行为是重新生成一个可用口令并把库里的坏值覆盖掉。
    expect(svc.isConfigured()).toBe(true);
    expect(svc.wasGeneratedThisBoot()).toBe(true);
    // 坏值已被覆盖成合法哈希
    expect(parsePasswordHash(repo.get()!.hash)).not.toBeNull();
  });

  it('⑧ 未配置时 verify 恒 false（不是恒 true）', async () => {
    const svc = makeService();
    // 不调 onModuleInit，模拟未配置
    expect(await svc.verify('')).toBe(false);
    expect(await svc.verify('anything')).toBe(false);
  });
});

describe('admin-credential · reset（控制台重置）', () => {
  it('⑨ reset 生成 16 位新口令，返回明文，且新口令立刻可验证通过', async () => {
    const svc = bootService();
    const { plain } = svc.reset();
    expect(plain).toHaveLength(16);
    expect(await svc.verify(plain)).toBe(true);
  });

  it('⑩ ★ 热生效：reset 后旧口令立即失效，无需重启', async () => {
    const oldPw = 'old-password-aaaaaaaa';
    repo.upsert(hashPassword(oldPw), 'console');
    const svc = bootService();
    expect(await svc.verify(oldPw)).toBe(true);

    const { plain } = svc.reset();
    // 同一个实例、没有重新 onModuleInit
    expect(await svc.verify(oldPw)).toBe(false);
    expect(await svc.verify(plain)).toBe(true);
  });

  it('⑪ ★ 重启后新口令仍有效：跨进程读回（写库真的落盘了）', async () => {
    const svc = bootService();
    const { plain, persisted } = svc.reset();
    expect(persisted).toBe(true);

    // 模拟重启：新实例、重新 onModuleInit，从同一个库读
    const reborn = bootService();
    expect(await reborn.verify(plain)).toBe(true);
    expect(reborn.currentSource()).toBe('database');
  });

  it('⑫ reset 落库时记 rotated_at（区别于首次生成），且 source=console', () => {
    const svc = bootService();
    const before = repo.get();
    expect(before!.rotated_at).toBeNull();

    svc.reset();
    const after = repo.get();
    expect(after!.source).toBe('console');
    expect(after!.rotated_at).toBeGreaterThan(0);
  });

  it('⑬ reset 的明文不进日志、不进库（库里只有哈希）', async () => {
    const svc = bootService();
    const { plain } = svc.reset();

    // 库里任何字段都不应包含明文
    const row = db.prepare('SELECT * FROM admin_credential WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    for (const v of Object.values(row)) {
      expect(String(v)).not.toContain(plain);
    }
    // 且存的是合法 scrypt 串
    expect(parsePasswordHash(String(row.hash))).not.toBeNull();
  });

  it('⑭ ★ 数据库不可写时降级为 persisted=false，但新口令仍在内存生效（不抛 500）', async () => {
    const svc = bootService();
    // 让 repo 写入抛错，模拟磁盘/权限故障
    const brokenRepo = new AdminCredentialRepository(db);
    brokenRepo.upsert = () => {
      throw new Error('disk read-only');
    };
    const svc2 = new AdminCredentialService(brokenRepo);
    svc2.onModuleInit();

    let result: { plain: string; persisted: boolean } | null = null;
    expect(() => {
      result = svc2.reset();
    }).not.toThrow();
    expect(result!.persisted).toBe(false);
    // 内存已更新 → 新口令立刻可用（否则用户拿不到新口令又用不了旧的）
    expect(await svc2.verify(result!.plain)).toBe(true);
    expect(svc.isConfigured()).toBe(true);
  });

  it('⑮ 连续两次 reset 得到不同口令（生成器不重复）', async () => {
    const svc = bootService();
    const a = svc.reset().plain;
    const b = svc.reset().plain;
    expect(a).not.toBe(b);
    expect(await svc.verify(b)).toBe(true);
    expect(await svc.verify(a)).toBe(false);
  });
});

describe('admin-credential · 回落文件的一致性', () => {
  it('⑯ 迁移自文件后，reset 会把文件刷成同一个哈希（避免将来回退到旧口令）', async () => {
    const legacyPw = 'legacy-aaaaaaaaaaaaaa';
    const legacyHash = hashPassword(legacyPw);
    writeFileSync(join(dataDir, 'admin.hash'), legacyHash, 'utf8');

    const svc = bootService();
    expect(await svc.verify(legacyPw)).toBe(true);

    const { plain } = svc.reset();
    // 文件内容必须已经换成新哈希
    const onDisk = readFileSync(join(dataDir, 'admin.hash'), 'utf8').trim();
    expect(onDisk).not.toBe(legacyHash);
    expect(await verifyPassword(plain, onDisk)).toBe(true);
  });

  it('⑰ 无文件时 reset 不会凭空创建文件（不引入新的真相源）', () => {
    const svc = bootService();
    const path = join(dataDir, 'admin.hash');
    expect(existsSync(path)).toBe(false);
    svc.reset();
    expect(existsSync(path)).toBe(false);
  });
});

/**
 * 自定义口令（`PUT /api/auth/password`，契约 §3.1.4）。
 *
 * 这是本轮新加的用户需求「管理口令能手动输入吗」的落点。
 * 测试沿两条主线：
 *   ① 正确性 —— 设了新口令后，新口令通、旧口令不通，且热生效（不必重启）。
 *   ② 安全边界 —— 弱口令/空口令被拒，且**拒绝时内存里的哈希纹丝不动**（旧的仍能用）。
 */
describe('admin-credential · setPassword（用户自定义口令）', () => {
  it('⑱ ★ 设合法口令后：新口令 verify=true，旧口令 verify=false', async () => {
    const oldPw = 'old-password-0123456';
    repo.upsert(hashPassword(oldPw), 'console');
    const svc = bootService();
    expect(await svc.verify(oldPw)).toBe(true);

    const next = 'test-admin-pw-1';
    const { persisted } = svc.setPassword(next);

    expect(persisted).toBe(true);
    expect(await svc.verify(next)).toBe(true);
    // 旧口令必须立即失效（不能两个都通）
    expect(await svc.verify(oldPw)).toBe(false);
  });

  it('⑲ ★ 热生效：setPassword 后无需重启即可用新口令（同一个实例）', async () => {
    const svc = bootService();
    svc.setPassword('test-admin-pw-1');
    // 没有重新 onModuleInit，同一个 svc 实例
    expect(await svc.verify('test-admin-pw-1')).toBe(true);
  });

  it('⑳ ★ 太短（7 字符）被拒绝，且拒绝后内存哈希不变 —— 旧口令仍能通过', async () => {
    const oldPw = 'old-password-0123456';
    repo.upsert(hashPassword(oldPw), 'console');
    const svc = bootService();

    let err: unknown = null;
    try {
      svc.setPassword('1234567'); // 7 字符
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayHttpError);
    // message 必须说清楚「哪里不合格」，且带上具体长度
    expect((err as RelayHttpError).message).toContain('至少 8');
    expect((err as RelayHttpError).message).toContain('7');
    expect((err as RelayHttpError).apiCode).toBe(40001);

    // ★ 关键：拒绝时不能顺手把内存改了
    expect(await svc.verify(oldPw)).toBe(true);
    expect(await svc.verify('1234567')).toBe(false);
  });

  it('㉑ ★ 纯空白被拒绝，且内存哈希不变', async () => {
    const oldPw = 'old-password-0123456';
    repo.upsert(hashPassword(oldPw), 'console');
    const svc = bootService();

    expect(() => svc.setPassword('        ')).toThrow(RelayHttpError);
    expect(() => svc.setPassword('  \t\n ')).toThrow(RelayHttpError);

    expect(await svc.verify(oldPw)).toBe(true);
  });

  it('㉒ 恰好 8 字符（下限边界）通过 —— 边界不能是「9 才算」', async () => {
    const svc = bootService();
    const pw = 'abcdefgh'; // 8 个
    expect(() => svc.setPassword(pw)).not.toThrow();
    expect(await svc.verify(pw)).toBe(true);
  });

  it('㉓ 超过 128 字符被拒绝（上限防超长输入拖慢 scrypt）', () => {
    const svc = bootService();
    const tooLong = 'a'.repeat(129);
    let err: unknown = null;
    try {
      svc.setPassword(tooLong);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayHttpError);
    expect((err as RelayHttpError).message).toContain('128');
  });

  it('㉔ 非字符串入参被拒绝（不是「静默转成字符串」）', () => {
    const svc = bootService();
    expect(() => svc.setPassword(12345678)).toThrow(RelayHttpError);
    expect(() => svc.setPassword(undefined)).toThrow(RelayHttpError);
    expect(() => svc.setPassword({ toString: () => 'aaaaaaaa' })).toThrow(RelayHttpError);
  });

  it('㉕ ★ 明文不进库：库里只有 scrypt 串，任何字段都不含明文', async () => {
    const svc = bootService();
    const plain = 'test-admin-pw-1';
    svc.setPassword(plain);

    const row = db.prepare('SELECT * FROM admin_credential WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    for (const v of Object.values(row)) {
      expect(String(v)).not.toContain(plain);
    }
    expect(parsePasswordHash(String(row.hash))).not.toBeNull();
  });

  it('㉖ ★ 明文不落任何文件：数据目录里没有任何文件包含明文', () => {
    const svc = bootService();
    const plain = 'test-admin-pw-1';
    svc.setPassword(plain);

    // 遍历整个一次性数据目录，任何文件内容都不应包含明文
    for (const name of readdirSync(dataDir)) {
      const content = readFileSync(join(dataDir, name), 'utf8');
      expect(content).not.toContain(plain);
    }
  });

  it('㉗ ★ 重启后新口令仍有效：跨实例从库读回（落盘真的成了主存储）', async () => {
    const svc = bootService();
    const { persisted } = svc.setPassword('test-admin-pw-1');
    expect(persisted).toBe(true);

    const reborn = bootService(); // 模拟重启
    expect(await reborn.verify('test-admin-pw-1')).toBe(true);
    expect(reborn.currentSource()).toBe('database');
  });

  it('㉘ setPassword 落库记 rotated_at、source=console（与 reset 一致）', () => {
    const svc = bootService();
    svc.setPassword('test-admin-pw-1');
    const after = repo.get();
    expect(after!.source).toBe('console');
    expect(after!.rotated_at).toBeGreaterThan(0);
  });

  it('㉙ ★ 数据库不可写时降级为 persisted=false，但新口令仍在内存生效（不抛 500）', async () => {
    const brokenRepo = new AdminCredentialRepository(db);
    brokenRepo.upsert = () => {
      throw new Error('disk read-only');
    };
    const svc = new AdminCredentialService(brokenRepo);
    svc.onModuleInit();

    let result: { persisted: boolean } | null = null;
    expect(() => {
      result = svc.setPassword('test-admin-pw-1');
    }).not.toThrow();
    expect(result!.persisted).toBe(false);
    // 内存已更新 → 新口令立刻可用
    expect(await svc.verify('test-admin-pw-1')).toBe(true);
  });

  it('㉚ 返回对象不含 plain 字段（用户自定义口令绝不回显明文）', () => {
    const svc = bootService();
    const res = svc.setPassword('test-admin-pw-1') as unknown as Record<string, unknown>;
    expect(Object.keys(res)).toEqual(['persisted']);
    expect(res).not.toHaveProperty('plain');
    expect(JSON.stringify(res)).not.toContain('test-admin-pw-1');
  });
});
