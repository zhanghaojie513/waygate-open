import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Logger } from '@nestjs/common';
import { __setScryptParamsForTests, hashPassword, verifyPassword } from './password';

const SECRET = 'test-secret-for-api-spec';

/**
 * ★ 测试用**低成本** scrypt（N=16）—— 与 auth.spec.ts 同因同解。
 *
 * 本组用 `hashPassword` 种口令、`verifyPassword` 验密；生产档（N=16384）下每次可达
 * 1–3s，机器繁忙时逼近 vitest 默认 **5s 单测超时**（同一份代码忙时红、闲时绿）。
 * 降到 N=16 后全部毫秒级，与负载无关。生产默认档不受影响（verify 从存储串自身读参数）。
 */
beforeAll(() => __setScryptParamsForTests({ N: 16, r: 8, p: 1 }));
afterAll(() => __setScryptParamsForTests(null));

describe('登录审计日志', () => {
  /** 造一个真实的 AuthController，并拦截 Logger 输出。 */
  async function makeController(password: string, opts: { ua?: string } = {}) {
    const { AuthController } = await import('./auth.controller');
    const { Logger } = await import('@nestjs/common');
    type AdminCredentialService = import('./admin-credential.service').AdminCredentialService;

    const stored = hashPassword(password);
    // 用一个最小替身：只实现控制器实际用到的 isConfigured/verify
    const admin = {
      isConfigured: () => true,
      verify: (plain: string) => verifyPassword(plain, stored),
    } as unknown as AdminCredentialService;
    const config = { secret: SECRET } as never;

    const ctrl = new AuthController(config, admin);

    const lines: Array<{ level: string; msg: string }> = [];
    const capture = (level: string) => (msg: unknown) => {
      lines.push({ level, msg: String(msg) });
    };
    Logger.overrideLogger({
      log: capture('log'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
      verbose: capture('verbose'),
    });

    const req = {
      method: 'POST',
      ip: '127.0.0.1',
      headers: {
        origin: 'https://relay.example:8443',
        host: 'relay.example:8443',
        'user-agent': opts.ua ?? 'vitest-agent/1.0',
        // 模拟经 Nginx 反代：对端是回环，真实客户端 IP 由 Nginx 写进 XFF
        'x-forwarded-for': '203.0.113.9',
      },
    } as never;
    const reply = { header: () => undefined } as never;

    return { ctrl, req, reply, lines, restore: () => Logger.overrideLogger(false as never) };
  }

  // ★ 防御：这些用例靠**全局** Logger.overrideLogger 拦截输出。若某用例被超时/异常中断，
  //   其 finally 可能来不及复位，残留的捕获会被**后续用例**认领 —— 一次失败会级联成多条
  //   （实测：㉓ 超时后 ㉔/㉙ 跟着红）。这里在**每个用例之后**兜底复位，使级联不可能发生。
  afterEach(() => {
    Logger.overrideLogger(false as never);
  });

  it('㉓ 登录失败写 warn 日志，含 IP 与 UA，且**不含口令明文**', async () => {
    const secretPw = 'topsecret-should-never-appear';
    const { ctrl, req, reply, lines, restore } = await makeController('correct-password');
    try {
      await expect(
        ctrl.login(req, reply, { password: secretPw }),
      ).rejects.toThrow(/管理口令不正确/);

      const warn = lines.filter((l) => l.level === 'warn');
      expect(warn.length).toBeGreaterThan(0);
      const joined = warn.map((l) => l.msg).join('\n');
      expect(joined).toContain('203.0.113.9');
      expect(joined).toContain('vitest-agent/1.0');
      expect(joined).toContain('累计失败 1 次');
      // ★ 核心断言：失败日志里绝不能出现提交的口令
      expect(joined).not.toContain(secretPw);
    } finally {
      restore();
    }
  });

  it('㉔ 登录成功写 log 日志，同样不含口令明文', async () => {
    const good = 'the-real-password';
    const { ctrl, req, reply, lines, restore } = await makeController(good);
    try {
      await ctrl.login(req, reply, { password: good });
      const logs = lines.filter((l) => l.level === 'log');
      const joined = logs.map((l) => l.msg).join('\n');
      expect(joined).toContain('登录成功');
      expect(joined).toContain('203.0.113.9');
      expect(joined).not.toContain(good);
    } finally {
      restore();
    }
  });

  it('㉕ 缺 password 字段时写 warn 且不回显收到的值', async () => {
    const { ctrl, req, reply, lines, restore } = await makeController('whatever');
    try {
      await expect(ctrl.login(req, reply, { password: 12345 as never })).rejects.toThrow();
      const joined = lines.map((l) => l.msg).join('\n');
      expect(joined).toContain('缺少 password 字段');
      expect(joined).not.toContain('12345');
    } finally {
      restore();
    }
  });

  it('㉖ UA 里的换行/控制字符被清洗，超长被截断（防日志注入与刷屏）', async () => {
    const evil = `evil\nFAKE LOG LINE${'x'.repeat(300)}`;
    const { ctrl, req, reply, lines, restore } = await makeController('correct-password', { ua: evil });
    try {
      await expect(ctrl.login(req, reply, { password: 'wrong' })).rejects.toThrow();
      const joined = lines.map((l) => l.msg).join('\n');
      // 换行被替换成空格 → "FAKE LOG LINE" 仍在一行内，但整条消息里不应出现裸换行
      for (const l of lines) expect(l.msg).not.toContain('\n');
      // UA 被截断
      expect(joined).not.toContain('x'.repeat(200));
      expect(joined).toContain('...');
    } finally {
      restore();
    }
  });

  it('㉗ ★ 取 XFF 里的来源 IP（经 Nginx 反代时不能记成 127.0.0.1）', async () => {
    const { ctrl, req, reply, lines, restore } = await makeController('correct-password');
    try {
      await expect(ctrl.login(req, reply, { password: 'wrong' })).rejects.toThrow();
      const joined = lines.map((l) => l.msg).join('\n');
      // 真实客户端 IP 必须出现
      expect(joined).toContain('203.0.113.9');
      // ★ 且不能是回环 —— 若退回用 req.ip，日志会全是 127.0.0.1，审计失效
      expect(joined).not.toContain('ip=127.0.0.1');
    } finally {
      restore();
    }
  });

  it('㉘ ★ 不同客户端 IP 分桶限流：A 被锁不影响 B（反代场景的要害）', async () => {
    const { ctrl, req, reply, restore } = await makeController('correct-password');
    try {
      // 造一个 A 的请求：从 A 连错 10 次把它锁掉
      const reqA = {
        ...(req as Record<string, unknown>),
        headers: {
          origin: 'https://relay.example:8443',
          host: 'relay.example:8443',
          'x-forwarded-for': '198.51.100.1',
        },
      };
      for (let i = 0; i < 10; i += 1) {
        await ctrl.login(reqA as never, reply, { password: 'wrong' }).catch(() => undefined);
      }
      // A 第 11 次应被限流
      await expect(ctrl.login(reqA as never, reply, { password: 'wrong' })).rejects.toThrow(
        /次数过多/,
      );

      // B（不同 IP）不受影响：应仍是「口令不正确」而非限流
      const reqB = {
        ...(req as Record<string, unknown>),
        headers: {
          origin: 'https://relay.example:8443',
          host: 'relay.example:8443',
          'x-forwarded-for': '198.51.100.2',
        },
      };
      await expect(ctrl.login(reqB as never, reply, { password: 'wrong' })).rejects.toThrow(
        /管理口令不正确/,
      );
    } finally {
      restore();
    }
  });

  it('㉙ ★ 客户端伪造的 XFF 首段不被采信（取末段 = Nginx 写入的真实 IP）', async () => {
    const { ctrl, req, reply, lines, restore } = await makeController('correct-password');
    try {
      // 攻击形态：客户端自填 1.2.3.4，Nginx 追加真实对端
      const spoofed = {
        ...(req as Record<string, unknown>),
        headers: {
          origin: 'https://relay.example:8443',
          host: 'relay.example:8443',
          'x-forwarded-for': '1.2.3.4, 120.243.96.59',
        },
      };
      await expect(ctrl.login(spoofed as never, reply, { password: 'wrong' })).rejects.toThrow();
      const joined = lines.map((l) => l.msg).join('\n');
      // 必须记下真实 IP，而不是攻击者声称的那个
      expect(joined).toContain('120.243.96.59');
      expect(joined).not.toContain('ip=1.2.3.4');
    } finally {
      restore();
    }
  });
});
