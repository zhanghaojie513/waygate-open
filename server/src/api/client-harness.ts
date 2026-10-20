/**
 * client_id 契约测试的公共夹具：内存库 + 真实 schema + 生产读口实例 + 造数助手。
 *
 * 为什么抽出来：断言分散在两个 spec（`client-id.spec.ts` 管分组/过滤/聚合正确性，
 * `client-display.spec.ts` 管显示名回落与传播），但装配完全相同。集中一处，
 * 测试只写断言，不重复 40 行 beforeEach。文件名**不含 .spec**，不会被 vitest 当测试跑。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { AggregatesRepository } from '../store/repositories/aggregates.repo';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ClientsService } from './clients.service';
import { OverviewService } from './overview.service';
import { RequestQueryService } from './requests.service';
import { resolveWindow } from './window';
import type { RelayConfigService } from '../config/config.service';
import { QuotaSourceService } from '../proxy/quota/quota-source.service';

const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');

export interface LogRec {
  clientId: string;
  client: string;
  clientRule: number;
  keyId?: string | null;
  keyHint?: string | null;
  model?: string;
  credits?: number | null;
  /** 本行 tokens（默认 150）。`share` 口径测试要让它与 credits 解耦时显式传。 */
  totalTokens?: number;
  /** HTTP 状态（默认 200）。空 model 的本地拒绝（429）等用例需要显式指定。 */
  status?: number;
  /** [v1.6.30] 实际路由到的提供商 id（归属测试用）。 */
  providerId?: string | null;
}

export function makeHarness() {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const keysRepo = new ClientKeysRepository(db);
  const requestsRepo = new RequestsRepository(db, new AggregatesRepository(db));
  /* [v0.5.15] byClient 归属需要目录与提供商（模型id → provider 名）。空目录 =
     全部走密钥归属回落，与旧口径一致，不改变本 harness 的既有断言。
     [v0.6.0] byProvider 归因同源，也传这两个。 */
  const catalog = new ModelCatalogRepository(db);
  const providers = new ProvidersRepository(db);
  const clients = new ClientsService(db, providers, catalog);
  // 额度来源在 client_id 契约测试里无关紧要：给一个永远「未接入」的桩，避免真起轮询。
  const overview = new OverviewService(db, {
    block: () => ({ available: false, reason: 'pending', remain: null, total: null, resetAt: null, stale: false, low: false, message: '（测试桩）' }),
    snapshot: () => ({ ledger: [], fetchedAt: null }),
  } as unknown as QuotaSourceService, {
    allBlocks: () => [],
  } as unknown as import('../proxy/anthropic-upstream/minimax-credit.service').MinimaxCreditService, catalog, providers, undefined);
  const config = {
    get: () => ({ logs: { recordRequestBody: false, recordResponseBody: false } }),
  } as unknown as RelayConfigService;
  const requestSvc = new RequestQueryService(db, config);
  const spec = resolveWindow('24h');

  let seq = 0;
  /** 一次请求写一行（走生产写路径 RequestsRepository.log）。 */
  const log = (rec: LogRec): void => {
    requestsRepo.log({
      ts: Date.now(),
      traceId: `trace-${++seq}`,
      clientId: rec.clientId,
      client: rec.client,
      clientRule: rec.clientRule,
      keyId: rec.keyId ?? null,
      keyHint: rec.keyHint ?? null,
      model: rec.model ?? 'kimi-k3',
      modelDisplay: null,
      status: rec.status ?? 200,
      upstreamCode: null,
      ms: 100,
      queuedMs: 0,
      firstByteMs: 40,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: rec.totalTokens ?? 150,
      cachedTokens: 0,
      /* 显式传 null = 上游未回报（未知）；未传 = 默认 1。
         不能用 `rec.credits ?? 1` —— 那会把 null 也变成 1，正是本项目
         「0/默认值 vs 未知」铁律要防的那种静默覆盖。 */
      credits: rec.credits === undefined ? 1 : rec.credits,
      stream: true,
      retryCount: 0,
      note: '',
      remoteIp: null,
      ua: null,
      requestBody: null,
      responseBody: null,
      providerId: rec.providerId ?? null,
    });
  };

  /** 落一把密钥（key_id 有 FK，写请求前必须先有它）。 */
  const makeKey = (id: string, client: string | null, keyHint = 'sk-waygate-aaaa…bbbb'): void => {
    keysRepo.create({
      id,
      name: `密钥-${id}`,
      keyHash: `hash-${id}`,
      keyHint,
      scope: '{"type":"all"}',
      client,
      clients: JSON.stringify(client ? [client] : []),
      expiresAt: null,
      source: 'console',
    });
  };

  return { db, keysRepo, requestsRepo, clients, overview, requestSvc, spec, log, makeKey, providers, catalog };
}

export type Harness = ReturnType<typeof makeHarness>;
