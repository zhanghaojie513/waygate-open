/**
 * `ClientKeyGuard` 的两条**入站留痕**行为（2026-10-08）。
 *
 * 这个守卫此前没有独立单测 —— 它的行为只被 `wiring.spec.ts` 间接覆盖（只验 401 的形状）。
 * 这里补的是两件**会静默出错**的事：
 *
 *   ① `last_seen_ip` 的取段 —— 曾经自己取 XFF 的**首段**，而同一仓库的
 *      `common/client-ip.ts` 明确论证过必须取**末段**（首段是攻击者可填的）。
 *      取错的表现是"库里的 IP 不对"，而它只落库、当前无界面，所以**不会有人发现**。
 *   ② 拒绝留痕要带 IP 与 UA，且 UA 要脱敏（去控制字符、截断）——
 *      否则伪造的 UA 能往 journal 里插假日志行。
 *
 * 建表走**生产用的** `runMigrations`（内部自己读 schema.sql 并执行 DDL）——
 * 不在这里手写"读文件 + exec"，少一条"测试的建表方式与生产不同"的漂移。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientKeyGuard, type RequestWithKeyContext } from './key.guard';
import { hashKey } from './keys';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { runMigrations } from '../store/migrate';
import type { RelayConfigService } from '../config/config.service';

const SECRET = 'guard-test-secret';
const PLAIN_KEY = 'sk-waygate-0123456789abcdef01234567';

let db: Database.Database;
let keys: ClientKeysRepository;
let guard: ClientKeyGuard;

/** 造一个最小 ExecutionContext 桩，只喂守卫真正会读的东西。 */
function ctxFor(req: RequestWithKeyContext) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as Parameters<ClientKeyGuard['canActivate']>[0];
}

function makeReq(overrides: Partial<RequestWithKeyContext> = {}): RequestWithKeyContext {
  return {
    headers: { authorization: `Bearer ${PLAIN_KEY}` },
    ip: '127.0.0.1',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  // 空库 → 走 schema.sql 一次建表（与生产首启同一条路径）。
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  keys = new ClientKeysRepository(db);
  keys.create({
    id: 'k_guard',
    name: '守卫测试',
    keyHash: hashKey(SECRET, PLAIN_KEY),
    keyHint: 'sk-waygate-0123…4567',
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });
  const config = { secret: SECRET } as unknown as RelayConfigService;
  guard = new ClientKeyGuard(config, keys);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const lastSeenIp = (): string | null =>
  (db.prepare('SELECT last_seen_ip FROM client_keys WHERE id = ?').get('k_guard') as {
    last_seen_ip: string | null;
  }).last_seen_ip;

describe('ClientKeyGuard · last_seen_ip 取的是 XFF 末段', () => {
  it('★ 多段 XFF 时取**末段**（首段是客户端可伪造的，见 common/client-ip.ts 文件头）', () => {
    // 客户端伪造了首段 1.2.3.4，Nginx 在末尾写入真实来源 198.51.100.2
    const req = makeReq({
      headers: { authorization: `Bearer ${PLAIN_KEY}`, 'x-forwarded-for': '1.2.3.4, 198.51.100.2' },
    });
    expect(guard.canActivate(ctxFor(req))).toBe(true);
    expect(lastSeenIp()).toBe('198.51.100.2');
  });

  it('单段 XFF 原样取用（Nginx 覆写语义下的常态）', () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${PLAIN_KEY}`, 'x-forwarded-for': '203.0.113.7' },
    });
    guard.canActivate(ctxFor(req));
    expect(lastSeenIp()).toBe('203.0.113.7');
  });

  it('无 XFF 时回落 socket 对端', () => {
    guard.canActivate(ctxFor(makeReq({ ip: '192.0.2.5' })));
    expect(lastSeenIp()).toBe('192.0.2.5');
  });

  it('XFF 是空串/纯空白时不误用空值，回落 socket 对端', () => {
    // 每轮用不同的对端 IP：touch 对「同 IP 60s 内」节流不写库，IP 变化才必写
    for (const [v, ip] of [['', '192.0.2.9'], ['   ', '192.0.2.10']] as const) {
      db.prepare('UPDATE client_keys SET last_seen_ip = NULL WHERE id = ?').run('k_guard');
      const req = makeReq({
        ip,
        headers: { authorization: `Bearer ${PLAIN_KEY}`, 'x-forwarded-for': v },
      });
      guard.canActivate(ctxFor(req));
      expect(lastSeenIp()).toBe(ip);
    }
  });

  it('同一 IP 60 秒内重复使用不重复写 last_seen（写放大节流），IP 变化立即落库', () => {
    const lastSeenAt = (): number | null =>
      (db.prepare('SELECT last_seen_at FROM client_keys WHERE id = ?').get('k_guard') as {
        last_seen_at: number | null;
      }).last_seen_at;
    guard.canActivate(ctxFor(makeReq({ ip: '192.0.2.20' })));
    expect(lastSeenAt()).not.toBeNull();
    db.prepare('UPDATE client_keys SET last_seen_at = 1 WHERE id = ?').run('k_guard');
    guard.canActivate(ctxFor(makeReq({ ip: '192.0.2.20' })));
    expect(lastSeenAt()).toBe(1); // 被节流：未写库
    guard.canActivate(ctxFor(makeReq({ ip: '192.0.2.21' })));
    expect(lastSeenIp()).toBe('192.0.2.21'); // IP 变了：立即写
    expect(lastSeenAt()).not.toBe(1);
  });
});

describe('ClientKeyGuard · 拒绝时留痕（走 stdout，不落 requests 表）', () => {
  /**
   * 抓 warn 内容。
   *
   * ⚠️ **不要**用 `vi.spyOn(process.stdout, 'write')` 去抓 —— 实测它单独跑时能过、
   * 混在整套里跑就抓到空串（Nest Logger 的输出不保证同步落到那个流上）。
   * 直接钉 `Logger.prototype.warn` 这个**方法调用**，才是确定性的：
   * 它断言的是"守卫确实要求记这条"，而不是"这条恰好在这一刻被写到了某个流"。
   */
  function capture(): string[] {
    const out: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      out.push(String(message));
    });
    return out;
  }

  it('★ 拒绝日志含 reason / hint / 来源 IP / UA', () => {
    const out = capture();
    const req = makeReq({
      headers: {
        authorization: 'Bearer sk-waygate-ffffffffffffffffffffffff', // 未知密钥
        'user-agent': 'curl/8.21.0',
        'x-forwarded-for': '203.0.113.7',
      },
    });
    expect(() => guard.canActivate(ctxFor(req))).toThrow();
    const line = out.join('');
    expect(line).toContain('客户端密钥被拒绝');
    expect(line).toContain('reason=unknown');
    expect(line).toContain('ip=203.0.113.7');
    expect(line).toContain('ua="curl/8.21.0"');
  });

  it('★ UA 里的换行/控制字符被清洗（防日志注入：伪造 UA 插假日志行）', () => {
    const out = capture();
    const req = makeReq({
      headers: {
        authorization: 'Bearer sk-waygate-ffffffffffffffffffffffff',
        // 试图插入一条假的「登录成功」日志行
        'user-agent': 'evil\n2026-01-01 LOG 登录成功 ip=1.2.3.4',
      },
    });
    expect(() => guard.canActivate(ctxFor(req))).toThrow();
    const line = out.join('');
    // 原始换行必须消失（否则 journal 里会多出一行）
    expect(line).not.toContain('evil\n');
    expect(line).toContain('evil 2026-01-01');
  });

  it('★ 超长 UA 被截断（防刷屏），且带省略号', () => {
    const out = capture();
    const req = makeReq({
      headers: {
        authorization: 'Bearer sk-waygate-ffffffffffffffffffffffff',
        'user-agent': `evil/${'x'.repeat(500)}`,
      },
    });
    expect(() => guard.canActivate(ctxFor(req))).toThrow();
    const line = out.join('');
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(400);
  });

  it('★ 缺 Authorization 头也留痕（这一支不查库，以前只有抛错、没有日志）', () => {
    const out = capture();
    expect(() => guard.canActivate(ctxFor(makeReq({ headers: {} })))).toThrow();
    expect(out.join('')).toContain('reason=malformed_or_missing');
  });

  it('被拒请求**不落 requests 表**（落表会污染 successRate 与请求数）', () => {
    capture();
    expect(() => guard.canActivate(ctxFor(makeReq({ headers: {} })))).toThrow();
    const n = (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('拒绝**不更新** last_seen_at / last_seen_ip（「多久没被用过」不能被失败尝试刷新）', () => {
    capture();
    const req = makeReq({ headers: { authorization: 'Bearer sk-waygate-ffffffffffffffffffffffff' } });
    expect(() => guard.canActivate(ctxFor(req))).toThrow();
    const row = db
      .prepare('SELECT last_seen_at, last_seen_ip FROM client_keys WHERE id = ?')
      .get('k_guard') as { last_seen_at: number | null; last_seen_ip: string | null };
    expect(row.last_seen_at).toBeNull();
    expect(row.last_seen_ip).toBeNull();
  });
});
