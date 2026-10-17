/**
 * 额度来源单测（task#53）
 *
 * 覆盖验收四点：
 *   ① 轮询成功 → quota 有真实值（remain/total 来自上游原值）
 *   ② 上游失败 → **保留上次成功值**（不抹零）且记录错误
 *   ③ 改 `quota.pollSeconds` → 下个周期延迟立即变化（现读设置）
 *   ④ 拿不到 total → **不编造**（留 null）
 *
 * 另覆盖：无密钥不打网络、业务码非 0 判失败、字段认不出时把上游真实键名记进错误（可观测）。
 *
 * 说明：`QuotaSourceService` 只依赖 `RelayConfigService` 的 `get()` 与 `upstreamKey`，
 * 故用最小桩即可；请求用注入的 `fetchImpl`，**不发真网络、不需要真 key**。
 */

import { describe, expect, it } from 'vitest';
import { QuotaSourceService, computeDelayMs, NOT_PROVIDED_RECHECK_MS } from './quota-source.service';
import { hasAmount, parseQuotaPayload } from './quota-parse';
import { defaultSettings, type RelaySettings } from '../../config/settings.defaults';
import type { RelayConfigService } from '../../config/config.service';

interface Cfg {
  cfg: RelayConfigService;
  settings: RelaySettings;
  setKey(k: string): void;
}

function makeConfig(): Cfg {
  const settings = defaultSettings();
  let key = 'ck_test_fake';
  const cfg = {
    get: () => settings,
    get upstreamKey() {
      return key;
    },
    upstreamConfigured: () => key !== '',
  } as unknown as RelayConfigService;
  return { cfg, settings, setKey: (k) => (key = k) };
}

/** 造一个返回固定 JSON 的 fetch 桩。 */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const OK_BODY = { code: 0, msg: 'OK', data: { remainCredit: 4321, totalCredit: 5000, resetAt: '2026-11-01T00:00:00.000Z' } };

/** [v1.3.0] 真实上游形状（探针实测）：data.Response.Data.Accounts[] 资源包数组。 */
const REAL_BODY = {
  code: 0,
  msg: 'OK',
  data: {
    Response: {
      Data: {
        TotalCount: 3,
        TotalDosage: 1500,
        Accounts: [
          // 有效包：ExpiredTime 空 = 永久；Precise 字符串优先
          { PackageName: 'Buddy AI个人标准版', CapacityRemain: 140, CapacitySize: 200, CapacityRemainPrecise: '140.03', CapacitySizePrecise: '200', ExpiredTime: '', Status: 0 },
          // 有效包：未到期（北京时间 2099 年）
          { PackageName: '赠送包', CapacityRemain: 2000, CapacitySize: 2000, CapacityRemainPrecise: '2000', CapacitySizePrecise: '2000', ExpiredTime: '2099-01-01 00:00:00', Status: 0 },
          // 已过期包：不计入
          { PackageName: '拉新包', CapacityRemain: 1500, CapacitySize: 1500, ExpiredTime: '2026-10-05 17:26:19', Status: 3 },
        ],
      },
    },
  },
};

describe('parseQuotaPayload — 只认真实出现的字段', () => {
  it('标准信封 + 别名 + 数字字符串', () => {
    const p = parseQuotaPayload({ code: 0, data: { remainingCredit: '12.5', total: 100 } });
    expect(p?.remain).toBe(12.5);
    expect(p?.total).toBe(100);
  });

  it('[2026-10-17 口径修正] Accounts 聚合：remain 剔除过期包，total/used 含过期包（历史事实）', () => {
    const p = parseQuotaPayload(REAL_BODY, Date.UTC(2026, 9, 13));
    expect(p?.remain).toBeCloseTo(2140.03, 2); // 140.03 + 2000，过期包 1500 不计（余额不可用）
    expect(p?.total).toBe(3700); // 200 + 2000 + 过期包 1500 —— 发放是历史事实，含过期包
    expect(p?.used).toBeNull(); // 三包都无 Used 字段 → null（不推算）
    expect(p?.resetAt).toBeNull();
    expect(hasAmount(p!)).toBe(true);
  });

  it('[2026-10-17] Accounts 全部过期 → remain=0（余额确定归零，非未知），total 仍计（历史发放）', () => {
    const body = {
      code: 0,
      data: { Response: { Data: { Accounts: [{ CapacityRemain: 5, CapacitySize: 5, ExpiredTime: '2020-01-01 00:00:00' }] } } },
    };
    const p = parseQuotaPayload(body, Date.UTC(2026, 9, 13));
    expect(p?.remain).toBe(0); // 全过期：可用余额确定为零（null 留给「未知」，两者不等价）
    expect(p?.total).toBe(5); // 发放不随过期消失
    expect(hasAmount(p!)).toBe(true); // total 非 null → 有数（remain=0 是真值不是缺失）
  });

  it('业务码非 0 → null（上游侧失败）', () => {
    expect(parseQuotaPayload({ code: 11102, msg: 'x' })).toBeNull();
  });

  it('data 不是对象 → null', () => {
    expect(parseQuotaPayload({ code: 0, data: 42 })).toBeNull();
  });

  it('认不出任何数字 → hasAmount=false（不编造）', () => {
    const p = parseQuotaPayload({ code: 0, data: { foo: 1, bar: 'x' } });
    expect(p).not.toBeNull();
    expect(hasAmount(p!)).toBe(false);
    expect(p!.observedKeys).toEqual(['foo', 'bar']);
  });
});

describe('computeDelayMs — 指数退避', () => {
  it('成功用 pollSeconds；失败指数退避并以 backoffMaxSeconds 封顶', () => {
    expect(computeDelayMs(30, 300, 0)).toBe(30_000);
    expect(computeDelayMs(30, 300, 1)).toBe(60_000);
    expect(computeDelayMs(30, 300, 10)).toBe(300_000); // 封顶
  });
});

describe('QuotaSourceService', () => {
  it('① 轮询成功 → quota 有真实值（且请求形状正确）', async () => {
    const { cfg } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    let seen: { url: string; init: RequestInit } | null = null;
    const ok = await svc.fetchOnce((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(seen!.url).toBe('https://copilot.tencent.com/v2/billing/meter/get-user-resource');
    expect(seen!.init.method).toBe('POST'); // [v1.3.0] GET → 404；POST + 分页 body → 200（探针实证）
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer ck_test_fake');
    expect(h['user-agent']).toBe('WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1');
    const body = JSON.parse(String(seen!.init.body)) as Record<string, unknown>;
    expect(body.PageNumber).toBe(1);
    expect(body.ProductCode).toBe('p_tcaca');

    const b = svc.block();
    expect(b.available).toBe(true);
    expect(b.reason).toBe('ok');
    expect(b.remain).toBe(4321);
    expect(b.total).toBe(5000);
    expect(b.resetAt).toBe('2026-11-01T00:00:00.000Z');
    expect(b.stale).toBe(false);
  });

  it('② 上游失败 → 保留上次成功值（不抹零）且记录错误', async () => {
    const { cfg } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    await svc.fetchOnce(jsonFetch(OK_BODY)); // 先成功
    expect(svc.block().remain).toBe(4321);

    const ok = await svc.fetchOnce(jsonFetch({ message: 'boom' }, 500)); // 再失败
    expect(ok).toBe(false);
    const b = svc.block();
    expect(b.available).toBe(true); // 仍有数据
    expect(b.remain).toBe(4321); // ★ 未被抹成 null / 0
    expect(b.total).toBe(5000);
    expect(b.stale).toBe(true);
    expect(b.reason).toBe('stale');
    expect(b.message).toContain('失败');

    const snap = svc.snapshot();
    expect(snap.failures).toBe(1);
    expect(snap.lastError).toContain('HTTP 500');
    expect(snap.fetchedAt).not.toBeNull(); // 最近成功时间保留
  });

  it('③ 改 quota.pollSeconds → nextDelayMs 立即变化（现读设置）', () => {
    const { cfg, settings } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    settings.quota.pollSeconds = 30;
    expect(svc.nextDelayMs()).toBe(30_000);
    settings.quota.pollSeconds = 5;
    expect(svc.nextDelayMs()).toBe(5_000);
  });

  it('④ 拿不到 total → 留 null（不编造）', async () => {
    const { cfg } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    await svc.fetchOnce(jsonFetch({ code: 0, data: { remainCredit: 7 } }));
    const b = svc.block();
    expect(b.available).toBe(true);
    expect(b.remain).toBe(7);
    expect(b.total).toBeNull(); // ★ 不推算、不用 remain 冒充 total
  });

  it('未配置密钥 → 不打网络，块为 upstream_credential_missing', async () => {
    const { cfg, setKey } = makeConfig();
    setKey('');
    const svc = new QuotaSourceService(cfg);
    let called = false;
    await svc.fetchOnce((async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch);
    expect(called).toBe(false);
    expect(svc.block().reason).toBe('upstream_credential_missing');
  });

  it('字段认不出 → 判失败并把上游真实键名写进错误（可观测、不猜）', async () => {
    const { cfg } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    const ok = await svc.fetchOnce(jsonFetch({ code: 0, data: { foo: 1, bar: 2 } }));
    expect(ok).toBe(false);
    expect(svc.snapshot().hasData).toBe(false);
    expect(svc.snapshot().lastError).toContain('foo');
    expect(svc.block().reason).toBe('fetch_failed');
  });

  it('quota.warnBelow：剩余低于阈值 → low=true', async () => {
    const { cfg, settings } = makeConfig();
    settings.quota.warnBelow = 5000;
    const svc = new QuotaSourceService(cfg);
    await svc.fetchOnce(jsonFetch(OK_BODY)); // remain=4321 < 5000
    expect(svc.block().low).toBe(true);
    settings.quota.warnBelow = 0; // 0 = 不告警
    expect(svc.block().low).toBe(false);
  });

  it('quota.onFailure=clear：失败即清空（可选的另一种口径）', async () => {
    const { cfg, settings } = makeConfig();
    settings.quota.onFailure = 'clear';
    const svc = new QuotaSourceService(cfg);
    await svc.fetchOnce(jsonFetch(OK_BODY));
    await svc.fetchOnce(jsonFetch({}, 500));
    expect(svc.block().available).toBe(false);
    expect(svc.block().remain).toBeNull();
  });

  it('① 404（路由不存在）→ 不高频重试，退避到每天一次，状态标「上游未提供」', async () => {
    const { cfg, settings } = makeConfig();
    settings.quota.pollSeconds = 30;
    const svc = new QuotaSourceService(cfg);
    const ok = await svc.fetchOnce(jsonFetch('404 page not found', 404));
    expect(ok).toBe(false);
    expect(svc.snapshot().routeMissing).toBe(true);
    // ★ 不再按 pollSeconds（30s）白打一个必然 404 的路径，而是每天一次
    expect(svc.nextDelayMs()).toBe(NOT_PROVIDED_RECHECK_MS);
    expect(svc.nextDelayMs()).not.toBe(30_000);
    const b = svc.block();
    expect(b.available).toBe(false);
    expect(b.reason).toBe('upstream_not_provided');
    expect(b.message).toContain('上游订阅未提供');
    expect(b.remain).toBeNull();
    expect(b.total).toBeNull();
  });

  it('② 网络类失败 → 仍按退避重试（routeMissing 保持 false，不走每天）', async () => {
    const { cfg, settings } = makeConfig();
    settings.quota.pollSeconds = 30;
    settings.quota.backoffMaxSeconds = 300;
    const svc = new QuotaSourceService(cfg);
    let threw = false;
    await svc.fetchOnce((async () => {
      threw = true;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(threw).toBe(true);
    expect(svc.snapshot().routeMissing).toBe(false);
    // failures=1 → base*2 = 60s（未封顶）
    expect(svc.nextDelayMs()).toBe(60_000);
    expect(svc.block().reason).toBe('fetch_failed');
  });

  it('③ available=false 时 message 是可读的「上游未提供」，不含含糊/将来时措辞', async () => {
    const { cfg } = makeConfig();
    const svc = new QuotaSourceService(cfg);
    await svc.fetchOnce(jsonFetch('404 page not found', 404));
    const m = svc.block().message;
    expect(m).toContain('上游订阅未提供额度查询接口');
    expect(m).toContain('无法取得剩余积分');
    expect(m).toContain('已消耗积分');
    // 不含任何暗示「将来会可用」的措辞
    expect(/即将|稍后可用|待接入|敬请期待|即将可用/.test(m)).toBe(false);
  });
});
