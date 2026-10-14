/**
 * `ModelsService.testCredential` 单测 —— 覆盖「试通一把尚未保存的凭证」。
 *
 * 覆盖重点（都是「写错了会静默坏掉」的地方）：
 *   ① testCredential 用**传入的** key 打上游，而不是当前生效的那把
 *   ② testCredential 的格式校验与 CredentialService 同源
 *   ③ ★ 不把凭证本身写进日志（只记结果）
 *   ④ ★ 「凭证无效」与「这个模型没订阅」必须区分开报（上游码 11102 ≠ 401）
 *   ⑤ 网络异常不抛 500，而是回一个可读的失败结论
 *
 * 测试策略：内存库 + 真实 schema（不造假 schema，避免测出假结论）；
 * `globalThis.fetch` 用 vi.stubGlobal 替身，避免真的打上游、真的烧积分。
 * 共享脚手架见 `models.service.harness.ts`；`setEnabled` 的用例在 `models.service.enabled.spec.ts`。
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsService } from './models.service';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError } from '../common/errors';
import { VALID_KEY, freshDb, makeConfig, makeService, upstreamResponse } from './models.service.harness';

let db: Database.Database;
let catalog: ModelCatalogRepository;
let config: RelayConfigService;
let service: ModelsService;

beforeEach(() => {
  ({ db, catalog } = freshDb());
  config = makeConfig();
  service = makeService(db, catalog, config);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('models · testCredential（试通一把尚未保存的凭证）', () => {
  it('① ★ 用传入的 key 打上游，而不是当前生效的那把', async () => {
    let seenAuth = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        seenAuth = init.headers.authorization ?? '';
        return upstreamResponse(200);
      }),
    );

    const out = await service.testCredential(VALID_KEY);

    expect(out.ok).toBe(true);
    // ★ httpStatus 透传：上游确实回了响应 → 填状态码（2xx 也要填）
    expect(out.httpStatus).toBe(200);
    // 关键：必须是待测的那把，不是 config 里的 ck_current_...
    expect(seenAuth).toBe(`Bearer ${VALID_KEY}`);
    expect(seenAuth).not.toContain('current_current');
  });

  it('② 格式非法的 key → 400，且不回显用户输入的任何片段', async () => {
    const bad = 'not-a-key-at-all';
    await expect(service.testCredential(bad)).rejects.toBeInstanceOf(RelayHttpError);

    try {
      await service.testCredential(bad);
    } catch (err) {
      const e = err as RelayHttpError;
      expect(e.httpStatus).toBe(400);
      // 错误消息不能包含用户输入 —— 避免"接近正确的密钥"进日志
      expect(e.message).not.toContain(bad);
    }
  });

  it('②b 空值 / 非字符串 → 400（挡明显手滑）', async () => {
    await expect(service.testCredential('')).rejects.toBeInstanceOf(RelayHttpError);
    await expect(service.testCredential('   ')).rejects.toBeInstanceOf(RelayHttpError);
    await expect(service.testCredential(undefined)).rejects.toBeInstanceOf(RelayHttpError);
    await expect(service.testCredential(12345)).rejects.toBeInstanceOf(RelayHttpError);
  });

  it('③ ★ 不把凭证本身写进日志（只记结果）', async () => {
    const logged: string[] = [];
    vi.spyOn(service['logger'], 'log').mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(200)));

    await service.testCredential(VALID_KEY);

    const all = logged.join('\n');
    expect(all).toContain('上游访问密钥试通');
    // 日志里绝不能出现凭证的任何片段
    expect(all).not.toContain(VALID_KEY);
    expect(all).not.toContain(VALID_KEY.slice(3, 20));
  });

  it('④ ★ 把「上游业务码」带回来（11102 = 当前账号无此模型，与凭证无效不同）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => upstreamResponse(403, JSON.stringify({ error: { code: 11102 } }))),
    );

    const out = await service.testCredential(VALID_KEY);

    expect(out.ok).toBe(false);
    expect(out.upstreamCode).toBe(11102);
    expect(out.httpStatus).toBe(403);
    expect(out.reason).toContain('11102');
  });

  it('④b 纯网络失败（非 HTTP 响应）→ 不抛 500，回可读原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );

    const out = await service.testCredential(VALID_KEY);

    expect(out.ok).toBe(false);
    expect(out.upstreamCode).toBeNull();
    expect(out.httpStatus).toBeNull();
    expect(out.reason).toContain('ENOTFOUND');
  });

  it('④c 超时 → 归入网络失败，不抛', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }),
    );

    const out = await service.testCredential(VALID_KEY);
    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBeNull();
    expect(out.reason).toContain('timeout');
  });

  it('④d ★ 上游 401（body 无可提取业务码）→ httpStatus 401、upstreamCode null、reason「HTTP 401」', async () => {
    // 这正是「密钥被拒」的最常见形态，也是 task#30 要修的误诊源头：
    // 上游确实回了响应（httpStatus=401），不能因为 upstreamCode 为 null 就当成网络问题。
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(401, 'Unauthorized')));

    const out = await service.testCredential(VALID_KEY);

    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBe(401);
    expect(out.upstreamCode).toBeNull();
    expect(out.reason).toBe('HTTP 401');
  });

  it('⑤ ★ 探测目标必须是 enabled 的模型（停用的不拿来当探针）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(200)));

    const out = await service.testCredential(VALID_KEY);

    // 注意：schema.sql 会播种内置目录，所以这里不能写死某个 id。
    // 要断言的是**规则**：选中的必须是 enabled=1 的模型。
    const rows = service.get().models;
    const picked = rows.find((r) => r.id === out.model);
    expect(picked).toBeDefined();
    expect(picked!.enabled).toBe(true);
    // 被我们显式停用的那个绝不能被选中
    expect(out.model).not.toBe('hunyuan-pro');
  });

  it('⑤b 目录里全部停用 → 仍能取到一个探针（不因为没有 enabled 项而拒绝服务）', async () => {
    for (const r of service.get().models) catalog.setEnabled('p_harness', r.id, false);
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(200)));

    const out = await service.testCredential(VALID_KEY);
    expect(out.model).toBeTruthy();
    expect(out.ok).toBe(true);
  });

  it('⑥ 返回耗时（用于让用户感知上游快慢）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(200)));
    const out = await service.testCredential(VALID_KEY);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out.elapsedMs)).toBe(true);
  });

  it('⑦ 请求体是最小请求（1 token、stream），不消耗多余积分', async () => {
    let seenBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        seenBody = init.body;
        return upstreamResponse(200);
      }),
    );

    await service.testCredential(VALID_KEY);
    const body = JSON.parse(seenBody) as { max_tokens: number; stream: boolean };
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(true);
  });

  it('⑧ baseUrl 末尾带斜杠时不产生双斜杠', async () => {
    let seenUrl = '';
    service = makeService(db, catalog, makeConfig('https://copilot.example.com/'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seenUrl = url;
        return upstreamResponse(200);
      }),
    );

    await service.testCredential(VALID_KEY);
    expect(seenUrl).toBe('https://copilot.example.com/v2/chat/completions');
    expect(seenUrl).not.toContain('//v2');
  });
});
