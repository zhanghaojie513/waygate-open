import { describe, expect, it } from 'vitest';
import { ConsoleController } from './console.controller';
import type { AdminCredentialService } from './auth/admin-credential.service';

/**
 * 只测「重置管理口令」这一条端点的**契约形状与安全边界**。
 *
 * 不做整个 ConsoleController 的测试：那是验收脚本（tools/acceptance.mjs）
 * 走真实 HTTP 覆盖的范围。这里聚焦两件容易写错、且写错后果严重的事：
 *   1. 响应形状必须是 `{code,data,message}` 信封（契约 §0.1）
 *   2. 明文只出现在 `data.password` 这一处，且**不额外泄露**（比如别把 source 也带上）
 */

/** 造一个只实现 reset() 的服务替身；其余构造依赖给 null（本用例不会碰）。 */
function makeController(resetResult: { plain: string; persisted: boolean }) {
  const admin = {
    reset: () => resetResult,
  } as unknown as AdminCredentialService;
  return new ConsoleController(
    null as never, // overview
    null as never, // clients
    null as never, // requests
    null as never, // keys
    null as never, // settings
    null as never, // credential
    null as never, // models
    admin,
    null as never, // proxy
  );
}

describe('POST /api/auth/password/reset · 契约形状', () => {
  it('① 返回统一信封：code=0 / data.password / data.persisted / message', () => {
    const ctrl = makeController({ plain: 'AbcDefG2mNpQrSt3u', persisted: true });
    const res = ctrl.resetAdminPassword() as Record<string, unknown>;

    expect(res.code).toBe(0);
    expect(res.message).toBe('');
    const data = res.data as Record<string, unknown>;
    expect(data.password).toBe('AbcDefG2mNpQrSt3u');
    expect(data.persisted).toBe(true);
  });

  it('② data 里除了 password / persisted 不带别的字段（最小信息面）', () => {
    const ctrl = makeController({ plain: 'AbcDefG2mNpQrSt3u', persisted: false });
    const res = ctrl.resetAdminPassword() as Record<string, unknown>;
    expect(Object.keys(res.data as object).sort()).toEqual(['password', 'persisted']);
  });

  it('③ persisted=false 时形状不变（降级不是错误，仍 code=0）', () => {
    const ctrl = makeController({ plain: 'AbcDefG2mNpQrSt3u', persisted: false });
    const res = ctrl.resetAdminPassword() as Record<string, unknown>;
    expect(res.code).toBe(0);
    expect((res.data as Record<string, unknown>).persisted).toBe(false);
  });

  it('④ 顶层就是信封本身，没有多包一层（契约 §0.1 的硬要求）', () => {
    const ctrl = makeController({ plain: 'AbcDefG2mNpQrSt3u', persisted: true });
    const res = ctrl.resetAdminPassword() as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(['code', 'data', 'message']);
  });
});

/**
 * 本轮新增的两条端点，同样只测契约形状。
 *
 * 重点：`testCredential` 的响应**绝不能**把请求里那把凭证回显出来 ——
 * 它是用户填了还没保存的 key，回显等于给它开了一条明文泄漏通道。
 */
function makeControllerWithModels(models: unknown) {
  return new ConsoleController(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    models as never,
    null as never,
    null as never, // proxy
  );
}

describe('POST /api/settings/credential/test · 契约形状', () => {
  it('① 返回信封，data 只含 ok/model/elapsedMs/upstreamCode/httpStatus/reason', async () => {
    const service = {
      testCredential: async () => ({ ok: true, model: 'hunyuan-lite', elapsedMs: 320, upstreamCode: null, httpStatus: 200, reason: null }),
      setEnabled: () => ({ id: 'x', enabled: true }),
    };
    const ctrl = makeControllerWithModels(service);
    const res = (await ctrl.testCredential({ key: 'ck_something_long_enough' })) as Record<string, unknown>;

    expect(res.code).toBe(0);
    expect(Object.keys(res).sort()).toEqual(['code', 'data', 'message']);
    expect(Object.keys(res.data as object).sort()).toEqual(['elapsedMs', 'httpStatus', 'model', 'ok', 'reason', 'upstreamCode']);
  });

  it('② ★ 响应里绝不出现提交的凭证（哪怕上游拒绝它）', async () => {
    const secret = 'ck_thisIsTheSubmittedKeyNeverEchoMe12345';
    const service = {
      testCredential: async () => ({ ok: false, model: 'x', elapsedMs: 1, upstreamCode: 401, httpStatus: 401, reason: '上游拒绝' }),
      setEnabled: () => ({ id: 'x', enabled: true }),
    };
    const ctrl = makeControllerWithModels(service);
    const res = (await ctrl.testCredential({ key: secret })) as Record<string, unknown>;

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('thisIsTheSubmittedKey');
  });

  it('③ 控制器只做透传：key 为 undefined 也照常走形状（校验在 service 层）', async () => {
    const passthrough = {
      testCredential: async () => ({ ok: false, model: 'm', elapsedMs: 0, upstreamCode: null, httpStatus: null, reason: 'x' }),
      setEnabled: () => ({ id: 'x', enabled: true }),
    };
    const ctrl = makeControllerWithModels(passthrough);
    const res = (await ctrl.testCredential(undefined)) as Record<string, unknown>;
    expect(res.code).toBe(0);
  });
});

describe('PATCH /api/models/catalog/:id · 契约形状', () => {
  it('① 返回 {id, enabled} 的信封', () => {
    const service = {
      testCredential: async () => ({ ok: true, model: 'm', elapsedMs: 0, upstreamCode: null, httpStatus: 200, reason: null }),
      setEnabled: (id: string, enabled: boolean) => ({ id, enabled }),
    };
    const ctrl = makeControllerWithModels(service);
    const res = ctrl.setModelEnabled('hunyuan-lite', { enabled: false }) as Record<string, unknown>;

    expect(res.code).toBe(0);
    expect(res.data).toEqual({ id: 'hunyuan-lite', enabled: false });
  });

  it('② 只改 enabled 标志，不回带整条模型记录（最小信息面）', () => {
    const service = {
      testCredential: async () => ({ ok: true, model: 'm', elapsedMs: 0, upstreamCode: null, httpStatus: 200, reason: null }),
      setEnabled: (id: string, enabled: boolean) => ({ id, enabled }),
    };
    const ctrl = makeControllerWithModels(service);
    const res = ctrl.setModelEnabled('hunyuan-lite', { enabled: true }) as Record<string, unknown>;
    expect(Object.keys(res.data as object).sort()).toEqual(['enabled', 'id']);
  });
});

/**
 * GET /api/overview 暴露并发占用/上限（task#37）：
 * 让「槽位泄漏 → active 单调上涨 → 永久 429」这个从外面看不见的失败状态可观测。
 */
describe('GET /api/overview · 暴露并发占用/上限', () => {
  function makeOverviewController(stats: { active: number; limit: number }) {
    const overview = { build: () => ({ window: '24h', metrics: { requests: 0 } }) };
    const proxy = { stats: () => stats };
    return new ConsoleController(
      overview as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      proxy as never,
    );
  }

  it('① data 带 concurrency{active,limit}，值来自 ProxyService.stats()', () => {
    const ctrl = makeOverviewController({ active: 3, limit: 8 });
    const res = ctrl.getOverview({ window: '24h' }) as Record<string, unknown>;

    expect(res.code).toBe(0);
    const data = res.data as Record<string, unknown>;
    expect(data.concurrency).toEqual({ active: 3, limit: 8 });
    expect(data.window).toBe('24h'); // 原有概览字段仍保留（是新增而非替换）
  });

  it('② 值是透传的，不是 controller 里硬编码的常量', () => {
    const ctrl = makeOverviewController({ active: 0, limit: 32 });
    const res = ctrl.getOverview({}) as Record<string, unknown>;
    expect((res.data as Record<string, unknown>).concurrency).toEqual({ active: 0, limit: 32 });
  });
});

/**
 * `PUT /api/auth/password` —— 用户自定义管理口令（契约 §3.1.4）。
 *
 * 控制器只做三件事：从 body 取 password → 交给 service → 包信封。
 * 这里只测**契约形状与最小信息面**，校验逻辑的覆盖在 service 的 spec 里。
 */
function makeControllerWithAdmin(admin: unknown) {
  return new ConsoleController(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    admin as never,
    null as never, // proxy
  );
}

describe('PUT /api/auth/password · 契约形状', () => {
  it('① 返回统一信封，data 只含 persisted', () => {
    const admin = { setPassword: () => ({ persisted: true }) };
    const ctrl = makeControllerWithAdmin(admin);
    const res = ctrl.setAdminPassword({ password: 'test-admin-pw-1' }) as Record<string, unknown>;

    expect(res.code).toBe(0);
    expect(res.message).toBe('');
    expect(Object.keys(res).sort()).toEqual(['code', 'data', 'message']);
    expect(Object.keys(res.data as object)).toEqual(['persisted']);
  });

  it('② ★ 响应里绝不回显提交的口令明文', () => {
    const secret = 'test-admin-pw-1';
    const admin = { setPassword: () => ({ persisted: true }) };
    const ctrl = makeControllerWithAdmin(admin);
    const res = ctrl.setAdminPassword({ password: secret }) as Record<string, unknown>;

    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('③ controller 把 password 原值透传给 service（校验在 service 层）', () => {
    let seen: unknown = Symbol('unset');
    const admin = {
      setPassword: (raw: unknown) => {
        seen = raw;
        return { persisted: true };
      },
    };
    const ctrl = makeControllerWithAdmin(admin);
    ctrl.setAdminPassword({ password: 'whatever-1234' });
    expect(seen).toBe('whatever-1234');
  });

  it('④ body 缺 password 时把 undefined 透传（交由 service 抛 400）', () => {
    let seen: unknown = Symbol('unset');
    const admin = {
      setPassword: (raw: unknown) => {
        seen = raw;
        return { persisted: false };
      },
    };
    const ctrl = makeControllerWithAdmin(admin);
    ctrl.setAdminPassword({});
    expect(seen).toBeUndefined();
  });
});
