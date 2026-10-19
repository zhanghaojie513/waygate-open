/**
 * 管理口令的装载与轮换（api-contract §3.1）。
 *
 * ## 加载优先级
 *   1. 环境变量 `RELAY_ADMIN_PASSWORD_HASH`（运维**显式**写下的意图，最高）
 *   2. 数据库 `admin_credential` 表（控制台改密后落在这里）
 *   3. 数据目录下的 `admin.hash` 文件（**回落**，兼容旧部署）
 *   4. 都没有 → 首次启动：用 `RELAY_ADMIN_PASSWORD`（若给了，本机启动形态的默认口令）
 *      或随机 16 字符，**打印到 stdout 一次**，写入数据库
 *
 * ⚠️ 第 4 级才看 `RELAY_ADMIN_PASSWORD`（**明文**，与第 1 级的**哈希**不同）。
 *    它只是「首次启动的初始口令」，**不覆盖**已有的库/文件口令 ——
 *    否则用户改过密码后重启会被打回默认值。
 *
 * ### 为什么保留第 3 级「文件回落」
 * 从文件方案迁移过来时，用户手上有效的口令只存在于文件里。
 * 若直接跳到第 4 级，升级完就变成"口令被换了、而且新口令只出现在日志里"——
 * 等于把自己锁在门外。保留回落让**旧口令在迁移后继续可用**，
 * 直到用户主动改一次密（那时数据库有值，回落自然失效）。
 *
 * ## 热生效
 * 口令哈希放在成员变量 `storedHash` 里，`verify()` 每次读它，
 * 所以 `reset()` / `setPassword()` 改完内存**立即生效，无需重启**。
 *
 * ⚠️ 明文只在「首次生成」与「控制台重置」两条路径上**由服务端产出**
 *    （记入返回值 / stdout）；自定义口令那条路径的明文是**用户自己给的**，
 *    服务端只吃进不吐出（不回显）。无论哪条路径，明文**绝不落盘、绝不进日志**。
 *    本模块刻意不长期持有明文（不存成员变量），用完即弃。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../../store/db';
import { AdminCredentialRepository } from '../../store/repositories/admin-credential.repo';
import { validateAdminPassword } from './admin-password-policy';
import { generatePassword, hashPassword, parsePasswordHash, verifyPassword } from './password';

const HASH_FILE = 'admin.hash';

/** 口令来源，用于控制台展示与排障。 */
export type AdminCredentialSource = 'env' | 'database' | 'file' | 'generated' | 'tombstone';

/**
 * 本机启动形态的内置默认口令（CLI 在**回环绑定**时注入，见 bin/waygate-open.mjs）。
 *
 * 这是**公开值** —— 写在本文档、README 与启动输出里。它只用于「首次启动开箱可登录」，
 * 用户改密后即失效且永不回落。登录页允许显示它（不是泄露），因为不用的话用户得去
 * 终端里翻。
 */
export const BUILTIN_DEFAULT_PASSWORD = 'waygate';

export interface ResetResult {
  /** 新口令明文。**这是唯一一次能拿到它的机会**，调用方必须立即交给用户。 */
  plain: string;
  /** 落库是否成功。false 表示仅内存生效（数据库不可写），重启后会回到旧口令。 */
  persisted: boolean;
}

/**
 * 「由用户自定义口令」的结果（`PUT /api/auth/password`）。
 *
 * 与 `ResetResult` 的唯一区别：**不含 `plain`**。用户是自己输入的，
 * 他本来就知道明文；把它再回显一遍没有任何价值，却白白增加一条
 * 明文出现在响应体/前端 state/可能的日志里的通道。所以这里刻意不带。
 */
export interface SetResult {
  /** 落库是否成功。false 表示仅内存生效（数据库不可写），重启后会回到旧口令。 */
  persisted: boolean;
}

@Injectable()
export class AdminCredentialService implements OnModuleInit {
  private readonly logger = new Logger(AdminCredentialService.name);
  /** 存储串，形如 scrypt$N$r$p$salt$hash。热更新时被替换。 */
  private storedHash = '';
  /** 当前口令的来源。 */
  private source: AdminCredentialSource = 'tombstone';
  /** 本次启动是否新生成过口令（用于在日志里给出明确指引）。 */
  private generatedThisBoot = false;
  /**
   * [v1.6.27] 当前生效的口令**是否就是本机内置默认值 `waygate`**。
   *
   * 只有这一种情形允许登录页把它显示出来 —— 它是公开值，不是用户的秘密。
   *
   * ★ 判定方式改成「**自证**」而不是「记标记」：
   *   启动装载完哈希后，直接验一次 `waygate` 是否匹配。
   *   为什么不靠数据库里的 `source` 字段：`'generated'` 同时表示
   *   「内置默认值」与「随机生成的 16 位」，无法区分 —— 早先版本随机生成过口令的
   *   用户（例如升级前就装过）会被误判成「还在用默认值」，登录页就会显示一个
   *   根本不对的 `waygate`（实测踩过：用户照着输，报「管理口令不正确」）。
   *   自证式判断没有这个歧义：验得过就是、验不过就不是。
   *
   * 代价：每次启动多一次 scrypt（实测 ~67ms，可接受）。
   */
  private builtinDefaultInUse = false;

  constructor(private readonly repo: AdminCredentialRepository) {}

  onModuleInit(): void {
    this.storedHash = this.load();
    this.detectBuiltinDefault();
  }

  /**
   * 校验当前生效的哈希是否就是内置默认口令（同步版，启动期用一次）。
   *
   * 与 `verify()` 的区别：这里用 `scryptSync`，因为 `onModuleInit` 是同步签名；
   * 只跑一次、~67ms，不值得为它把整个启动链改成异步。
   */
  private detectBuiltinDefault(): void {
    if (!this.storedHash) {
      this.builtinDefaultInUse = false;
      return;
    }
    try {
      const parsed = parsePasswordHash(this.storedHash);
      if (!parsed) {
        this.builtinDefaultInUse = false;
        return;
      }
      const derived = scryptSync(BUILTIN_DEFAULT_PASSWORD, parsed.salt, parsed.hash.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: 128 * parsed.N * parsed.r * 2,
      });
      this.builtinDefaultInUse =
        derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
    } catch {
      /* 哈希损坏等：按「不是默认值」处理 —— 宁可不显示，也不显示错的。 */
      this.builtinDefaultInUse = false;
    }
  }

  private hashPath(): string {
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    return join(dir, HASH_FILE);
  }

  private load(): string {
    // ① 环境变量
    const fromEnv = (process.env.RELAY_ADMIN_PASSWORD_HASH ?? '').trim();
    if (fromEnv) {
      if (!parsePasswordHash(fromEnv)) {
        // 配置错了要吵，但要吵得能修：告诉它期望格式。不静默回落——
        // 静默回落会让管理员以为"我设的口令生效了"，实际用的是自动生成的
        this.logger.error(
          'RELAY_ADMIN_PASSWORD_HASH 格式非法（期望 scrypt$N$r$p$<salt_b64>$<hash_b64>）。' +
            '本次启动不接受任何登录，请修正后重启。',
        );
        this.source = 'tombstone';
        return '';
      }
      this.logger.log('管理口令来自环境变量 RELAY_ADMIN_PASSWORD_HASH。');
      this.source = 'env';
      return fromEnv;
    }

    // ② 数据库
    const row = this.repo.get();
    if (row) {
      if (parsePasswordHash(row.hash)) {
        this.logger.log(
          `管理口令来自数据库（来源 ${row.source}，更新于 ${new Date(row.updated_at).toISOString()}）。`,
        );
        this.source = 'database';
        return row.hash;
      }
      // 库里存了坏值：不能静默忽略（否则用户以为口令还在），退回文件并大声报错
      this.logger.error(
        'admin_credential 表里的哈希格式非法，已忽略并回落到文件/重新生成。' +
          '请通过控制台重置管理口令。',
      );
    }

    // ③ 文件回落（从旧版本迁移过来时，口令只存在于文件里）
    const path = this.hashPath();
    if (existsSync(path)) {
      const stored = readFileSync(path, 'utf8').trim();
      if (parsePasswordHash(stored)) {
        this.logger.log(
          `管理口令来自文件 ${path}。首次通过控制台改密后，将改为存入数据库并优先读库。`,
        );
        this.source = 'file';
        // ★ 顺手把文件里的口令**迁进数据库**，这样每日备份就能覆盖到它，
        //   同时下一级回落不再需要。迁移失败不影响本次启动。
        try {
          this.repo.upsert(stored, 'generated');
          this.logger.log('已把文件中的口令哈希迁移进数据库（后续以数据库为准）。');
        } catch (err) {
          this.logger.warn(`迁移口令到数据库失败（不影响本次启动）：${(err as Error).message}`);
        }
        return stored;
      }
      this.logger.error(
        `${path} 内容非法，已忽略。请删除该文件后重启以重新生成口令，或改用 RELAY_ADMIN_PASSWORD_HASH。`,
      );
      this.source = 'tombstone';
      return '';
    }

    // ④ 首次启动：生成随机口令（或采用显式给的初始口令，见 bootstrap）
    return this.bootstrap();
  }

  /**
   * 首次启动时的初始口令。
   *
   * ## 两条来源
   *   · `RELAY_ADMIN_PASSWORD`（**明文**，仅本机启动形态用）—— 取它当初始口令。
   *     存在的理由：「本地启动、开箱可用」不该卡在"去日志里复制那串随机字符"这一步。
   *     由 CLI 在**回环绑定**时默认注入一个已知口令（见 bin/waygate-open.mjs），
   *     用户第一次就能直接登进去。**对外监听时绝不注入**（CLI 侧负责）。
   *   · 否则生成随机 16 字符 —— 服务器 / 生产形态的缺省，行为与原来一致。
   *
   * ## 为什么只在「首次启动」生效
   * 本方法只从 `load()` 的第 ④ 级走到 —— 即**环境变量哈希 / 数据库 / 文件都没有**时。
   * 所以用户一旦在控制台改过口令（已落库），重启**不会**被这个默认值打回去。
   * 这条很重要：否则"我改了密码、重启后又变回默认的"就是一起安全事故。
   */
  private bootstrap(): string {
    const preset = (process.env.RELAY_ADMIN_PASSWORD ?? '').trim();
    const plain = preset || generatePassword(16);
    const stored = hashPassword(plain);
    const persisted = this.persist(stored, 'generated');
    this.generatedThisBoot = true;
    this.source = 'generated';
    /* builtinDefaultInUse 不在这里设 —— 由 onModuleInit 的 detectBuiltinDefault()
       统一按「哈希能否被 waygate 验证通过」自证，避免来源标记的歧义。 */

    // ★ 只在这里出现一次，且走 stdout 而非 logger（logger 可能被重定向到文件）
    process.stdout.write(
      [
        '',
        '════════════════════════════════════════════════════════════════',
        preset
          ? '  Waygate · 首次启动，使用内置默认口令'
          : '  Waygate · 首次启动，已生成管理口令（此口令只显示这一次）',
        '',
        `      口令：${plain}`,
        '',
        persisted
          ? '  已把哈希写入数据库 admin_credential 表，明文未落盘。'
          : '  ⚠️ 数据库不可写，口令仅本次运行有效，重启会重新生成。',
        preset
          ? '  ⚠️ 默认口令人人可知 —— 建议进控制台「设置 → 管理口令」改掉它。'
          : '  请立即复制保存。忘记口令时：进入控制台「设置 → 管理口令」重置。',
        '  生产环境建议改用环境变量 RELAY_ADMIN_PASSWORD_HASH（存哈希，不存明文）。',
        '════════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
    return stored;
  }

  /**
   * 重置管理口令：生成新的随机口令，写库并**立即热生效**。
   *
   * 返回值里的明文是唯一一次机会 —— 调用方必须直接交给用户，
   * 不得写入日志、不得长期保存。
   *
   * 落库失败**不抛错**（降级为 `persisted:false`）：内存已能生效，
   * 不该因为磁盘问题让整个重置请求失败 —— 否则用户拿不到新口令，
   * 却又已经用不了旧口令（内存没改，其实旧口令仍旧有效，见下方注释）。
   */
  reset(): ResetResult {
    const plain = generatePassword(16);
    const stored = hashPassword(plain);
    const persisted = this.applyNewHash(stored, 'console');

    this.logger.log(
      `管理口令已重置（来源 console）${persisted ? '，已写入数据库并立即生效' : '，仅内存生效（数据库不可写，重启后回到上一个口令）'}`,
    );
    return { plain, persisted };
  }

  /**
   * **用户自定义**管理口令（`PUT /api/auth/password`，契约 §3.1.4）。
   *
   * 与 `reset()` 共用同一段「落库 + 热更新内存」逻辑（`applyNewHash`），
   * 区别只在口令从哪来：这里来自用户输入，故**不生成、也不回显**。
   * 校验（长度 / 纯空白 / 非字符串）下沉到 `admin-password-policy.ts`。
   *
   * 明文只在**本方法栈内**存在：走 `hashPassword` 一次即弃，**绝不落盘、绝不进日志**。
   * 改密**不影响当前会话**（会话是 `HMAC(secret)` 的自包含 cookie，与口令哈希无关）。
   *
   * @param raw 用户输入的明文口令。
   */
  setPassword(raw: unknown): SetResult {
    // 通过校验后拿到的是**原串**（不 trim），交给 hashPassword 落 scrypt。
    const password = validateAdminPassword(raw);

    const stored = hashPassword(password);
    const persisted = this.applyNewHash(stored, 'console');

    // 日志只记「发生了什么」，绝不记口令本身（哪怕是长度也不必要地泄露信息面）
    this.logger.log(
      `管理口令已由用户在控制台更新（来源 console）${persisted ? '，已写入数据库并立即生效' : '，仅内存生效（数据库不可写，重启后回到上一个口令）'}`,
    );
    return { persisted };
  }

  /**
   * 落库 + **无条件**热更新内存（`reset()` 与 `setPassword()` 共用）。
   *
   * ★ 先落盘再改内存，且内存更新**无条件执行**：
   *   这样「新口令立刻可用」这件事始终成立；若落库失败，
   *   通过返回值 `persisted:false` 与上层日志告知「重启会回到上一个口令」。
   *   两处调用方若各自复制这段逻辑，很容易在某一处漂移（比如忘了更新内存、
   *   或把顺序反过来），故抽成一个方法 —— 语义只有一个。
   */
  private applyNewHash(stored: string, source: 'generated' | 'console'): boolean {
    const persisted = this.persist(stored, source, Date.now());
    this.storedHash = stored;
    this.source = 'database';
    /* [v1.6.27] 改密后重新自证：万一用户「改」成的就是 waygate，那它仍是默认值。 */
    this.detectBuiltinDefault();
    return persisted;
  }

  /**
   * 把哈希写进数据库（主存储），并**同步刷新回落文件**（若有）。
   *
   * 为什么同步刷新文件而不是删掉它：
   *   留着一个**内容过时**的 admin.hash 是个隐患 —— 万一将来数据库被清空
   *   或换机时只拷了文件，会静默回退到**旧口令**，那种故障极难排查。
   *   所以两处要么都没有、要么内容一致：这里顺手把文件刷成同一个哈希。
   *   文件写不了不算失败（它只是兜底手段，数据库才是主存储）。
   */
  private persist(
    stored: string,
    source: 'generated' | 'console',
    rotatedAt?: number,
  ): boolean {
    let ok = true;
    try {
      this.repo.upsert(stored, source, rotatedAt);
    } catch (err) {
      this.logger.warn(`写入 admin_credential 表失败：${(err as Error).message}`);
      ok = false;
    }
    try {
      const path = this.hashPath();
      if (existsSync(path)) {
        writeFileSync(path, stored, { mode: 0o600 });
        chmodSync(path, 0o600); // writeFileSync 的 mode 受 umask 影响，再显式压一次
      }
    } catch (err) {
      this.logger.warn(`刷新回落文件失败（不影响主流程）：${(err as Error).message}`);
    }
    return ok;
  }

  /** 是否已具备可用的口令。false 时登录端点应直接 500 并说明如何修复。 */
  isConfigured(): boolean {
    return this.storedHash.length > 0;
  }

  /** 当前口令来源（控制台展示用）。绝不包含任何哈希或明文片段。 */
  currentSource(): AdminCredentialSource {
    return this.source;
  }

  /** 校验口令。未配置口令时恒 false（不是恒 true）。 */
  async verify(plain: string): Promise<boolean> {
    if (!this.storedHash) return false;
    return verifyPassword(plain, this.storedHash);
  }

  /** 本次启动是否新生成过口令（冒烟/自检用）。 */
  wasGeneratedThisBoot(): boolean {
    return this.generatedThisBoot;
  }

  /**
   * [v1.6.25] 登录页用：当前生效的口令是不是**本机内置默认值**。
   *
   * true 时调用方可把 `BUILTIN_DEFAULT_PASSWORD` 显示在输入框里 —— 那是公开值。
   * 任何其它情形（改过密 / env hash / 自定口令 / 随机生成）恒 false。
   *
   * ⚠️ 用户一改密就必须立刻变 false：`setPassword` / `reset` 里会清掉标记，
   *    否则控制台会在用户已经换过口令后还把 `waygate` 摆在输入框里（误导且危险）。
   */
  isBuiltinDefaultInUse(): boolean {
    return this.builtinDefaultInUse;
  }

  /** 仅供测试：直接注入一个存储串，跳过正常的加载路径。 */
  setHashForTest(stored: string): void {
    this.storedHash = stored;
  }
}
