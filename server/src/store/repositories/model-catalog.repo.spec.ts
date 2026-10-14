import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelCatalogRepository, deriveFamily } from './model-catalog.repo';

/**
 * 模型映射是本项目唯一一处**无法纯推导**的逻辑：
 *   15/17 个模型的 API ID = 显示名小写；
 *   但有两个反例：`Hy4 preview` -> `hy4-preview`（空格转连字符）、
 *                `Kimi-K2.7-Code` -> `kimi-k2.7`（显示名多了 -Code）。
 * 所以必须有映射层，且必须有测试守住这两个反例。
 */

const SEED_PATH = join(__dirname, '..', '..', 'catalog', 'model-catalog.json');

interface CatalogFile {
  models: Array<{ id: string; displayName: string; family?: string; tag?: string | null; multiplier: number }>;
}

let db: Database.Database;
let repo: ModelCatalogRepository;
let catalog: CatalogFile;
/** [v0.5.1] 统一的测试提供商 id。 */
const PID = 'p_spec';

beforeEach(() => {
  // 内存库 + 真实 schema，避免用假 schema 测出假结论
  db = new Database(':memory:');
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  repo = new ModelCatalogRepository(db);
  /* [v0.5.1] 目录按提供商分区：spec 统一用 p_spec 这一行。 */
  db.prepare(
    "INSERT INTO providers (id, name, base_url, active, protocol, cred_kind, created_at, updated_at) VALUES ('p_spec', 'Spec', 'https://up.example.com', 1, 'openai', 'static', 0, 0)",
  ).run();
  catalog = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as CatalogFile;
  repo.seed(PID,
    catalog.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      tag: m.tag ?? null,
      multiplier: m.multiplier,
    })),
  );
});

afterEach(() => db.close());

describe('deriveFamily', () => {
  it('取 id 第一个 - 之前的段；无 - 时返回自身', () => {
    expect(deriveFamily('kimi-k2.7')).toBe('kimi');
    expect(deriveFamily('hy4-preview')).toBe('hy4');
    expect(deriveFamily('deepseek-v3')).toBe('deepseek');
    expect(deriveFamily('glm-5.3')).toBe('glm');
    expect(deriveFamily('standalone')).toBe('standalone');
  });

  it('以 - 开头时不返回空串（否则 scope 仅某系会误匹配全部）', () => {
    expect(deriveFamily('-weird')).toBe('-weird');
  });
});

describe('模型种子', () => {
  it('① 17 个模型全部入库，与 model-catalog.json 数量一致', () => {
    const rows = repo.all(PID);
    expect(rows).toHaveLength(catalog.models.length);
    expect(rows.length).toBe(17);
  });

  it('② 重复 seed 幂等，不新增也不覆盖', () => {
    const before = repo.all(PID).length;
    repo.seed(PID,
      catalog.models.map((m) => ({
        id: m.id,
        displayName: '我改过的名字',
        tag: null,
        multiplier: 99,
      })),
    );
    const after = repo.all(PID);
    expect(after).toHaveLength(before);
    // 显示名与倍率不被 seed 覆盖
    const first = repo.findById(PID, catalog.models[0].id);
    expect(first?.display_name).toBe(catalog.models[0].displayName);
    expect(first?.multiplier).toBe(catalog.models[0].multiplier);
  });

  it('③ 种子模型 family 正确派生，且 verified=1 / enabled=1', () => {
    const kimi = repo.findById(PID, 'kimi-k2.7');
    expect(kimi?.family).toBe('kimi');
    expect(kimi?.verified).toBe(1);
    expect(kimi?.enabled).toBe(1);
  });
});

describe('resolve —— 三级查找', () => {
  it('④ L1 精确 id（大小写不敏感）', () => {
    expect(repo.resolveAcross('kimi-k3', [PID])[0]?.row.id).toBe('kimi-k3');
    expect(repo.resolveAcross('KIMI-K3', [PID])[0]?.row.id).toBe('kimi-k3');
    expect(repo.resolveAcross('  kimi-k3  ', [PID])[0]?.row.id).toBe('kimi-k3');
    expect(repo.resolveAcross('glm-5.3-flashx', [PID])[0]?.row.id).toBe('glm-5.3-flashx');
  });

  it('⑤ L2 显示名精确匹配（大小写不敏感）', () => {
    const m = catalog.models[0];
    expect(repo.resolveAcross(m.displayName, [PID])[0]?.row.id).toBe(m.id);
    expect(repo.resolveAcross(m.displayName.toUpperCase(), [PID])[0]?.row.id).toBe(m.id);
  });

  it('⑥ ★ 反例一：Hy4 preview -> hy4-preview（空格转连字符）', () => {
    const row = repo.resolveAcross('Hy4 preview', [PID])[0]?.row;
    expect(row?.id).toBe('hy4-preview');
    // 规范化查找也必须命中
    expect(repo.resolveAcross('HY4 PREVIEW', [PID])[0]?.row.id).toBe('hy4-preview');
  });

  it('⑦ ★ 反例二：Kimi-K2.7-Code 的 API ID 是 kimi-k2.7，显示名多了 -Code', () => {
    const row = repo.resolveAcross('Kimi-K2.7-Code', [PID])[0]?.row;
    expect(row?.id).toBe('kimi-k2.7');
    // 反向：客户端直接用 API ID 也必须命中（L1）
    expect(repo.resolveAcross('kimi-k2.7', [PID])[0]?.row.id).toBe('kimi-k2.7');
  });

  it('⑧ 所有 17 个模型的显示名与 id 都能各自解析回自己（防映射表漏项）', () => {
    const failures: string[] = [];
    for (const m of catalog.models) {
      const byId = repo.resolveAcross(m.id, [PID])[0]?.row;
      const byDisplay = repo.resolveAcross(m.displayName, [PID])[0]?.row;
      if (byId?.id !== m.id) failures.push(`id 查不到: ${m.id}`);
      if (byDisplay?.id !== m.id) failures.push(`显示名查不到: ${m.displayName} -> 期望 ${m.id}`);
    }
    expect(failures).toEqual([]);
  });

  it('⑨ 未命中返回 undefined（调用方据此返回 400，不转发）', () => {
    expect(repo.resolveAcross('gpt-5-ultra', [PID])[0]).toBeUndefined();
    expect(repo.resolveAcross('', [PID])).toEqual([]);
  });
});

describe('verified / enabled 两个独立维度', () => {
  it('⑩ ★ 11102 时 setVerified(false) 只改标记，**绝不删除**该行', () => {
    const before = repo.all(PID).length;
    repo.setVerified(PID, 'kimi-k3', false);

    const after = repo.all(PID);
    expect(after).toHaveLength(before); // 行数不变 —— 订阅后可能再开
    const row = repo.findById(PID, 'kimi-k3');
    expect(row?.verified).toBe(0);
    expect(row?.last_verified_at).not.toBeNull();
    expect(row?.enabled).toBe(1); // enabled 不受影响，是两个独立维度
  });

  it('⑪ setEnabled(false) 下架模型不影响 verified', () => {
    repo.setEnabled(PID, 'glm-5.3', false);
    const row = repo.findById(PID, 'glm-5.3');
    expect(row?.enabled).toBe(0);
    expect(row?.verified).toBe(1);
    expect(repo.all(PID)).toHaveLength(17);
  });
});

describe('上游覆盖（markFromUpstream 语义并入 mergeSync）', () => {
  it('⑫ 上游拉取到的模型 source 变 upstream，显示名以官方为准', () => {
    repo.mergeSync(PID, [{ id: 'kimi-k3', displayName: 'Kimi-K3 官方名', source: 'upstream', multiplier: null, tag: null }]);
    const row = repo.findById(PID, 'kimi-k3');
    expect(row?.source).toBe('upstream');
    expect(row?.display_name).toBe('Kimi-K3 官方名');
  });
});
