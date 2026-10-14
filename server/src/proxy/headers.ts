/**
 * 出站 / 入站请求头处理（ADR-004 第 2 步）。
 *
 * 本项目最危险的一条：**本机 sk-waygate- 密钥绝不能出现在出站请求里**。
 * 因此这里用 allowlist（不是 blocklist）—— 只拷贝明确安全的头，
 * 而不是"拷贝全部再删掉 Authorization"。allowlist 的失效模式是"少带一个头"，
 * blocklist 的失效模式是"密钥泄漏到上游"，两者代价不对称。
 */

/** 允许透传给上游的头（小写）。 */
const FORWARD_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-language',
  'user-agent', // 会被 spoofUA 覆盖；不在 allowlist 时根本无法伪装
]);

/**
 * 官方 WorkBuddy 桌面端指纹常量。
 *
 * [v0.6.3 用户授权完善] 对齐**当前官方客户端**（app.asar `buildVlmGatewayHeaders` +
 * 本机 product-config 缓存实测，2026-10-12）。与旧值（社区 workbuddy2api 抄来）的差异：
 *   · `X-Product` = deploymentType（本机实测 `SaaS`）—— 旧值硬编码 `WorkBuddy`
 *   · 补 `X-Agent-Intent: craft`、`X-Private-Data: true`（官方必带，此前缺失）
 *   · 版本 5.8.0（= `app.getVersion()` / product-config `genieVersion`）
 * ⚠️ `catalog/pull.ts` 记录「上游对 UA 有校验（probe: WorkBuddy/5.7.7）」——
 *    本改动落地前须在真实上游探针复验（postmortem 文档 §五）。
 */
const WORKBUDDY_CLI_VERSION = '2.137.1'; // 官方桌面端内置 CLI 段版本
const WORKBUDDY_ORIGIN = 'https://www.codebuddy.cn'; // CN 域 Origin/Referer 基准
const WORKBUDDY_FALLBACK_VERSION = '5.8.0';

/** 从配置 UA（`WorkBuddy/<ver>` 形态）解析客户端版本段；解析不出回落内置默认。 */
function parseWorkBuddyVersion(ua: string): string {
  const m = /WorkBuddy(?:\s+AI)?\/([\d.]+)/i.exec(ua);
  return m?.[1] ?? WORKBUDDY_FALLBACK_VERSION;
}

/**
 * 展开为官方桌面端 UA 三段式：`WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cliVer>`
 * （官方 RestOperations 层形状）。已含 CLI 段或非 WorkBuddy 形态的自定义 UA 原样返回
 * —— 用户显式配置的完整 UA 优先，不做二次加工。
 */
function expandWorkBuddyUA(ua: string): string {
  if (ua.includes('CLI/') || !/^WorkBuddy\b/i.test(ua)) return ua;
  const ver = parseWorkBuddyVersion(ua);
  return `WorkBuddy/${ver} WorkBuddy/${ver} CLI/${WORKBUDDY_CLI_VERSION}`;
}

/**
 * 注入用量归因头族（+ 官方客户端公共头）。这是「使用端」显示为 WorkBuddy 的关键：
 * X-Product / X-IDE-* / X-Agent-Purpose 缺失时上游归因为空，账单里就是网关特征。
 * 仅 spoofUA=true（伪装模式）调用；透明转发模式不动。
 *
 * [v0.6.3] 对齐官方客户端 `buildVlmGatewayHeaders`（app.asar 实测）：
 *   · `X-Product` = deploymentType（实测 `SaaS`），非 WorkBuddy；
 *   · 补 `X-Agent-Intent: craft`、`X-Private-Data: true`。
 */
function injectWorkBuddyFingerprint(headers: Record<string, string>, version: string): void {
  // 用量归因：对齐官方桌面端（X-IDE-Name/Type + 会话用途/意图声明）
  headers['x-agent-purpose'] = 'conversation';
  headers['x-agent-intent'] = 'craft'; // 官方恒定值
  headers['x-ide-name'] = 'WorkBuddy';
  headers['x-ide-type'] = 'WorkBuddy';
  headers['x-ide-version'] = version;
  // 官方取 deploymentType（本机 product-config 实测 = SaaS）
  headers['x-product'] = 'SaaS';
  headers['x-private-data'] = 'true'; // 官方恒定值
  // 官方客户端风控闸门头：所有 API 请求必带
  headers['x-codebuddy-request'] = '1';
  // Web 端公共头（官方客户端同款）
  headers['origin'] = WORKBUDDY_ORIGIN;
  headers['referer'] = `${WORKBUDDY_ORIGIN}/`;
  headers['x-requested-with'] = 'XMLHttpRequest';
  // 语言标识：入站有则透传（allowlist 已收），否则补 CN 默认
  if (!headers['accept-language']) headers['accept-language'] = 'zh-CN';
}

/** 明确列出、用于测试断言的敏感头：这些头永远不许出站。 */
export const NEVER_FORWARD = [
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-relay-key',
] as const;

const NEVER_FORWARD_SET = new Set<string>(NEVER_FORWARD);

export interface HeaderBuildResult {
  headers: Record<string, string>;
  /** 出站头里是否残留敏感头（必须恒为 false，测试会断言）。 */
  leaked: string[];
}

/**
 * 构造出站头。
 * @param incoming 客户端原始头
 * @param upstreamKey 上游 ck_ 凭证；为空时抛错由调用方处理
 * @param spoofUA 是否用伪装 UA 覆盖（false 时保留入站 UA，缺失则用默认）
 */
export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstreamKey: string,
  spoofUA: boolean,
  spoofUAValue: string,
): HeaderBuildResult {
  const headers: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = rawKey.toLowerCase();
    if (!FORWARD_ALLOWLIST.has(key)) continue;
    if (NEVER_FORWARD_SET.has(key)) continue; // 双保险，allowlist 已挡住
    if (rawValue === undefined) continue;
    headers[key] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
  }

  // ★ 强制注入上游凭证 —— 覆盖任何残留，且本机密钥从不进入这个函数
  headers['authorization'] = `Bearer ${upstreamKey}`;
  headers['content-type'] = 'application/json';

  if (spoofUA) {
    const ua = spoofUAValue || `WorkBuddy/${WORKBUDDY_FALLBACK_VERSION}`;
    headers['user-agent'] = expandWorkBuddyUA(ua);
    injectWorkBuddyFingerprint(headers, parseWorkBuddyVersion(ua));
  } else if (!headers['user-agent']) {
    headers['user-agent'] = `WorkBuddy/${WORKBUDDY_FALLBACK_VERSION}`;
  }

  const leaked = Object.keys(headers).filter((k) => NEVER_FORWARD_SET.has(k) && k !== 'authorization');
  return { headers, leaked };
}

/** 从 Authorization 头里取 Bearer token（入站鉴权用）。 */
export function extractBearer(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : null;
}
