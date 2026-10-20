/**
 * MiniMax 积分账本服务（v0.5.7）测试：真实口径的解析与「拿不到就说拿不到」的纪律。
 *
 * 守三件事：
 *   ① 多笔发放**求和**（remaining/consumed/granted）；
 *   ② 字段缺失/格式怪 → 跳过该笔，**不编造**（宁可少算）；
 *   ③ 拉取失败保留旧值并置 stale，绝不抹零。
 */
import 'reflect-metadata';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimaxCreditService } from './minimax-credit.service';
import { ProvidersRepository } from '../../store/repositories/providers.repo';
import { MinimaxTokenService } from './minimax-token.service';
import { runMigrations } from '../../store/migrate';

const PID = 'p_credit';
let db: Database.Database;
let providers: ProvidersRepository;
let svc: MinimaxCreditService;

const DETAILS = {
  base_resp: { status_code: 0, status_msg: 'ok' },
  total_count: 2,
  details: [
    { credit_type: 2, granted_amount: '400.00', remaining_amount: '400.00', consumed_amount: '0.00', granted_at_ms: 1, expire_at_ms: Date.now() + 86400000 },
    { credit_type: 2, granted_amount: '400.00', remaining_amount: '341.06', consumed_amount: '58.94', granted_at_ms: 2, expire_at_ms: Date.now() + 2 * 86400000 },
  ],
};

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  db = new Database(':memory:');
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  providers = new ProvidersRepository(db);
  providers.create({
    id: PID,
    name: 'MiniMax Code',
    baseUrl: 'https://agent.minimax.cn',
    active: true,
    protocol: 'anthropic',
    credKind: 'oauth_minimax',
  });
  const tokens = { accessToken: async () => 'mmoat_test' } as unknown as MinimaxTokenService;
  svc = new MinimaxCreditService(providers, tokens, false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  vi.restoreAllMocks();
});

const row = () => providers.findById(PID)!;

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe('MinimaxCreditService · 账本解析', () => {
  it('★ 多笔发放求和：granted/remaining/consumed 各自累加（精确到 0.01）', async () => {
    stub(DETAILS);
    const snap = await svc.refreshOne(row());
    expect(snap.granted).toBe(800);
    expect(snap.remaining).toBe(741.06);
    expect(snap.consumed).toBe(58.94);
    expect(snap.grants).toHaveLength(2);
    expect(snap.nextExpireAt).toBeGreaterThan(Date.now()); // 最近一笔未过期
  });

  it('★ 金额字段缺失的笔跳过，不编造（宁可少算）', async () => {
    stub({
      base_resp: { status_code: 0 },
      details: [
        { credit_type: 2, granted_amount: '400.00', remaining_amount: '400.00', consumed_amount: '0.00', expire_at_ms: Date.now() + 1000 },
        { credit_type: 2, granted_amount: null, remaining_amount: '100.00', consumed_amount: '0.00' }, // 缺 granted → 跳过
        { credit_type: 2, granted_amount: '50.00', remaining_amount: 'x', consumed_amount: '0' }, // 非数字 → 跳过
      ],
    });
    const snap = await svc.refreshOne(row());
    expect(snap.grants).toHaveLength(1);
    expect(snap.granted).toBe(400);
  });

  it('业务码非 0 → 抛错（调用方记失败，不落假数据）', async () => {
    stub({ base_resp: { status_code: 12345, status_msg: 'boom' } });
    await expect(svc.refreshOne(row())).rejects.toThrow('boom');
  });

  it('缺 details 数组 → 抛错', async () => {
    stub({ base_resp: { status_code: 0 } });
    await expect(svc.refreshOne(row())).rejects.toThrow(/details/);
  });

  it('HTTP 非 2xx → 抛错', async () => {
    stub({}, 500);
    await expect(svc.refreshOne(row())).rejects.toThrow(/HTTP 500/);
  });
});

describe('MinimaxCreditService · 失败保留旧值', () => {
  it('★ 成功后再失败：保留上次的值并置 stale，绝不抹零', async () => {
    stub(DETAILS);
    await svc.refreshOne(row());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await svc.refreshAll(); // 走失败路径

    const block = svc.block(row());
    expect(block.available).toBe(true);
    expect(block.remaining).toBe(741.06); // 旧值还在
    expect(block.stale).toBe(true);
    expect(block.message).toContain('network down');
  });

  it('从未成功过 → available=false，字段全 null（不假装有数）', () => {
    const block = svc.block(row());
    expect(block.available).toBe(false);
    expect(block.remaining).toBeNull();
    expect(block.consumed).toBeNull();
    expect(block.nextExpireAt).toBeNull();
  });
});

/** 造 n 笔发放；第 i 笔发放 100、已消耗 i（顶层共用 —— 两个分页 describe 都要用）。 */
function makeGrants(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    credit_type: 2,
    granted_amount: '100.00',
    remaining_amount: (100 - i).toFixed(2),
    consumed_amount: String(i),
    granted_at_ms: i + 1,
    expire_at_ms: Date.now() + 86400000,
  }));
}

describe('MinimaxCreditService · 分页（v1.6.29 漏算修复）', () => {
  /**
   * 忠实模拟上游：**默认/小 page_size 时只回 20 条**（这正是原 bug 的触发条件）。
   * 断言点必须落在这条真实行为上 —— 若 fixture 无脑全返回，测试永远绿而过。
   */
  function stubPaged(all: unknown[], defaultPageSize = 20): void {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      const m = /page=(\d+)&page_size=(\d+)/.exec(url);
      if (!m) {
        /* 没带分页参数 → 上游默认行为：只给 20 条 */
        const page = all.slice(0, defaultPageSize);
        return new Response(JSON.stringify({
          base_resp: { status_code: 0 }, total_count: all.length, details: page,
        }));
      }
      const page = Number(m[1]);
      const size = Number(m[2]);
      const slice = all.slice((page - 1) * size, page * size);
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 }, total_count: all.length, details: slice,
      }));
    }));
  }

  it('★ 21 笔发放（>上游默认 20）必须全部统计 —— 修复前会少算最后 1 笔', async () => {
    const all = makeGrants(21);
    all[20] = {
      credit_type: 2, granted_amount: '400.00', remaining_amount: '0.00',
      consumed_amount: '400.00', granted_at_ms: 21, expire_at_ms: Date.now() + 86400000,
    };
    stubPaged(all);

    const snap = await svc.refreshOne(row());
    expect(snap.grants).toHaveLength(21);
    expect(snap.granted).toBe(20 * 100 + 400); // 2400
    expect(snap.consumed).toBe(
      all.reduce((s, d) => s + Number(d.consumed_amount), 0), // 190 + 400 = 590
    );
    expect(snap.consumed).toBe(590);
  });

  it('★ 笔数超过页大小（250 笔）时连续翻页，不静默截断', async () => {
    stubPaged(makeGrants(250));
    const snap = await svc.refreshOne(row());
    expect(snap.grants).toHaveLength(250);
  });

  it('★ 取到的条数少于 total_count → 抛错（宁可 stale，也不给偏小的数）', async () => {
    /* 模拟上游只给 20 条、且忽略我们的 page_size（真实上游的退化形态） */
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        total_count: 50,
        details: makeGrants(20),
      })),
    ));
    await expect(svc.refreshOne(row())).rejects.toThrow(/分页不完整/);
  });

  it('请求里带上了分页参数（否则上游只回 20 条）', async () => {
    stubPaged(makeGrants(3));
    await svc.refreshOne(row());
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0][0])).toMatch(/page=1&page_size=100/);
  });
});

describe('MinimaxCreditService · page 参数无效的防翻倍（v1.6.31）', () => {
  /**
   * 上游真实行为（22 笔账户实测 2026-10-20）：`page` 被完全忽略 ——
   * page=1/2/3 × page_size=10 三次返回**逐字节相同**的页；`page_size` 生效。
   *
   * 危险场景：账户笔数超过 page_size 的上游上限时，第 2 页返回与第 1 页相同的
   * 内容。不识别这一点，all 会装两份同样的记录、条数校验"通过"、求和翻倍。
   */

  it('★ 上游原地踏步（每页都返回相同的前 100 条，total=150）→ 抛错，不求和翻倍', async () => {
    const first100 = makeGrants(100); // 与第 2 页逐字节相同
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        total_count: 150,
        details: first100, // 无论 page 是几，都回同一份前 100 条
      }));
    }));
    /* 修复前：all=200 ≥ 150 通过校验，Σgranted = 1000×2 = 翻倍。
       修复后：第 2 页签名与第 1 页相同 → 停 → 100 < 150 → 如实抛错。 */
    await expect(svc.refreshOne(row())).rejects.toThrow(/分页不完整/);
    expect(calls).toBe(2); // 确认真的翻了页才发现踏步（第 1 页拿满 100 不会提前停）
  });

  it('★ 翻页真实生效的假想上游（150 笔 = 100 + 50 两页）→ 两页收齐，求和正确', async () => {
    const all = makeGrants(150);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const m = /page=(\d+)&page_size=(\d+)/.exec(String(input))!;
      const p = Number(m[1]), s = Number(m[2]);
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        total_count: 150,
        details: all.slice((p - 1) * s, p * s), // page 参数被尊重
      }));
    }));
    const snap = await svc.refreshOne(row());
    expect(snap.granted).toBe(150 * 100); // 150 笔 × 每笔 100，无重复
  });
});

describe('MinimaxCreditService · 范围', () => {
  it('只统计 oauth_minimax 提供商（WorkBuddy 不在此列）', async () => {
    providers.create({ id: 'p_wb', name: 'WorkBuddy', baseUrl: 'https://copilot.tencent.com', active: true });
    stub(DETAILS);
    await svc.refreshAll();
    const blocks = svc.allBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].providerId).toBe(PID);
  });
});
