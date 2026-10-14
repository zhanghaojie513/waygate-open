/**
 * HTTP 层装配验证：路由注册、`AnthropicKeyGuard`（x-api-key 归一化）+ 真 `ClientKeyGuard`、
 * `AnthropicExceptionFilter`（把守卫抛的 OpenAI 形状 401 重写成 Anthropic 形状）。
 *
 * 用最小 Nest 模块（真实 HTTP 栈 + 内存 SQLite），ProxyService 用桩，避免起真网络/上游。
 */

import 'reflect-metadata';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientKeyGuard } from '../../auth/key.guard';
import { hashKey } from '../../auth/keys';
import { ClientKeysRepository } from '../../store/repositories/client-keys.repo';
// ⚠️ 这里是**值导入**，不能写成 `import type` —— 下面第 72 行 `{ provide: RelayConfigService, … }`
// 要把类本身当 token 用（Nest 的 provide 是运行时的值，不是类型）。
import { RelayConfigService } from '../../config/config.service';
import type { StreamEvent } from '../proxy.service';
import { ProxyService } from '../proxy.service';
import { AnthropicController } from './anthropic.controller';
import { AnthropicKeyGuard } from './anthropic-key.guard';

const SCHEMA_PATH = join(__dirname, '..', '..', 'store', 'schema.sql');
const SECRET = 'wiring-test-secret';
const PLAIN_KEY = 'sk-waygate-0123456789abcdef01234567';

let current: NestFastifyApplication | null = null;

async function buildApp(): Promise<NestFastifyApplication> {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const keys = new ClientKeysRepository(db);
  keys.create({
    id: 'k_wire',
    name: '接线测试',
    keyHash: hashKey(SECRET, PLAIN_KEY),
    keyHint: 'sk-waygate-0123…4567',
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });

  const config = {
    secret: SECRET,
    upstreamKey: 'ck_wire',
    get: () => ({ limits: { concurrency: 8, firstByteTimeoutMs: 30_000 }, upstream: {}, logs: {} }),
    upstreamConfigured: () => true,
  } as unknown as RelayConfigService;

  // 桩：直接返回一段上游事件流（不发真网络）
  async function* events(): AsyncGenerator<StreamEvent> {
    yield { type: 'chunk', data: JSON.stringify({ id: 'x', model: 'kimi-k2.7', choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) };
    yield { type: 'chunk', data: JSON.stringify({ id: 'x', model: 'kimi-k2.7', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) };
    yield { type: 'done' };
  }
  const proxyStub = {
    assertBodyShape: () => undefined,
    callUpstream: async () => ({ traceId: 'wire-trace', status: 200, upstreamCode: null, events: events(), failure: null, model: 'kimi-k2.7' }),
    logRejection: () => undefined,
    activeCount: 0,
  } as unknown as ProxyService;

  @Module({
    controllers: [AnthropicController],
    providers: [
      AnthropicKeyGuard,
      ClientKeyGuard,
      { provide: ProxyService, useValue: proxyStub },
      { provide: RelayConfigService, useValue: config },
      { provide: ClientKeysRepository, useValue: keys },
    ],
  })
  class WiringModule {}

  const app = await NestFactory.create<NestFastifyApplication>(WiringModule, new FastifyAdapter(), { logger: false });
  await app.init();
  current = app;
  return app;
}

type InjectFn = (o: unknown) => Promise<{ statusCode: number; json: () => unknown }>;

function fastifyOf(app: NestFastifyApplication): { inject: InjectFn } {
  return app.getHttpAdapter().getInstance() as unknown as { inject: InjectFn };
}

const payload = { model: 'kimi-k2.7', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };

afterEach(async () => {
  if (current) {
    await current.close();
    current = null;
  }
});

describe('/v1/messages 装配', () => {
  it('缺密钥 → 401 且为 Anthropic 形状（不是 OpenAI 形状）', async () => {
    const app = await buildApp();
    const res = await fastifyOf(app).inject({ method: 'POST', url: '/v1/messages', payload });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.type).toBe('error');
    expect((body.error as Record<string, unknown>).type).toBe('authentication_error');
    // 绝不能是 OpenAI 的 {"error":{...,"code":...}}
    expect('code' in (body.error as Record<string, unknown>)).toBe(false);
  });

  it('x-api-key 头被归一化 → 鉴权通过并返回 Anthropic message', async () => {
    const app = await buildApp();
    const res = await fastifyOf(app).inject({ method: 'POST', url: '/v1/messages', payload, headers: { 'x-api-key': PLAIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('end_turn');
    expect(body.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('Authorization: Bearer 亦可（兼容）', async () => {
    const app = await buildApp();
    const res = await fastifyOf(app).inject({ method: 'POST', url: '/v1/messages', payload, headers: { authorization: `Bearer ${PLAIN_KEY}` } });
    expect(res.statusCode).toBe(200);
  });
});
