/**
 * `ClientKeyGuard` 的密钥级访问策略（v0.4.35）：IP 白名单 / 最大 IP 数 / Token 配额。
 *
 * 三项都不配置时必须**零行为变化**（老密钥直通）；配置后的拒绝语义必须可区分：
 *   · 白名单不命中 / 新 IP 超上限 → 403（ip_not_allowed / max_ips_exceeded）
 *   · Token 配额用尽 → 429（token_quota_exceeded）
 * 「用量」的事实来源是 requests 表（remote_ip 去重计数、total_tokens 累计）——
 * 这里的造数直接写 requests，与生产同一条查询路径。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ClientKeyGuard, type RequestWithKeyContext } from './key.guard';
import { hashKey } from './keys';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { runMigrations } from '../store/migrate';
import type { RelayConfigService } from '../config/config.service';

const SECRET = 'policy-test-secret';
const PLAIN_KEY = 'sk-waygate-0123456789abcdef01234567';

let db: Database.Database;
let keys: ClientKeysRepository;
let requests: RequestsRepository;
let guard: ClientKeyGuard;

function ctxFor(req: RequestWithKeyContext) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as Parameters<
    ClientKeyGuard['canActivate']
  >[0];
}

function makeReq(ip: string): RequestWithKeyContext {
  return {
    headers: { authorization: `Bearer ${PLAIN_KEY}`, 'x-forwarded-for': ip },
    ip: '127.0.0.1',
  };
}

/**
 * 以某个来源 IP 写一条请求（remote_ip / total_tokens 可指定）。
 * 走生产写路径 RequestsRepository.log()：累计用量由 KeyUsageCache 随写入增量维护，
 * 绕过仓库在同一连接上裸写 SQL 的话缓存感知不到（生产代码没有这种写法）。
 */
function logRequest(remoteIp: string, totalTokens: number, keyId = 'k_policy'): void {
  requests.log({
    ts: Date.now(),
    traceId: `t-${Math.random()}`,
    clientId: keyId,
    client: 'policy',
    clientRule: 2,
    keyId,
    keyHint: 'hint',
    model: 'kimi-k3',
    modelDisplay: null,
    status: 200,
    upstreamCode: null,
    ms: 1,
    queuedMs: 0,
    firstByteMs: null,
    promptTokens: 0,
    completionTokens: totalTokens,
    totalTokens,
    cachedTokens: 0,
    credits: 0,
    stream: true,
    retryCount: 0,
    note: '',
    remoteIp,
    ua: null,
    requestBody: null,
    responseBody: null,
  });
}

/** 用指定策略建一把测试密钥（覆盖 ip_whitelist / max_ips / token_quota 三列）。 */
function seedKey(policy: { ipWhitelist?: string; maxIps?: number | null; tokenQuota?: number | null }): void {
  keys.create({
    id: 'k_policy',
    name: '策略测试',
    keyHash: hashKey(SECRET, PLAIN_KEY),
    keyHint: 'sk-waygate-0123…4567',
    scope: '{"type":"all"}',
    client: null,
    clients: '[]',
    ipWhitelist: policy.ipWhitelist ?? '[]',
    maxIps: policy.maxIps ?? null,
    tokenQuota: policy.tokenQuota ?? null,
    expiresAt: null,
    source: 'console',
  });
}

/** 换一把密钥重造（每个 it 独立策略）。 */
function reseed(policy: Parameters<typeof seedKey>[0]): void {
  db.prepare('DELETE FROM client_keys').run();
  requests.clearAll(); // 走仓库：同时作废用量缓存
  seedKey(policy);
  guard = new ClientKeyGuard({ secret: SECRET } as unknown as RelayConfigService, keys);
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  keys = new ClientKeysRepository(db);
  requests = new RequestsRepository(db, new AggregatesRepository(db));
  seedKey({});
  guard = new ClientKeyGuard({ secret: SECRET } as unknown as RelayConfigService, keys);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('ClientKeyGuard · 策略未配置 = 零行为变化', () => {
  it('三项全空的老密钥直通（不查策略表）', () => {
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.1')))).toBe(true);
  });
});

describe('ClientKeyGuard · IP 白名单', () => {
  it('名单内来源放行（含 CIDR 命中）', () => {
    reseed({ ipWhitelist: JSON.stringify(['203.0.113.7', '10.0.0.0/8']) });
    expect(guard.canActivate(ctxFor(makeReq('203.0.113.7')))).toBe(true);
    expect(guard.canActivate(ctxFor(makeReq('10.1.2.3')))).toBe(true);
  });

  it('名单外来源 403，错误码 ip_not_allowed（区别于密钥无效的 401）', () => {
    reseed({ ipWhitelist: JSON.stringify(['203.0.113.7']) });
    const err = (() => {
      try {
        guard.canActivate(ctxFor(makeReq('198.51.100.9')));
      } catch (e) {
        return e as { getStatus: () => number; getResponse: () => { error: { code: string } } };
      }
    })();
    expect(err).toBeDefined();
    expect(err!.getStatus()).toBe(403);
    expect(err!.getResponse().error.code).toBe('ip_not_allowed');
  });
});

describe('ClientKeyGuard · 最大 IP 数', () => {
  it('新 IP 未达上限放行，达上限后新 IP 403（max_ips_exceeded）', () => {
    reseed({ maxIps: 2 });
    logRequest('198.51.100.1', 100); // 历史：1 个来源
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.2')))).toBe(true); // 新 IP → 第 2 个，放行
    logRequest('198.51.100.2', 100); // 现在 2 个来源
    const err = (() => {
      try {
        guard.canActivate(ctxFor(makeReq('198.51.100.3'))); // 新 IP → 超过 2
      } catch (e) {
        return e as { getStatus: () => number; getResponse: () => { error: { code: string } } };
      }
    })();
    expect(err).toBeDefined();
    expect(err!.getStatus()).toBe(403);
    expect(err!.getResponse().error.code).toBe('max_ips_exceeded');
  });

  it('★ 老 IP 不受上限影响（上限挡的是新增来源，不是已有来源）', () => {
    reseed({ maxIps: 1 });
    logRequest('198.51.100.1', 100); // 1 个来源，已满
    logRequest('198.51.100.2', 100); // 2 个来源（超限是历史形成的，不追溯）
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.1')))).toBe(true);
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.2')))).toBe(true);
    // 但第 3 个新来源会被挡
    expect(() => guard.canActivate(ctxFor(makeReq('198.51.100.3')))).toThrow();
  });
});

describe('ClientKeyGuard · Token 配额', () => {
  it('累计未达配额放行；达到后 429（token_quota_exceeded）', () => {
    reseed({ tokenQuota: 1000 });
    logRequest('198.51.100.1', 600);
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.1')))).toBe(true); // 600 < 1000
    logRequest('198.51.100.1', 400); // 累计 1000
    const err = (() => {
      try {
        guard.canActivate(ctxFor(makeReq('198.51.100.1')));
      } catch (e) {
        return e as { getStatus: () => number; getResponse: () => { error: { code: string } } };
      }
    })();
    expect(err).toBeDefined();
    expect(err!.getStatus()).toBe(429);
    expect(err!.getResponse().error.code).toBe('token_quota_exceeded');
  });

  it('软上限：差 1 个 token 也放行（最后一笔允许超出）', () => {
    reseed({ tokenQuota: 1000 });
    logRequest('198.51.100.1', 999); // 999 < 1000 → 放行
    expect(guard.canActivate(ctxFor(makeReq('198.51.100.1')))).toBe(true);
  });
});

describe('ClientKeyGuard · 策略判定顺序', () => {
  it('白名单先于配额：来源不符时即使配额没满也 403 ip_not_allowed', () => {
    reseed({ ipWhitelist: JSON.stringify(['203.0.113.7']), tokenQuota: 1_000_000 });
    const err = (() => {
      try {
        guard.canActivate(ctxFor(makeReq('198.51.100.1')));
      } catch (e) {
        return e as { getStatus: () => number; getResponse: () => { error: { code: string } } };
      }
    })();
    expect(err).toBeDefined();
    expect(err!.getStatus()).toBe(403);
    expect(err!.getResponse().error.code).toBe('ip_not_allowed');
  });
});
