/**
 * `ModelsService.setEnabled` 单测（task#37 从 models.service.spec.ts 拆出，原文件 314 行超门禁）。
 *
 * 覆盖：停用只改标志不删行；可逆；不存在的 id → 404；非布尔 → 400；与 verified 正交。
 * 共享脚手架见 `models.service.harness.ts`。
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelsService } from './models.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { RelayHttpError } from '../common/errors';
import { freshDb, makeConfig, makeService } from './models.service.harness';

let db: Database.Database;
let catalog: ModelCatalogRepository;
let service: ModelsService;

beforeEach(() => {
  ({ db, catalog } = freshDb());
  service = makeService(db, catalog, makeConfig());
});

afterEach(() => db.close());

describe('models · setEnabled（勾选启用 / 停用）', () => {
  it('① 停用后 enabled=false，但**不删行**（订阅以后可能又开）', () => {
    const out = service.setEnabled('hunyuan-pro', true);
    expect(out).toEqual({ id: 'hunyuan-pro', enabled: true });

    const row = service.get().models.find((r) => r.id === 'hunyuan-pro');
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
  });

  it('② 再停用一次能切回去（幂等可逆）', () => {
    service.setEnabled('hunyuan-lite', false);
    expect(service.get().models.find((r) => r.id === 'hunyuan-lite')!.enabled).toBe(false);
    service.setEnabled('hunyuan-lite', true);
    expect(service.get().models.find((r) => r.id === 'hunyuan-lite')!.enabled).toBe(true);
  });

  it('③ 不存在的 id → 404（不是静默成功）', () => {
    try {
      service.setEnabled('no-such-model', true);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(RelayHttpError);
      expect((err as RelayHttpError).httpStatus).toBe(404);
    }
  });

  it('④ enabled 非布尔 → 400（挡掉 "true" 字符串这类手滑）', () => {
    for (const bad of ['true', 1, null, undefined]) {
      try {
        service.setEnabled('hunyuan-lite', bad);
        throw new Error(`应当拒绝 ${String(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(RelayHttpError);
        expect((err as RelayHttpError).httpStatus).toBe(400);
      }
    }
  });

  it('⑤ 停用不影响 verified 与 lastVerifiedAt（两个标志是正交的）', () => {
    catalog.setVerified('p_harness', 'hunyuan-lite', true);
    const before = service.get().models.find((r) => r.id === 'hunyuan-lite')!;
    service.setEnabled('hunyuan-lite', false);
    const after = service.get().models.find((r) => r.id === 'hunyuan-lite')!;
    expect(after.verified).toBe(before.verified);
    expect(after.lastVerifiedAt).toBe(before.lastVerifiedAt);
  });
});

describe('models · get() × provider 归属（v0.5.13）', () => {
  it('★ 每个目录行带 provider（显示名）—— 请求日志的「提供商」按模型解析的数据面', () => {
    const payload = service.get();
    expect(payload.models.length).toBeGreaterThan(0);
    expect(payload.models.every((m) => typeof m.provider === 'string' && m.provider.length > 0)).toBe(true);
    // harness 的提供商名是 TestUpstream
    expect(payload.models[0].provider).toBe('TestUpstream');
  });

  it('★ 指定 providerId 时 provider 跟随该分区', () => {
    const payload = service.get('p_harness');
    expect(payload.models.every((m) => m.provider === 'TestUpstream')).toBe(true);
  });
});
