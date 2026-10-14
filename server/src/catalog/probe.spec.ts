/**
 * `ModelProbeService.probe` 的 `httpStatus` 三态单测（task#30 的 AC）。
 *
 * 背景：`ProbeOutcome.upstreamCode === null` 在生产里有**两个来源** —— 真网络失败，
 * 与「上游确实回了非 2xx 但 body 里没有可提取业务码」。没有 `httpStatus` 前端无法区分，
 * 会把「上游 401 拒签」渲染成「网络连不上，去查出网」（误诊）。
 *
 * 因此本文件逐条钉死三态：
 *   ① 网络异常 / 超时 → `httpStatus === null`（**唯一**为 null 的路径）
 *   ② 上游 200       → `httpStatus === 200` 且 `ok === true`
 *   ③ 上游 401       → `httpStatus === 401`、`upstreamCode === null`、`reason === 'HTTP 401'`
 * 另附：上游 4xx 带业务码时 `httpStatus` 与 `upstreamCode` 同时有值（两者不互斥）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProbeService } from './probe';
import type { RelayConfigService } from '../config/config.service';

function makeProbe(baseUrl = 'https://copilot.example.com'): ModelProbeService {
  const config = {
    get: () => ({ upstream: { baseUrl } }),
    upstreamKey: 'ck_probe_key',
  } as unknown as RelayConfigService;
  return new ModelProbeService(config);
}

/** 上游响应替身：只需 probe 用到的 ok / status / text / body.cancel。 */
function resp(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelProbeService.probe · httpStatus 三态（task#30 AC）', () => {
  it('① fetch 抛异常 → httpStatus === null（唯一为 null 的路径：根本没拿到响应）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );

    const out = await makeProbe().probe('kimi-k3');

    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBeNull();
    expect(out.upstreamCode).toBeNull();
    expect(out.reason).toContain('ENOTFOUND');
  });

  it('①b 超时（AbortError/TimeoutError）→ httpStatus === null，归入「没拿到响应」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }),
    );

    const out = await makeProbe().probe('kimi-k3');

    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBeNull();
    expect(out.reason).toContain('timeout');
  });

  it('② 上游 200 → httpStatus === 200 且 ok === true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200)));

    const out = await makeProbe().probe('kimi-k3');

    expect(out.ok).toBe(true);
    expect(out.httpStatus).toBe(200);
    expect(out.upstreamCode).toBeNull();
    expect(out.reason).toBeNull();
  });

  it('③ 上游 401（body 无可提取业务码）→ httpStatus 401 / upstreamCode null / reason「HTTP 401」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(401, 'Unauthorized')));

    const out = await makeProbe().probe('kimi-k3');

    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBe(401);
    expect(out.upstreamCode).toBeNull();
    expect(out.reason).toBe('HTTP 401');
  });

  it('④ 上游 403 且带业务码 11102 → httpStatus 与 upstreamCode **同时有值**（两者不互斥）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp(403, JSON.stringify({ error: { code: 11102 } }))),
    );

    const out = await makeProbe().probe('kimi-k3');

    expect(out.ok).toBe(false);
    expect(out.httpStatus).toBe(403);
    expect(out.upstreamCode).toBe(11102);
    expect(out.reason).toContain('11102');
  });
});
