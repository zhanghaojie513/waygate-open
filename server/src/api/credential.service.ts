/**
 * 上游凭证（ck_…）的运行时更新服务。
 *
 * ## 为什么需要单独一个服务，而不并进 settings
 *
 * 契约里 `credential.source` 是 **`readonly: true`** —— 它只展示掩码
 * （`ck_x••••3f7a`），从不接受写入。这是有意的安全边界：上游凭证是
 * **出站凭证**，能读回它等于能把服务端凭证偷走。因此：
 *
 *   - 不复用 `PUT /api/settings`（那会迫使我们把只读项变成可写）
 *   - 单独开 `PUT /api/settings/credential`，语义是"**只写**"
 *   - 任何响应与日志都只出现掩码形态
 *
 * ## 为什么写「数据目录」，而不是写 `.env`
 *
 * 最初的设计是逐行重写 `<cwd>/.env`。**部署到服务器时实测发现这条路走不通**：
 * systemd 单元里有 `ProtectSystem=strict`，配合 `ReadWritePaths=/var/lib/relay
 * /var/log/relay`，整个文件系统对进程是只读的 —— 只有那两个目录例外。
 * 用 `systemd-run` 复现同样的沙箱约束后探针输出：
 *
 *     PROBE_RESULT: WRITE DENIED        ← touch /opt/relay/server/.env 失败
 *     CONTROL var-lib-relay: WRITE OK   ← touch /var/lib/relay/... 成功
 *
 * 也就是说，如果继续写 `.env`，线上每一次"更换凭证"都会 `persisted=false`：
 * 内存生效、重启即丢。这正是本服务引入 `persisted` 字段想要暴露的问题，
 * 但把"永远暴露一个坏掉的功能"当成交付显然不可接受。
 *
 * 因此落盘位置改为数据目录（`RELAY_DATA_DIR`，部署时即 `/var/lib/relay`）下的
 * `upstream.key`。选它的理由：
 *
 *   1. 该目录已被 systemd 显式授予写权限（`ReadWritePaths`），无需放宽沙箱；
 *   2. 它本来就是本项目的"运行期状态"落脚点 —— `settings.json`、
 *      `relay.secret`、`relay.db` 都在这儿，凭证与它们同类；
 *   3. 权限可以给到 600，和 `relay.secret` 一致，不会比原来更松。
 *
 * `.env` 仍然**可读**（systemd 的 `EnvironmentFile` 会把它注入进程环境），
 * 因此部署时预置凭证的老办法照常可用，只是它不再被**写**。
 * 加载优先级见 `RelayConfigService.loadUpstreamKey()`：
 * **`RELAY_UPSTREAM_KEY` 环境变量（含 `.env` 注入）→ `<数据目录>/upstream.key`**。
 *
 * ## 为什么不需要重启进程
 *
 * `RelayConfigService.upstreamKey` 是 getter，所有消费点都按需读取
 * （proxy / models / catalog 均是 `this.config.upstreamKey`），
 * 因此写入后立即对后续请求生效。这比"提示用户去重启"体验好得多，
 * 也避免了重启期间服务不可用。
 *
 * ## 写入策略与原子性
 *
 * `upstream.key` 是单值文件（内容只有那一行凭证），不存在"误改其它变量"的
 * 风险面 —— 这也是相对写 `.env` 的一个额外好处。写入仍是**原子**的：
 * 先写 `${path}.tmp-${pid}` 再 `rename`，避免写入中途进程被杀留下半截文件。
 */

import { Injectable, Logger } from '@nestjs/common';
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RelayHttpError, ApiCode } from '../common/errors';
import { RelayConfigService } from '../config/config.service';
import { CREDENTIAL_FILE } from '../config/settings.defaults';

/**
 * 上游自签发密钥的形状。
 *
 * ## 为什么这条规则现在这么宽
 *
 * 最初的规则是 `/^ck_[A-Za-z0-9_-]{16,}$/` —— 那是我**在没有任何真实样本时
 * 照着 API 文档的占位写法反推的**。真实密钥形如
 * `ck_<16位>.<40位>`，中间那个 **`.`** 不在原先的字符集里，
 * 于是真钥匙被自己的前端拦在门外（实测报错：格式看起来不对）。
 *
 * 教训：**凭证格式由上游决定，不该由本服务猜测**。本地的正则只做一件事 ——
 * 挡住明显的手滑（空值、粘贴进换行/空格、只剩半截），
 * 真正的有效性判断交给上游：
 *   - 填错了 → `/v1` 转发时上游返回 401/403 → 本服务回
 *     `502 upstream_credential_invalid`（这条路径早就有了）
 *
 * 于是规则放宽为：`ck_` 开头 + 至少 16 个**可打印 ASCII 且非空白**字符。
 * 用 `[\x21-\x7e]` 而非 `.` 是刻意的：`.` 会匹配换行以外的任意字符，
 * 且不拒绝空白以外的控制字符；显式范围能同时挡住
 * 空格、Tab、换行、以及 `\x00-\x1f` 这些粘贴时最爱混进来的东西。
 *
 * ## 与前端的关系
 *
 * 前端 `web/src/components/settings/CredentialModal.tsx` 里有一份**同源**正则。
 * 改这里必须同步改那里，且两边的测试都要覆盖真实 key 的形态
 * （含 `.`）。历史教训：两份规则不一致时，用户会在界面上被拦下、
 * 而服务端其实能接受 —— 体验最差的一种失败方式。
 */
export const UPSTREAM_KEY_PATTERN = /^ck_[\x21-\x7e]{16,}$/;

/** 凭证格式的**人类可读**描述（错误提示与前端提示共用，避免两处措辞漂移）。 */
export const UPSTREAM_KEY_HINT =
  '应以 ck_ 开头，后接至少 16 位可见字符（不能含空格或换行）';

/** 落盘文件名（从 config 复用，这里再导出一次方便测试与文档引用）。 */
export { CREDENTIAL_FILE };

export interface CredentialUpdateResult {
  /** 掩码后的凭证（ck_x••••3f7a），供前端展示。 */
  source: string;
  /** 是否已配置。 */
  configured: boolean;
  /** 是否写入了磁盘。false 表示只更新了内存（如数据目录不可写的开发环境）。 */
  persisted: boolean;
  /** 落盘路径，便于排查（不含任何敏感内容）。 */
  path: string;
}

@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  /**
   * 凭证文件的绝对路径。默认取 `<RELAY_DATA_DIR>/upstream.key`。
   *
   * 允许覆盖**仅为可测性**：`process.chdir()` 在 vitest 的 worker 池里不可用
   * （会抛 `not supported in workers`），若路径写死就只能在真实数据目录上跑测试。
   * 做成可覆盖字段后，测试指向临时目录，生产行为一字不变。
   */
  private credentialFilePath = join(defaultDataDir(), CREDENTIAL_FILE);

  constructor(private readonly config: RelayConfigService) {}

  /** 仅供测试覆盖落盘位置。 */
  setCredentialFileForTest(path: string): void {
    this.credentialFilePath = path;
  }

  /** 当前凭证状态（只回掩码，绝不回明文）。 */
  status(): { source: string; configured: boolean; path: string } {
    return {
      source: this.config.maskedUpstreamKey(),
      configured: this.config.upstreamConfigured(),
      path: this.credentialFilePath,
    };
  }

  /**
   * 更新上游凭证。
   *
   * @param raw 用户提交的 `ck_…` 明文。仅在本方法栈内存在，不落任何日志。
   */
  update(raw: unknown): CredentialUpdateResult {
    if (typeof raw !== 'string') {
      throw this.bad('上游访问密钥必须是字符串');
    }
    const key = raw.trim();
    if (!key) {
      throw this.bad('上游访问密钥不能为空');
    }
    if (!UPSTREAM_KEY_PATTERN.test(key)) {
      // 不回显用户输入的任何部分：避免把"接近正确的密钥"写进日志/响应
      throw this.bad(`上游访问密钥格式不正确：${UPSTREAM_KEY_HINT}`);
    }

    // 先落盘再改内存：若落盘失败则内存不变，服务行为与磁盘保持一致。
    // 反过来做的话，会出现"内存已生效但重启后丢失"的静默不一致。
    const persisted = this.writeCredential(key);
    this.config.setUpstreamKey(key);

    this.logger.log(
      `上游访问密钥已更新：${this.config.maskedUpstreamKey()}（${persisted ? `已写入 ${this.credentialFilePath}` : '仅内存，数据目录不可写'}）`,
    );

    return {
      source: this.config.maskedUpstreamKey(),
      configured: true,
      persisted,
      path: this.credentialFilePath,
    };
  }

  private bad(message: string): RelayHttpError {
    return new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message,
    });
  }

  /**
   * 把凭证原子写入 `<数据目录>/upstream.key`。
   *
   * 返回 false 表示目录不可写（如开发环境没有该目录且无法创建），此时只改内存。
   */
  private writeCredential(value: string): boolean {
    const path = this.credentialFilePath;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      this.logger.warn(
        `无法创建数据目录 ${dirname(path)}：${(err as Error).message}。上游访问密钥只更新到内存，进程重启后会丢失`,
      );
      return false;
    }

    // 原子写：临时文件 + rename，防止半截文件被当成有效凭证读走
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, `${value}\n`, null, 'utf8');
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 清理失败不影响主流程 */
      }
      // 这里**不抛错**：内存已经能生效，把落盘失败降级成 warned 的
      // `persisted:false` 交给前端提示，比让整个请求 500 更合理。
      this.logger.warn(
        `写入 ${path} 失败：${(err as Error).message}。上游访问密钥只更新到内存，进程重启后会丢失`,
      );
      return false;
    }
    return true;
  }
}

/** `<RELAY_DATA_DIR>` 或 `<cwd>/data` —— 与 store/db.ts 的 resolveDataDir 同规则。 */
function defaultDataDir(): string {
  const configured = (process.env.RELAY_DATA_DIR ?? '').trim();
  return configured || join(process.cwd(), 'data');
}
