/**
 * `ModelsService` 单测的共享脚手架（task#37：把 314 行的 spec 按子功能拆开时抽出）。
 *
 * 不是 spec 文件（不会被 vitest 当用例收集），只提供：内存库 + 真实 schema、
 * config 替身、完整依赖链的 `ModelsService`、上游响应替身。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelsService } from './models.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { ProvidersRepository } from '../store/repositories/providers.repo';
import { ModelProbeService } from '../catalog/probe';
import { CatalogSyncService } from '../catalog/catalog-sync';
import type { RelayConfigService } from '../config/config.service';

export const SCHEMA_PATH = join(__dirname, '..', 'store', 'schema.sql');

export const VALID_KEY = 'ck_g03prg6t8hkw.kMrC7p8Nev1TO1ECe7d9Hh32XQTa271uKCsTdtkaiAg';

/** 造一个 config 替身：只实现 ModelsService / probe / sync 真正用到的成员。 */
export function makeConfig(
  baseUrl = 'https://copilot.example.com',
  key = 'ck_current_current_current_key',
): RelayConfigService {
  return {
    get: () => ({ upstream: { baseUrl } }),
    upstreamKey: key,
    upstreamConfigured: () => key.length > 0,
  } as unknown as RelayConfigService;
}

/** 用配置造出完整依赖链的 ModelsService。 */
export function makeService(
  db: Database.Database,
  catalog: ModelCatalogRepository,
  cfg: RelayConfigService,
): ModelsService {
  const probe = new ModelProbeService(cfg);
  const prefs = new ProviderModelPrefsRepository(db);
  const providers = new ProvidersRepository(db);
  if (!providers.findById('p_harness')) {
    providers.create({ id: 'p_harness', name: 'TestUpstream', baseUrl: 'https://upstream.test', active: true });
  }
  const sync = new CatalogSyncService(cfg, catalog, probe, prefs);
  return new ModelsService(cfg, catalog, probe, sync, providers);
}

/** 建内存库 + 目录：一个 enabled（hunyuan-lite）、一个停用（hunyuan-pro）。 */
export function freshDb(): { db: Database.Database; catalog: ModelCatalogRepository } {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const catalog = new ModelCatalogRepository(db);
  catalog.seed('p_harness', [
    { id: 'hunyuan-lite', displayName: '混元 Lite', tag: null, multiplier: 1 },
    { id: 'hunyuan-pro', displayName: '混元 Pro', tag: '旗舰', multiplier: 3 },
  ]);
  catalog.setEnabled('p_harness', 'hunyuan-pro', false);
  return { db, catalog };
}

/** 造一个上游响应替身。 */
export function upstreamResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}
