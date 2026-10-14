/**
 * 上游模型目录拉取与合并（SPEC §9 AC-07；task#18 切到真上游）。
 *
 * 事实（probe/04-catalog-recheck.md）：真端点 = `GET /v2/enterprises/personal/models`
 * （需 `Authorization: Bearer <ck_>`，GET-only，网关会校验 User-Agent）。
 * 返回信封 `{code,msg,requestId,data:[{id,name,…}]}`，模型在 `data` 数组下。
 *
 * 清单来源三路合一（用户原话「可用模型按实际请求来」）：
 *   upstream  上游目录（本文 `pullUpstreamModels`）
 *   seed      随版本发布的本地种子（schema.sql 播种）
 *   observed  实际成功调用过（requests.status=200）—— 不依赖任何上游端点，最硬证据
 * 优先级（同 id 命中多源取高者）：upstream > manual > seed > observed。
 *
 * 倍率两路来源：
 *   /v3/config   接口真实倍率（`credits:"x0.11 credits"`，见 v3-config.ts）——**权威**，
 *                合并时覆盖本地过期快照（官方促销/调价会变，如 space-bunny 0.03→0.08）
 *   seed         随版本发布的本地快照 —— 接口未覆盖该模型时的兜底
 * 唯一例外：`source='manual'` 的历史行不被接口覆盖（用户手填优先）。
 *
 * 回落：拉取失败（404/超时/DNS/未配置）一律**静默回落**到 seed + observed，不抛、不刷错。
 */

import { parseCreditsMultiplier } from './v3-config';

export type CatalogSource = 'upstream' | 'seed' | 'observed' | 'manual';

/** 来源优先级：数字越大越「硬」。同 id 命中多源时取高者。 */
const SOURCE_RANK: Record<CatalogSource, number> = { upstream: 4, manual: 3, seed: 2, observed: 1 };

function stronger(a: CatalogSource, b: CatalogSource): CatalogSource {
  return SOURCE_RANK[a] >= SOURCE_RANK[b] ? a : b;
}

/**
 * [v0.4.15] 从上游 `tags` 数组提取**计价徽标**文字。
 *
 * 上游把 WorkBuddy 客户端里看到的「限时免费 / 夜间折扣」等标签嵌在 tags 数组里，
 * 格式 `badge:<文字>:<颜色>`（实测 copilot.tencent.com `/v2/enterprises/personal/models`：
 * `tags: ["craft","badge:限时免费:#FF0000"]`）。非徽标条目（如 "craft"）是能力标记，不是计价信息。
 */
export function extractBadgeTag(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith('badge:')) {
      const parts = t.split(':');
      if (parts.length >= 2 && parts[1]) return parts[1];
    }
  }
  return null;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  family: string;
  tag: string | null;
  multiplier: number | null;
  source: CatalogSource;
  verified: boolean;
  enabled: boolean;
}

export interface PullResult {
  ok: boolean;
  /** 失败原因（人话），成功时为 null。 */
  reason: string | null;
  models: CatalogEntry[];
  origin: 'upstream' | 'local';
}

export function deriveFamily(id: string): string {
  const idx = id.indexOf('-');
  return idx > 0 ? id.slice(0, idx) : id;
}

/** 从本地种子文件读出目录（回落路径）。 */
export function normalizeLocal(models: Array<Partial<CatalogEntry> & { id: string }>): CatalogEntry[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName ?? m.id,
    family: m.family ?? deriveFamily(m.id),
    tag: m.tag ?? null,
    multiplier: typeof m.multiplier === 'number' ? m.multiplier : null,
    source: 'seed',
    verified: true,
    enabled: true,
  }));
}

/** 把「实际请求过的模型」转成目录条目（source=observed，倍率未知）。 */
export function observedToEntries(rows: Array<{ id: string; displayName: string | null }>): CatalogEntry[] {
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName ?? r.id,
    family: deriveFamily(r.id),
    tag: null,
    multiplier: null, // 观测不提供倍率
    source: 'observed',
    verified: false,
    enabled: true,
  }));
}

/**
 * 判定上游响应是否为可用的模型清单，并解析成条目。
 *
 * 兼容三种形状：
 *   ① 真信封 `{code,msg,requestId,data:[{id,name,…}]}`（copilot.tencent.com 实测）
 *   ② OpenAI `{data:[{id}]}`
 *   ③ `{models:[...]}`
 * 都不匹配 → 返回 null（交由回落），不抛。
 * 条目只取 id 与 name（displayName）；**没有 multiplier**（上游不给倍率）。
 */
export function parseUpstreamModels(payload: unknown): CatalogEntry[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const raw = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : obj.data && typeof obj.data === 'object' && Array.isArray((obj.data as Record<string, unknown>).models)
        ? ((obj.data as Record<string, unknown>).models as unknown[])
        : null;
  if (!raw) return null;

  const out: CatalogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : null;
    if (!id) continue;
    const display = typeof rec.name === 'string' ? rec.name : typeof rec.display_name === 'string' ? rec.display_name : id;
    /* [v0.4.15] 上游真实字段映射（实测 2026-10-10，此前一直读错字段名导致全 null）：
       · tag ← tags 数组里的 `badge:文字:颜色` 条目（WorkBuddy 客户端同源的计价徽标）
       · multiplier ← credits 字符串（"x0.11 credits" / "x0.79"），与 /v3/config 共用解析器 */
    out.push({
      id,
      displayName: display,
      family: deriveFamily(id),
      tag: extractBadgeTag(rec.tags),
      multiplier: parseCreditsMultiplier(rec.credits),
      source: 'upstream',
      verified: true,
      enabled: true,
    });
  }
  return out.length > 0 ? out : null;
}

export interface PullOptions {
  baseUrl: string;
  upstreamKey: string;
  timeoutMs: number;
  /** 伪装 UA；上游对 UA 有校验（probe: WorkBuddy/5.8.0）。 */
  userAgent?: string;
  /** 注入以便测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 候选路径，按序尝试。 */
  paths?: string[];
}

/** 真端点（probe/04-catalog-recheck.md 已确证）。 */
const DEFAULT_PATHS = ['/v2/enterprises/personal/models'];
const DEFAULT_UA = 'WorkBuddy/5.8.0';

/**
 * 拉取上游模型目录。失败是**预期正常路径**（回落是常态，不是异常）：
 * 不抛错、不刷错误日志，交由调用方把 seed + observed 并进来。
 */
export async function pullUpstreamModels(opts: PullOptions): Promise<PullResult> {
  if (!opts.upstreamKey) {
    return { ok: false, reason: '未配置上游访问密钥，直接使用本地种子 + 已观测模型', models: [], origin: 'local' };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const paths = opts.paths ?? DEFAULT_PATHS;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const tried: string[] = [];

  for (const path of paths) {
    const url = `${base}${path}`;
    tried.push(path);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const res = await doFetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${opts.upstreamKey}`,
          accept: 'application/json',
          'user-agent': opts.userAgent ?? DEFAULT_UA,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) continue; // 404 是预期结果，不记错误
      const payload = (await res.json()) as unknown;
      const parsed = parseUpstreamModels(payload);
      if (parsed) {
        return { ok: true, reason: null, models: parsed, origin: 'upstream' };
      }
    } catch {
      // 端点不存在 / 超时 / DNS 失败 —— 全部走回落，不抛
      continue;
    }
  }

  return {
    ok: false,
    reason: `上游模型目录未拉到（已试 ${tried.join('、')}）。使用本地种子 + 已观测模型。`,
    models: [],
    origin: 'local',
  };
}

/**
 * 三路合并：本地表 ∪ 上游 ∪ observed。
 *
 * **只增不减**：绝不删除本地已有的行（订阅以后可能又开）。
 * 用户字段（enabled）以**本地为准**，上游/观测不覆盖；
 * tag 与倍率例外（v0.4.15 用户拍板「按真实来」）：上游计价徽标与倍率是**实时数据**
 * （官方促销/调价会变），非 manual 行跟随上游 —— 上游无徽标时清空本地种子标签
 * （种子是手写的会过期，上游没有就是真没有）。observed 不碰 tag / 倍率（观测不提供这些）。
 * displayName：上游为准（订阅侧权威）；观测不覆盖既有显示名。
 */
export function mergeCatalog(
  local: CatalogEntry[],
  upstream: CatalogEntry[] = [],
  observed: CatalogEntry[] = [],
): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const l of local) byId.set(l.id, { ...l });

  const mergeIn = (incoming: CatalogEntry, preferIncomingDisplay: boolean, preferIncomingTag: boolean) => {
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, { ...incoming });
      return;
    }
    byId.set(incoming.id, {
      ...existing,
      displayName: preferIncomingDisplay && incoming.displayName ? incoming.displayName : existing.displayName,
      source: stronger(existing.source, incoming.source),
      // 接口已知倍率（仅 /v3/config 条目携带）覆盖本地过期快照；
      // manual（用户手填，历史保留）不被覆盖；接口没有倍率时只补 null，不动本地。
      multiplier:
        incoming.multiplier !== null && existing.source !== 'manual'
          ? incoming.multiplier
          : (existing.multiplier ?? incoming.multiplier),
      // 计价徽标（v0.4.16 用户拍板「按真实来」）：反代决定不了标签 —— 上游说有就有、
      // 说没有就没有，**无 manual 保护**（那是给倍率留的：用户可手填未知模型的倍率）。
      // preferIncomingTag 只在合并上游时为 true；observed 合并不动 tag。
      tag: preferIncomingTag ? incoming.tag : existing.tag,
      // enabled / verified 保持本地（用户改动优先）
    });
  };

  for (const u of upstream) mergeIn(u, true, true);
  for (const o of observed) mergeIn(o, false, false);

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
