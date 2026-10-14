/**
 * /api/requests 游标（keyset）分页：与 OFFSET 结果一致、翻页期间新写入不产生重复、非法游标 400。
 */
import { describe, expect, it } from 'vitest';
import { makeHarness } from './client-harness';
import { RelayHttpError } from '../common/errors';

describe('RequestQueryService.list 游标分页', () => {
  it('按游标逐页翻完 = OFFSET 全量顺序（同毫秒多行也按 id 稳定续接）', () => {
    const h = makeHarness();
    // 45 行在同一毫秒内大量重复 ts：专测 (ts, id) 的并列续接
    for (let i = 0; i < 45; i += 1) h.log({ clientId: 'k_a', client: 'A', clientRule: 0 });

    const all = h.requestSvc.list({ page: 1, limit: 200 }).items.map((r) => r.id);
    expect(all).toHaveLength(45);

    const seen: number[] = [];
    let cursor: string | undefined;
    let page = 1;
    for (;;) {
      const res = h.requestSvc.list({ page, limit: 20, cursor });
      seen.push(...res.items.map((r) => r.id));
      expect(res.total).toBe(45);
      if (!res.hasMore) {
        expect(res.nextCursor).toBeNull();
        break;
      }
      expect(res.nextCursor).not.toBeNull();
      cursor = res.nextCursor ?? undefined;
      page += 1;
    }
    expect(page).toBe(3);
    expect(seen).toEqual(all);
  });

  it('翻页期间有新请求写入：下一页不会重复上一页的行', () => {
    const h = makeHarness();
    for (let i = 0; i < 30; i += 1) h.log({ clientId: 'k_a', client: 'A', clientRule: 0 });

    const p1 = h.requestSvc.list({ page: 1, limit: 20 });
    // 新写入 5 行（会排到最前面）；OFFSET 分页此时第 2 页会重复 5 行
    for (let i = 0; i < 5; i += 1) h.log({ clientId: 'k_a', client: 'A', clientRule: 0 });
    const p2 = h.requestSvc.list({ page: 2, limit: 20, cursor: p1.nextCursor ?? undefined });

    const p1Ids = new Set(p1.items.map((r) => r.id));
    expect(p2.items.some((r) => p1Ids.has(r.id))).toBe(false);
    expect(p2.items).toHaveLength(10);
    expect(p2.hasMore).toBe(false);
  });

  it('非时间排序不出游标；格式错误的游标返回 400', () => {
    const h = makeHarness();
    for (let i = 0; i < 25; i += 1) h.log({ clientId: 'k_a', client: 'A', clientRule: 0 });

    const byMs = h.requestSvc.list({ page: 1, limit: 20, sort: 'ms' });
    expect(byMs.hasMore).toBe(true);
    expect(byMs.nextCursor).toBeNull();

    expect(() => h.requestSvc.list({ page: 2, limit: 20, cursor: 'abc' })).toThrow(RelayHttpError);
  });
});
