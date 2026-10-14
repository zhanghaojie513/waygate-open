/**
 * `GET /v1/usage` 密钥自查端点（v0.4.36）。
 *
 * 两个必须钉死的行为：
 *   ① 形状 —— quota/remaining 为 null 表示「不限」，下游把它当 0 就全错了；
 *   ② @SkipKeyPolicy 语义 —— 配额已用尽的密钥仍能查余量（查询端点不被自己拦掉）。
 * 后者在 guard 层测（元数据在路由上，控制器单测够不到 guard）。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyUsageController } from './usage.controller';
import { ClientKeyGuard, SKIP_KEY_POLICY_KEY } from '../auth/key.guard';
import { hashKey } from '../auth/keys';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { runMigrations } from '../store/migrate';
import type { RelayConfigService } from '../config/config.service';

const SECRET = 'usage-test-secret';
const PLAIN_KEY = 'sk-waygate-0123456789abcdef01234567';

let db: Database.Database;
let keys: ClientKeysRepository;
let controller: KeyUsageController;

function seedKey(policy: { ipWhitelist?: string; maxIps?: number | null; tokenQuota?: number | null }): void {
  keys.create({
    id: 'k_usage',
    name: '自查测试',
    keyHash: hashKey(SECRET, PLAIN_KEY),
    keyHint: 'sk-waygate-0123…4567',
    scope: '{"type":"family","value":"kimi"}',
    client: null,
    clients: '[]',
    ipWhitelist: policy.ipWhitelist ?? '[]',
    maxIps: policy.maxIps ?? null,
    tokenQuota: policy.tokenQuota ?? null,
    expiresAt: Date.now() + 86_400_000,
    source: 'console',
  });
}

function logRequest(remoteIp: string, totalTokens: number): void {
  db.prepare(
    `INSERT INTO requests (ts, trace_id, key_id, key_hint, model, status, prompt_tokens,
       completion_tokens, total_tokens, credits, stream, retry_count, note, remote_ip, created_at)
     VALUES (?, ?, 'k_usage', 'hint', 'kimi-k3', 200, 0, ?, ?, 0, 1, 0, '', ?, ?)`,
  ).run(Date.now(), `t-${Math.random()}`, totalTokens, totalTokens, remoteIp, Date.now());
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  keys = new ClientKeysRepository(db);
  controller = new KeyUsageController(keys);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('GET /v1/usage · 形状', () => {
  it('限额密钥：used / quota / remaining 三件套 + 总请求数 + 到期时间', () => {
    seedKey({ maxIps: 3, tokenQuota: 1000 });
    logRequest('198.51.100.1', 400);
    logRequest('198.51.100.2', 350);

    const res = controller.usage({
      headers: {},
      keyContext: { keyId: 'k_usage', keyHint: 'hint', client: null, clients: [], scope: { type: 'all' } },
    }) as Record<string, any>;

    expect(res.object).toBe('relay_key_usage');
    expect(res.name).toBe('自查测试');
    expect(res.enabled).toBe(true);
    expect(typeof res.expires_at).toBe('string');
    expect(res.scope).toEqual({ type: 'family', value: 'kimi' });
    expect(res.usage.requests_total).toBe(2);
    expect(res.usage.tokens).toEqual({ used: 750, quota: 1000, remaining: 250 });
    expect(res.usage.ips).toEqual({ used: 2, quota: 3, remaining: 1 });
    expect(res.usage.ip_whitelist_count).toBe(0);
  });

  it('★ 不限额密钥：quota / remaining 为 null（= 不限），绝不能是 0', () => {
    seedKey({});
    logRequest('198.51.100.1', 100);

    const res = controller.usage({
      headers: {},
      keyContext: { keyId: 'k_usage', keyHint: 'hint', client: null, clients: [], scope: { type: 'all' } },
    }) as Record<string, any>;

    expect(res.usage.tokens).toEqual({ used: 100, quota: null, remaining: null });
    expect(res.usage.ips).toEqual({ used: 1, quota: null, remaining: null });
  });

  it('用量可超配额（软上限）：remaining 钳到 0，不为负', () => {
    seedKey({ tokenQuota: 500 });
    logRequest('198.51.100.1', 800); // 最后一笔超出

    const res = controller.usage({
      headers: {},
      keyContext: { keyId: 'k_usage', keyHint: 'hint', client: null, clients: [], scope: { type: 'all' } },
    }) as Record<string, any>;

    expect(res.usage.tokens).toEqual({ used: 800, quota: 500, remaining: 0 });
  });

  it('守卫通过后密钥被并发删除：返回 OpenAI 形状的错误对象（不抛裸异常）', () => {
    seedKey({});
    const res = controller.usage({
      headers: {},
      keyContext: { keyId: 'k_gone', keyHint: 'hint', client: null, clients: [], scope: { type: 'all' } },
    }) as Record<string, any>;
    expect(res.error.code).toBe('invalid_api_key');
  });
});

describe('ClientKeyGuard · @SkipKeyPolicy 语义', () => {
  /** 带 SkipKeyPolicy 元数据的假 handler（绕开装饰器语法，直接 defineMetadata）。 */
  const decoratedHandler = (() => {
    const fn = () => undefined;
    Reflect.defineMetadata(SKIP_KEY_POLICY_KEY, true, fn);
    return fn;
  })();
  const plainHandler = () => undefined;

  function ctxFor(req: Record<string, unknown>, handler: () => undefined) {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => class Dummy {},
    } as unknown as Parameters<ClientKeyGuard['canActivate']>[0];
  }

  const makeReq = () => ({
    headers: { authorization: `Bearer ${PLAIN_KEY}`, 'x-forwarded-for': '198.51.100.1' },
    ip: '127.0.0.1',
  });

  it('★ 配额用尽的密钥仍能访问标注路由（查询端点不被自己拦掉）', () => {
    seedKey({ tokenQuota: 100, ipWhitelist: JSON.stringify(['203.0.113.7']) });
    const guard = new ClientKeyGuard({ secret: SECRET } as unknown as RelayConfigService, keys);
    // 来源 198.51.100.1：不在白名单 + 配额未满 —— 白名单拦截在普通路由生效
    expect(() => guard.canActivate(ctxFor(makeReq(), plainHandler))).toThrow();
    // 同一请求打到 SkipKeyPolicy 路由：放行
    expect(guard.canActivate(ctxFor(makeReq(), decoratedHandler))).toBe(true);
  });

  it('跳过的只是策略层：密钥无效照样 401', () => {
    seedKey({});
    const guard = new ClientKeyGuard({ secret: SECRET } as unknown as RelayConfigService, keys);
    const req = {
      headers: { authorization: 'Bearer sk-waygate-not-the-right-one-at-all0' },
      ip: '127.0.0.1',
    };
    expect(() => guard.canActivate(ctxFor(req, decoratedHandler))).toThrow();
  });
});
