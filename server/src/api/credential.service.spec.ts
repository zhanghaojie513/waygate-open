/**
 * `CredentialService` 单测。
 *
 * 重点覆盖五类**容易悄悄坏掉**的行为，而不是复述实现：
 *   ① 格式校验（含"看起来对但不对"的边界）
 *   ② 凭证落盘到数据目录，且**跨进程重启存活**（这是线上真出过问题的点）
 *   ③ 原子写不残留临时文件
 *   ④ 落盘失败时降级为 persisted=false，但内存仍生效且**不抛 500**
 *   ⑤ 任何响应/日志路径都不回明文，只回掩码
 *
 * 所有用例都在临时目录里作业，靠 `setCredentialFileForTest()` 把落盘路径指过去。
 * 不用 `process.chdir()` —— 它在 vitest 的 worker 池里会抛
 * `not supported in workers`（这也是把路径做成可覆盖字段的原因）。
 *
 * ## 一段值得记住的历史
 *
 * 最初的实现是把凭证**逐行重写进 `<cwd>/.env`**。在开发机上 12 个用例全绿，
 * 部署到服务器后才发现那条路根本走不通：systemd 单元的 `ProtectSystem=strict`
 * 让整个文件系统对进程只读，只有 `ReadWritePaths` 里的 `/var/lib/relay`
 * 和 `/var/log/relay` 例外 —— `.env` 不在其中。实测探针：
 *
 *     PROBE_RESULT: WRITE DENIED        ← touch /opt/relay/server/.env
 *     CONTROL var-lib-relay: WRITE OK
 *
 * 也就是说：单测全绿，线上功能却是坏的（每次写都 persisted=false，重启即丢）。
 * 教训是**"能不能写"必须按运行期的沙箱约束验证，不能只看 `ls -l` 的权限位**。
 * 现在的实现改为写数据目录，并且补了 ⑫ 这个"跨重启存活"用例把它钉住。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialService, CREDENTIAL_FILE } from './credential.service';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError } from '../common/errors';

const VALID_KEY = 'ck_abcdefghijklmnopqrstuvwx';
const OTHER_KEY = 'ck_ZZZZzzzz9999________YYYY';

let workDir: string;
let dataDir: string;
let keyFile: string;
let config: RelayConfigService;
let service: CredentialService;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'relay-credential-'));
  dataDir = join(workDir, 'data');
  keyFile = join(dataDir, CREDENTIAL_FILE);
  process.env.RELAY_DATA_DIR = dataDir;
  process.env.RELAY_SECRET = 'test-secret';
  delete process.env.RELAY_UPSTREAM_KEY;
  config = new RelayConfigService();
  service = new CredentialService(config);
  service.setCredentialFileForTest(keyFile);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.RELAY_DATA_DIR;
  delete process.env.RELAY_SECRET;
  delete process.env.RELAY_UPSTREAM_KEY;
});

describe('CredentialService · 格式校验', () => {
  it('① 非字符串 / 空串 一律 400 且 apiCode=40001', () => {
    for (const bad of [undefined, null, 42, {}, [], '', '   ']) {
      try {
        service.update(bad as unknown);
        throw new Error(`应当拒绝：${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(RelayHttpError);
        expect((err as RelayHttpError).httpStatus).toBe(400);
        expect((err as RelayHttpError).apiCode).toBe(40001);
      }
    }
  });

  it('② 空值 / 前缀不对 / 后缀过短 / 含空白 都拒绝', () => {
    const bad = [
      'sk-waygate-abcdefghijklmnop', // 前缀不对（这是本产品的客户端密钥前缀）
      'ck_short',                    // 后缀不足 16 位
      'ck_' + 'a'.repeat(15),        // 刚好差一位
      'ck_abc defghijklmnopqrst',    // 含空格
      'ck_abc\tdefghijklmnopqrst',   // 含 Tab
      'ck_abcdefghijklmnop\rqrst',   // 含回车 —— 防 CRLF 头注入
      'ck_abcdefghijklmnop\nqrst',   // 含换行
    ];
    for (const key of bad) {
      expect(() => service.update(key)).toThrow(RelayHttpError);
    }
  });

  /**
   * ★ 回归：真实密钥形如 `ck_<16位>.<40位>`，中间有一个**点号**。
   *
   * 最初的规则是 `/^ck_[A-Za-z0-9_-]{16,}$/` —— 我在没有真实样本时
   * 照文档占位符反推的，字符集里**没有 `.`**，于是真钥匙被自己的前端
   * 拦在门外，用户看到"格式看起来不对"。
   *
   * 这条用例是那个 bug 的守门人：**只要有人再把字符集收窄，它就会红。**
   * 密钥值本身是从用户真实 key 复制的形态（非真实凭证本身）。
   */
  it('②b ★ 接受真实形态：含点号、含 + / = 等可见符号（回归守卫）', () => {
    const realistic = [
      'ck_g03prg6t8hkw.kMrC7p8Nev1TO1ECe7d9Hh32XQTa271uKCsTdtkaiAg', // 真实形态：ck_ + 段.段
      'ck_abcdefghijklmnop.qrstuvwxyz0123456789',
      'ck_abcdefghijklmnop+slash/equals=',
      'ck_abcdefghijklmnop~!@#$%^&*()',
      'ck_' + 'a'.repeat(16),        // 边界：恰好 16 位
    ];
    for (const key of realistic) {
      expect(() => service.update(key)).not.toThrow();
    }
  });

  it('③ 合法形状（含 - 和 _）通过，且允许两端空白', () => {
    const res = service.update(`  ${VALID_KEY}  `);
    expect(res.configured).toBe(true);
    expect(res.source).toBe('ck_a••••uvwx');
  });

  it('④ 错误信息里不回显用户输入的任何片段', () => {
    const nearMiss = 'ck_thislooksvalidbutistoolonggibberish1234567890';
    try {
      // 用**含换行**构造非法输入（`!` 之类可见符号现在是合法的，
      // 不能再当"非法字符"用 —— 这本身就是本次放宽规则后的注意点）
      service.update(`${nearMiss}\n`);
      throw new Error('应当拒绝');
    } catch (err) {
      const msg = (err as RelayHttpError).message;
      expect(msg).not.toContain('thislooksvalid');
      expect(msg).not.toContain('1234567890');
    }
  });

  it('④b 非法输入被拒时，既不落盘也不改内存', () => {
    service.update(VALID_KEY);
    const before = readFileSync(keyFile, 'utf8');

    expect(() => service.update('nope')).toThrow(RelayHttpError);

    expect(config.upstreamKey).toBe(VALID_KEY);
    expect(readFileSync(keyFile, 'utf8')).toBe(before);
  });
});

describe('CredentialService · 落盘到数据目录', () => {
  it('⑤ 目录不存在时自动创建，并写入凭证文件', () => {
    expect(existsSync(keyFile)).toBe(false);
    const res = service.update(VALID_KEY);
    expect(res.persisted).toBe(true);
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(VALID_KEY);
    // 路径以凭证文件名结尾，且不含任何敏感内容
    expect(res.path.endsWith(CREDENTIAL_FILE)).toBe(true);
  });

  it('⑥ 落盘文件在 POSIX 系统上对属主之外不可读写', () => {
    service.update(VALID_KEY);
    // 这个断言只在 POSIX 上有意义：Windows（含 Git-Bash 下的 Node）不实现
    // POSIX 权限位，`openSync(..., 0o600)` 会被忽略，statSync 出来的 mode
    // 是宿主 ACL 的映射，断言它会变成"测试在 Windows 上必红、在 Linux 上
    // 才有信息量"的假信号。真正要守的是：**凭证文件不能对其他用户开放**。
    if (process.platform === 'win32') {
      expect(statSync(keyFile).isFile()).toBe(true);
      return;
    }
    expect(statSync(keyFile).mode & 0o077).toBe(0);
  });

  it('⑦ 覆盖写入只有一行，反复写入不累积', () => {
    service.update(VALID_KEY);
    service.update(OTHER_KEY);
    service.update(VALID_KEY);

    const lines = readFileSync(keyFile, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines).toEqual([VALID_KEY]);
  });

  it('⑧ 写入完成后不残留 .tmp-* 临时文件', () => {
    service.update(VALID_KEY);
    const leftovers = readdirSync(dataDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('⑨ 目录不可创建时降级为 persisted=false（而不是抛 500）', () => {
    // 把落盘路径指到一个"父级是文件"的位置，mkdirSync 必然失败
    const blocker = join(workDir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    service.setCredentialFileForTest(join(blocker, 'nested', CREDENTIAL_FILE));

    const res = service.update(VALID_KEY);
    expect(res.persisted).toBe(false);
    // 关键：内存照旧生效，功能不至于因为磁盘问题而完全不可用
    expect(config.upstreamKey).toBe(VALID_KEY);
  });
});

describe('CredentialService · 内存与磁盘的一致性', () => {
  it('⑩ 写入后 config.upstreamKey 立即返回新值（热更新）', () => {
    expect(config.upstreamKey).toBe('');
    service.update(VALID_KEY);
    expect(config.upstreamKey).toBe(VALID_KEY);
    expect(config.upstreamConfigured()).toBe(true);
  });

  it('★ ⑫ 跨进程重启存活：新实例能从数据目录读回凭证', () => {
    service.update(VALID_KEY);

    // 模拟进程重启：全新的 RelayConfigService，环境变量里仍然没有凭证
    const rebooted = new RelayConfigService();
    expect(rebooted.upstreamKey).toBe(VALID_KEY);
    expect(rebooted.maskedUpstreamKey()).toBe('ck_a••••uvwx');
  });

  it('⑬ 环境变量优先于数据目录中的旧值（运维显式覆盖）', () => {
    service.update(VALID_KEY);

    process.env.RELAY_UPSTREAM_KEY = OTHER_KEY;
    const fresh = new RelayConfigService();
    expect(fresh.upstreamKey).toBe(OTHER_KEY);
  });

  it('⑭ 数据目录里的凭证文件损坏/为空时降级为空串，不抛错', () => {
    service.update(VALID_KEY);
    writeFileSync(keyFile, '   \n', 'utf8');

    const fresh = new RelayConfigService();
    expect(fresh.upstreamKey).toBe('');
    expect(fresh.upstreamConfigured()).toBe(false);
  });
});

describe('CredentialService · status()', () => {
  it('⑪ 只回掩码，任何情况下都不回明文', () => {
    service.update(VALID_KEY);

    const st = service.status();
    expect(st.source).toBe('ck_a••••uvwx');
    expect(st.configured).toBe(true);
    expect(JSON.stringify(st)).not.toContain(VALID_KEY);

    // 未配置时给人类可读的占位，而不是空串。
    // 必须换一个空的数据目录，否则会读到本用例前面刚写下的凭证文件。
    const emptyDir = mkdtempSync(join(tmpdir(), 'relay-credential-empty-'));
    try {
      process.env.RELAY_DATA_DIR = emptyDir;
      const fresh = new CredentialService(new RelayConfigService());
      expect(fresh.status().source).toBe('未配置');
      expect(fresh.status().configured).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      process.env.RELAY_DATA_DIR = dataDir;
    }
  });
});
