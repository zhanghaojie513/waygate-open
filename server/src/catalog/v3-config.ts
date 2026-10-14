/**
 * `/v3/config` 拉取：**真实计费倍率**的唯一来源（task: 倍率接口化）。
 *
 * 事实（probe-v3-*.mjs，2026-10-08 服务器实测，Node/undici 栈）：
 *   - `GET <base>/v3/config`，必需头仅三个：
 *       `Authorization: Bearer <ck_>`、`User-Agent: CLI/x.y CodeBuddy/x.y`、
 *       `X-User-Id: <任意非空>`（值不校验，缺它 → HTTP 200 但 `data.models` 为 null）。
 *   - **credits 字段由 CLI 形状的 UA 门控**：UA=CLI → 32 个对话模型、30 个带
 *     `credits:"x0.11 credits"`；UA=WorkBuddy → 37 个模型但**无 credits**；
 *     自报 UA（relay-station/x）→ 400/12403（网关白名单校验，与 /v2 目录拉取同规则）。
 *   - `x0.11` 与订阅侧核对过的 deepseek-v4.1-flash 真实倍率一致 —— 这就是官方计费口径。
 *   - curl 全组合拿回 models:null（栈指纹被降级），故本模块只在使用方（Node fetch）内验证过。
 *
 * 失败语义与 `pull.ts` 一致：**静默回落**（不抛、不刷错），调用方继续用种子倍率。
 */

import { deriveFamily, type CatalogEntry } from './pull';

/** 与真实 CLI 同形的 UA（网关按 UA 白名单放行，且倍率只在 CLI 视角返回）。 */
const CLI_UA = 'CLI/2.117.2 CodeBuddy/2.117.2';
/** X-User-Id 值不校验但必须非空；用服务名自标识，不伪装成真实用户。 */
const X_USER_ID = 'relay-station';

export const V3_CONFIG_PATH = '/v3/config';

/**
 * 解析 `credits` 字符串为倍率数字。
 *   "x0.11 credits" → 0.11；"x0.00" → 0（真实免费，不是未知）；空/无 x 前缀 → null。
 */
export function parseCreditsMultiplier(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /x([0-9]+(?:\.[0-9]+)?)/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析 `/v3/config` 信封为目录条目。
 * 形状：`{code:0,msg:"OK",data:{models:[{id,name,credits,…}]}}`；
 * `models` 为 null/缺失/空数组 → 返回 null（交由回落，不抛）。
 * 每个条目带 `source:'upstream'` 与**非空倍率**（credits 缺失的条目 multiplier=null，
 * 合并时只补不覆盖）。
 */
export function parseConfigModels(payload: unknown): CatalogEntry[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models) || models.length === 0) return null;

  const out: CatalogEntry[] = [];
  for (const item of models) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : null;
    if (!id) continue;
    const display = typeof rec.name === 'string' && rec.name ? rec.name : id;
    out.push({
      id,
      displayName: display,
      family: deriveFamily(id),
      tag: null,
      multiplier: parseCreditsMultiplier(rec.credits),
      source: 'upstream',
      verified: true,
      enabled: true,
    });
  }
  return out.length > 0 ? out : null;
}

export interface V3ConfigResult {
  ok: boolean;
  /** 失败原因（人话），成功时为 null。 */
  reason: string | null;
  models: CatalogEntry[];
}

export interface V3ConfigOptions {
  baseUrl: string;
  upstreamKey: string;
  timeoutMs: number;
  /** 注入以便测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 拉取 `/v3/config` 的模型倍率表。失败是**预期正常路径**（回落是常态）：
 * 不抛错、不刷错误日志，`ok:false` + 人话原因交调用方决策。
 */
export async function fetchV3ConfigModels(opts: V3ConfigOptions): Promise<V3ConfigResult> {
  if (!opts.upstreamKey) {
    return { ok: false, reason: '未配置上游访问密钥，倍率沿用本地快照', models: [] };
  }
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${V3_CONFIG_PATH}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${opts.upstreamKey}`,
        'user-agent': CLI_UA,
        'x-user-id': X_USER_ID,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, reason: `/v3/config HTTP ${res.status}，倍率沿用本地快照`, models: [] };
    }
    const parsed = parseConfigModels(await res.json());
    if (!parsed) {
      // 200 但 models:null：上游把该身份/密钥降级了（实测缺 X-User-Id 即如此）
      return { ok: false, reason: '/v3/config 未返回模型表（models:null），倍率沿用本地快照', models: [] };
    }
    return { ok: true, reason: null, models: parsed };
  } catch {
    return { ok: false, reason: '/v3/config 拉取失败（超时/网络），倍率沿用本地快照', models: [] };
  }
}
