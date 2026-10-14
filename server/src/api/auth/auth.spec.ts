import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  __setScryptParamsForTests,
  generatePassword,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from './password';
import { SESSION_TTL_SECONDS, buildClearCookie, buildSessionCookie, issueSession, verifySession } from './session';
import { checkOrigin, needsOriginCheck, parseTrustedOrigins } from './origin';
import { LoginRateLimiter } from './rate-limit';

const SECRET = 'test-secret-for-api-spec';

/**
 * ★ 测试用**低成本** scrypt（N=16）。
 *
 * 为什么必须这样做：scrypt 是 CPU 密集的，本文件里几十次「哈希 / 验密」在生产档
 * （N=16384）下单例可达 1–3s，机器繁忙时会逼近 vitest 默认 **5s 单测超时** ——
 * 结果随负载漂移（同一份代码忙时红、闲时绿）。降到 N=16 后全部毫秒级，与负载无关。
 *
 * 安全性未被削弱：`verifyPassword` 从**存储串自身**读参数，测试里种下/校验的都是
 * 低成本串；生产默认档仍是 N=16384（由下面的 ⓪ 断言钉住，防被误改低）。
 */
beforeAll(() => __setScryptParamsForTests({ N: 16, r: 8, p: 1 }));
afterAll(() => __setScryptParamsForTests(null));

describe('password · scrypt 存储格式', () => {
  it('⓪ ★ 生产默认档未被改低（N=16384）—— 防止「为跑得快把安全参数调没了」', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 16384, r: 8, p: 1 });
  });

  it('① 哈希串是 6 段 scrypt 格式，salt 每次不同', () => {
    const a = hashPassword('hunter2');
    const b = hashPassword('hunter2');
    expect(a.split('$')).toHaveLength(6);
    expect(a.startsWith('scrypt$')).toBe(true);
    // 同口令两次哈希必须不同（salt 随机）
    expect(a).not.toBe(b);
  });

  it('② 正确口令通过，错误口令不通过', async () => {
    const stored = hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('correct hors', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('③ 大小写与空白敏感（不做 trim / 不忽略大小写）', async () => {
    const stored = hashPassword('Secret');
    expect(await verifyPassword('secret', stored)).toBe(false);
    expect(await verifyPassword(' Secret', stored)).toBe(false);
  });

  it('④ 存储串损坏时返回 false 而不抛异常', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2', 'md5$1$1$1$aa$bb', 'scrypt$x$8$1$aa$bb']) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('⑤ 参数从存储串自身读取（换了 N 也能验证旧口令）', async () => {
    // 手工造一个 N=1024 的低强度串，verify 必须用它自带的 N
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const derived = scryptSync('legacy', salt, 32, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const legacy = ['scrypt', '1024', '8', '1', salt.toString('base64url'), derived.toString('base64url')].join('$');
    expect(await verifyPassword('legacy', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
  });

  it('⑥ 生成的口令长度为 16 且不含易混字符', () => {
    for (let i = 0; i < 20; i += 1) {
      const p = generatePassword(16);
      expect(p).toHaveLength(16);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('session · HMAC 签名 cookie', () => {
  it('⑦ 签发后可验证，payload 内容正确', () => {
    const { token, payload } = issueSession(SECRET);
    expect(payload.sub).toBe('admin');
    expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
    const checked = verifySession(SECRET, token);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.payload.jti).toBe(payload.jti);
  });

  it('⑧ 改 payload 会被发现（签名覆盖 base64 串，非原始 JSON）', () => {
    const { token } = issueSession(SECRET);
    const [payloadB64, sig] = token.split('.') as [string, string];

    // 伪造一个 sub 不是 admin 的 payload，签名沿用旧的
    const forged = Buffer.from(
      JSON.stringify({ sub: 'root', iat: 1, exp: 9999999999, jti: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(forged).not.toBe(payloadB64);
    expect(verifySession(SECRET, `${forged}.${sig}`).ok).toBe(false);

    // 直接篡改 payload 原文
    const tampered = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: 1, exp: 9999999999, jti: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(verifySession(SECRET, `${tampered}.${sig}`).ok).toBe(false);
  });

  it('⑨ 换 secret 一律失效', () => {
    const { token } = issueSession(SECRET);
    const r = verifySession('other-secret', token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('⑩ 过期令牌被拒，且过期判定用 exp 而非 iat', () => {
    const past = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000;
    const { token } = issueSession(SECRET, past);
    const r = verifySession(SECRET, token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('⑪ 畸形输入被拒（空 / 无点 / 点开头 / 点结尾 / null）', () => {
    for (const bad of ['', 'nodot', '.sig', 'payload.', null, undefined]) {
      const r = verifySession(SECRET, bad as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('malformed');
    }
  });

  it('⑫ cookie 属性符合契约（HttpOnly/Secure/SameSite=Strict/Path=/api）', () => {
    const cookie = buildSessionCookie('a.b');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api');
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(buildClearCookie()).toContain('Max-Age=0');
  });
});

describe('origin · CSRF 同源校验', () => {
  it('⑬ 安全方法免校验', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(needsOriginCheck(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(needsOriginCheck(m)).toBe(true);
  });

  it('⑭ 同源放行；跨站 / 缺头 / null / 异协议 一律拒', () => {
    const host = '127.0.0.1:8787';
    expect(checkOrigin({ method: 'POST', origin: `http://${host}`, host }).ok).toBe(true);
    expect(checkOrigin({ method: 'POST', origin: `https://${host}`, host }).ok).toBe(true);

    expect(checkOrigin({ method: 'POST', origin: undefined, host }).ok).toBe(false);
    expect(checkOrigin({ method: 'POST', origin: 'null', host }).ok).toBe(false);
    expect(checkOrigin({ method: 'POST', origin: 'http://evil.com', host }).ok).toBe(false);
    // 端口不同也算跨源
    expect(checkOrigin({ method: 'POST', origin: 'http://127.0.0.1:9999', host }).ok).toBe(false);
    expect(checkOrigin({ method: 'POST', origin: 'not-a-url', host }).ok).toBe(false);
    expect(checkOrigin({ method: 'POST', origin: `file://${host}`, host }).ok).toBe(false);
    // 缺 Host 无法比对
    expect(checkOrigin({ method: 'POST', origin: `http://${host}`, host: undefined }).ok).toBe(false);
  });

  it('⑮ GET 即便带异源 Origin 也放行（不参与写操作）', () => {
    expect(checkOrigin({ method: 'GET', origin: 'http://evil.com', host: 'a' }).ok).toBe(true);
  });

  it('⑯ 显式白名单放行（反向代理改写 Host 时的安全阀）', () => {
    // 场景：Vite changeOrigin 把 Host 改成 127.0.0.1:8787，Origin 是 localhost:5173
    const trusted = ['http://localhost:5173'];
    expect(
      checkOrigin({
        method: 'POST',
        origin: 'http://localhost:5173',
        host: '127.0.0.1:8787',
        trustedOrigins: trusted,
      }).ok,
    ).toBe(true);
    // 不在白名单里的仍然拒绝
    expect(
      checkOrigin({
        method: 'POST',
        origin: 'http://evil.com',
        host: '127.0.0.1:8787',
        trustedOrigins: trusted,
      }).ok,
    ).toBe(false);
  });

  it('⑰ parseTrustedOrigins 归一化并丢弃非法项', () => {
    expect(parseTrustedOrigins('https://a.com, http://localhost:5173/')).toEqual([
      'https://a.com',
      'http://localhost:5173',
    ]);
    // 带路径的归一成 origin
    expect(parseTrustedOrigins('https://a.com/some/path?x=1')).toEqual(['https://a.com']);
    // 非法 scheme 与乱码被丢弃，不抛
    expect(parseTrustedOrigins('ftp://a.com, not-a-url, https://ok.com')).toEqual(['https://ok.com']);
    expect(parseTrustedOrigins(undefined)).toEqual([]);
    expect(parseTrustedOrigins('')).toEqual([]);
  });
});

describe('rate-limit · 登录失败限流', () => {
  it('⑯ 第 10 次失败触发锁定，返回 retryAfterSeconds', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 1; i <= 9; i += 1) {
      const s = rl.recordFailure('1.2.3.4', t0);
      expect(s.locked).toBe(false);
    }
    const tenth = rl.recordFailure('1.2.3.4', t0);
    expect(tenth.locked).toBe(true);
    expect(tenth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('⑰ 锁定期间 status 保持锁定，锁定期满自动解锁', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) rl.recordFailure('1.2.3.4', t0);
    expect(rl.status('1.2.3.4', t0 + 1000).locked).toBe(true);
    // 锁定期满（10 分钟后）
    expect(rl.status('1.2.3.4', t0 + 10 * 60 * 1000 + 1).locked).toBe(false);
  });

  it('⑱ 按 IP 隔离：A 被锁不影响 B', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) rl.recordFailure('1.1.1.1', t0);
    expect(rl.status('1.1.1.1', t0).locked).toBe(true);
    expect(rl.status('2.2.2.2', t0).locked).toBe(false);
  });

  it('⑲ 成功登录清空计数（错 9 次后成功，不应再累计）', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i += 1) rl.recordFailure('1.2.3.4', t0);
    rl.recordSuccess('1.2.3.4');
    // 重新计 9 次仍不应锁定
    for (let i = 0; i < 9; i += 1) {
      expect(rl.recordFailure('1.2.3.4', t0).locked).toBe(false);
    }
  });

  it('⑳ 窗口外的旧失败不计入（滑动窗口语义）', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    // 9 次失败发生在很久以前
    for (let i = 0; i < 9; i += 1) rl.recordFailure('1.2.3.4', t0 - 11 * 60 * 1000);
    // 现在再来一次：旧的都过期了，不应锁定
    expect(rl.recordFailure('1.2.3.4', t0).locked).toBe(false);
  });

  it('㉑ recordFailure 回填 failures 计数，触发锁定那次仍报真实累计值', () => {
    const rl = new LoginRateLimiter();
    const t0 = 1_000_000;
    expect(rl.recordFailure('1.2.3.4', t0).failures).toBe(1);
    expect(rl.recordFailure('1.2.3.4', t0).failures).toBe(2);
    // 第 10 次触发锁定；此时内部计数数组会被清空，但返回值必须是 10（否则日志会误导）
    let tenth = rl.recordFailure('1.2.3.4', t0);
    for (let i = 3; i < 10; i += 1) tenth = rl.recordFailure('1.2.3.4', t0);
    expect(tenth.locked).toBe(true);
    expect(tenth.failures).toBe(10);
  });

  it('㉒ status() 是只读查询，不回填 failures（不泄露计数）', () => {
    const rl = new LoginRateLimiter();
    rl.recordFailure('1.2.3.4', 1_000_000);
    expect(rl.status('1.2.3.4', 1_000_000).failures).toBeUndefined();
  });
});
