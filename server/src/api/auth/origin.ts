/**
 * CSRF 防护：Origin 同源校验（api-contract §1.4）。
 *
 * `SameSite=Strict` 已挡住绝大多数跨站表单提交，契约仍要求对
 * `POST/PUT/PATCH/DELETE` **额外**校验 `Origin`，理由是：
 *   - SameSite 在老旧浏览器上可能不被识别（会被当成无此属性）
 *   - Strict 挡的是"带 cookie 的跨站请求"，不等于"请求来自本页"
 *
 * 判定规则：
 *   1. 取 Origin 头；**缺失一律拒绝**（不是"放行"）——
 *      浏览器发起的跨站 POST 一定带 Origin，缺失意味着是脚本/curl 这类非浏览器来源。
 *   2. 命中下列任一即放行：
 *      a. `RELAY_TRUSTED_ORIGINS` 环境变量里的显式白名单（逗号分隔）
 *      b. `Origin` 的 host 部分 === 请求的 `Host` 头
 *   3. 协议固定要求 `http`/`https` 之一，其他 scheme（如 `null`、`file://`）直接拒
 *      —— `Origin: null` 是沙箱 iframe 的典型值，必须拒。
 *
 * ## ⚠️ 为什么必须有 (a) 显式白名单：反向代理会改写 Host
 * 开发期 Vite 的 `server.proxy` 用 `changeOrigin: true`，会把 `Host` 改写成
 * 代理目标（实测：浏览器发 `Origin: http://localhost:5173`，后端收到
 * `Host: 127.0.0.1:8787`）。此时单靠 (b) 比对必然失败 → 控制台登录 403。
 *
 * 生产 Nginx 的配置（deploy-security.md）用 `proxy_set_header Host $host;`
 * 保留原 Host，所以 (b) 在生产是成立的；但把正确性押在"代理恰好没改写"上太脆，
 * 因此 (a) 是必须的安全阀 —— 反向代理场景下由运维显式声明可信来源。
 *
 * 已知取舍：**curl 手工调试会因为没有 Origin 而被 403**。
 * 这是有意的：本服务只打算服务浏览器控制台。调试请显式加
 * `-H "Origin: http://127.0.0.1:8787"`，冒烟脚本里就是这么做的。
 */

import { RelayHttpError, ApiCode } from '../../common/errors';

/** 安全的幂等方法无需 Origin 校验。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function needsOriginCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * 解析 `RELAY_TRUSTED_ORIGINS`。
 * 只接受形如 `https://relay.example.com` 或 `http://localhost:5173` 的完整 origin
 * （scheme + host[:port]），与浏览器 Origin 头同格式，便于直接比对。
 */
export function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // 归一成 `scheme://host[:port]`，丢掉路径/查询，与 Origin 头可比
      out.push(`${url.protocol}//${url.host}`);
    } catch {
      /* 非法项跳过：不因一个拼错的白名单项让整个服务不可用 */
    }
  }
  return out;
}

export interface OriginCheckInput {
  method: string;
  origin: string | undefined;
  host: string | undefined;
  /** 可注入以便测试；缺省读环境变量。 */
  trustedOrigins?: string[];
}

export type OriginCheck = { ok: true; via: 'trusted-list' | 'same-host' } | { ok: false; reason: string };

export function checkOrigin(input: OriginCheckInput): OriginCheck {
  if (!needsOriginCheck(input.method)) return { ok: true, via: 'same-host' };

  const origin = input.origin?.trim();
  if (!origin) {
    return { ok: false, reason: '缺少 Origin 头（跨站请求防护）' };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: `Origin 不是合法 URL：${origin}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Origin 协议不被接受：${parsed.protocol}` };
  }

  const normalized = `${parsed.protocol}//${parsed.host}`;
  const trusted = input.trustedOrigins ?? parseTrustedOrigins(process.env.RELAY_TRUSTED_ORIGINS);
  if (trusted.includes(normalized)) return { ok: true, via: 'trusted-list' };

  const host = input.host?.trim();
  if (host && parsed.host === host) return { ok: true, via: 'same-host' };

  return {
    ok: false,
    reason: host
      ? `Origin(${parsed.host}) 与本站(${host}) 不同源，且不在 RELAY_TRUSTED_ORIGINS 白名单里`
      : `缺少 Host 头，且 Origin(${parsed.host}) 不在 RELAY_TRUSTED_ORIGINS 白名单里`,
  };
}

/** 校验失败统一抛 403 / 40301，文案带下一步动作。 */
export function assertOrigin(input: OriginCheckInput): void {
  const result = checkOrigin(input);
  if (result.ok) return;
  throw new RelayHttpError({
    httpStatus: 403,
    code: 'origin_mismatch',
    apiCode: ApiCode.BAD_ORIGIN,
    message: `${result.reason}。若访问域名与本站不同（反向代理场景），请把它加进环境变量 RELAY_TRUSTED_ORIGINS。`,
  });
}
