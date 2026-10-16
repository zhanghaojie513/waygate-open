/**
 * `POST /v1/messages` controller 级端到端测试的共享脚手架。
 *
 * 用**真实** `ProxyService` / `ProxyLogger` / 内存 SQLite（只有上游 fetch 被桩掉），
 * 因此审计落库、并发闸、错误映射都走生产路径。拆成独立文件的原因：单文件 ≤300 行门禁。
 */

import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { ClientKeysRepository } from '../../store/repositories/client-keys.repo';
import { RequestsRepository } from '../../store/repositories/requests.repo';
import { AggregatesRepository } from '../../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import type { RelayConfigService } from '../../config/config.service';
import type { KeyContext, RequestWithKeyContext } from '../../auth/key.guard';
import { ProxyLogger } from '../proxy-log';
import { ProxyService } from '../proxy.service';
import { AnthropicController } from './anthropic.controller';
import { fakeWbOauth } from '../openai-upstream/wb-oauth.harness';

const SCHEMA_PATH = join(__dirname, '..', '..', 'store', 'schema.sql');
const enc = new TextEncoder();

export const KEY_ID = 'k_anth';

export const keyContext: KeyContext = {
  keyId: KEY_ID,
  keyHint: 'sk-waygate-aaaa…bbbb',
  client: 'Claude Code',
  clients: [],
  scope: { type: 'all' },
};

export function frameJson(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const TEXT_1 = frameJson({ id: 'x', model: 'kimi-k2.7', choices: [{ delta: { role: 'assistant', content: '你好' }, finish_reason: null }] });
export const TEXT_2 = frameJson({
  id: 'x',
  model: 'kimi-k2.7',
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
});
export const DONE = 'data: [DONE]\n\n';

export interface ReplyState {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rawHead: number;
  rawWrites: string[];
}

export interface Harness {
  db: Database.Database;
  controller: AnthropicController;
  proxy: ProxyService;
  reply: FastifyReply;
  captured: { body?: Record<string, unknown> };
  state: ReplyState;
  ended: Promise<void>;
  count: () => number;
  latest: () => Record<string, unknown> | undefined;
}

export function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(enc.encode(chunks[i++]));
        return;
      }
      c.close();
    },
  });
}

export function makeHarness(): Harness {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const keys = new ClientKeysRepository(db);
  const requests = new RequestsRepository(db, new AggregatesRepository(db));
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  providers.create({ id: 'p_anth', name: 'TestUpstream', baseUrl: 'https://up.example.com', active: true });
  const log = new ProxyLogger(requests, catalog);
  const config = {
    get: () => ({
      limits: { concurrency: 8, firstByteTimeoutMs: 30_000 },
      upstream: { spoofUA: true, userAgent: 'WorkBuddy/5.8.0', baseUrl: 'https://copilot.tencent.com' },
      logs: { recordRequestBody: false, recordResponseBody: false },
    }),
    upstreamKey: 'ck_test_0123456789abcdef',
  } as unknown as RelayConfigService;

  catalog.seed('p_anth', [{ id: 'kimi-k2.7', displayName: 'Kimi K2.7', tag: null, multiplier: 1 }]);
  keys.create({
    id: KEY_ID,
    name: '测试密钥',
    keyHash: 'h_anth',
    keyHint: 'sk-waygate-aaaa…bbbb',
    scope: '{"type":"all"}',
    client: 'Claude Code',
    clients: JSON.stringify(['Claude Code']),
    expiresAt: null,
    source: 'console',
  });

  const proxy = new ProxyService(config, catalog, log, providers, undefined, fakeWbOauth('ck_test_0123456789abcdef'));
  const controller = new AnthropicController(proxy);

  // 混合 reply：非流式用 code/header/send，流式用 raw
  const raw = new EventEmitter() as unknown as Record<string, unknown>;
  const state: ReplyState = { status: 0, headers: {}, body: undefined, rawHead: 0, rawWrites: [] };
  let resolveEnd!: () => void;
  const ended = new Promise<void>((r) => {
    resolveEnd = r;
  });
  raw.writeHead = (s: number) => {
    state.rawHead = s;
  };
  raw.write = (s: string) => {
    state.rawWrites.push(s);
    return true;
  };
  raw.end = () => {
    resolveEnd();
  };
  const reply = {
    raw,
    code(n: number) {
      state.status = n;
      return reply;
    },
    header(k: string, v: string) {
      state.headers[k] = v;
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      resolveEnd();
      return reply;
    },
  } as unknown as FastifyReply;

  const captured: { body?: Record<string, unknown> } = {};
  return {
    db,
    controller,
    proxy,
    reply,
    captured,
    state,
    ended,
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n,
    latest: () => db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined,
  };
}

/** 打一次 /v1/messages。fetchImpl 收到 (url, init)，可读 init.body。 */
export async function invoke(
  h: Harness,
  body: unknown,
  fetchImpl: (url: string, init: { body: string }) => Promise<unknown>,
): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { body: string }) => {
      h.captured.body = JSON.parse(init.body) as Record<string, unknown>;
      return fetchImpl(url, init);
    }),
  );
  const req = {
    headers: { authorization: 'Bearer sk-waygate-aaaa', 'user-agent': 'claude-cli/1.0' },
    ip: '127.0.0.1',
    keyContext,
  } as RequestWithKeyContext;
  await h.controller.messages(req as never, h.reply, body as never);
}

/** 上游 200 + SSE 桩。 */
export const okSse =
  (chunks: string[]) =>
  async (): Promise<unknown> => ({ ok: true, status: 200, body: sseStream(chunks) });

/** 上游非 2xx 桩。 */
export const failSse =
  (status: number, text: string) =>
  async (): Promise<unknown> => ({ ok: false, status, body: null, text: async () => text });
