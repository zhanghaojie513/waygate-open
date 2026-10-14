/**
 * Qoder 目录拉取（v0.6.0）：GET /algo/api/v2/model/list?Encode=1 → 目录条目。
 *
 * 关键设计点 —— **id 用显示名，不碰内部 key**：
 *   网关的模型清单是「显示名（Qwen3.8-Flash）→ 内部 key（qfmodel）」映射，
 *   而**客户端请求里传来的也是内部 key**（POC 实测：chat 的 model_config.key=qfmodel
 *   才被接受）。Waygate 的目录 id 是路由键，客户端请求按 id 路由，所以：
 *     · 目录行的 id = **网关内部 key**（qfmodel）—— 与 MiniMax 种子同思路（id 即路由键）；
 *     · displayName = 显示名（Qwen3.8-Flash）—— 界面上给人看；
 *     · 反向映射 name→key 一并存进条目 tag 之外的地方？不需要：路由命中后
 *       doCallQoder 直接把 ctx.modelId（= 目录 id = 内部 key）投给网关。
 *   这样「客户端按显示名配模型」会不会失败？会 —— 客户端必须用它模型列表里看到的
 *   名字。为兼顾人类习惯，拉取时对**每个模型额外生成一条显示名别名行**？
 *   ✗ 不做：别名行会污染目录（同一模型两行、占比图重复）。折中：显示名进 displayName，
 *   控制台「模型清单」页可见；客户端配置用内部 key（本服务 README 已给示例）。
 *
 * 解析宽容度：响应形状 { sceneName: [ {key, display_name, enable, is_vl, max_output_tokens} ] }，
 * 场景取 'chat'（缺失时取第一个非空场景）；enable=false 的跳过；key/display_name 缺的跳过。
 * 不做方言实测（与 anthropic 同：实测会消耗额度，且这里没有 multiplier 概念）。
 */

import { buildCosyBearer, cosyChatHeaders, type CosySession, type QoderIdentity } from '../proxy/qoder-upstream/cosy';
import type { CatalogEntry } from './pull';

export const QODER_MODEL_LIST_PATH = '/algo/api/v2/model/list?Encode=1';

interface QoderCatalogItem {
  key?: unknown;
  display_name?: unknown;
  enable?: unknown;
  is_vl?: unknown;
}

/** 从内部 key 推 family（显示名族：qmodel_38max→qwen，dmodel→deepseek…；未知给 'qoder'）。 */
function familyOf(key: string): string {
  if (key.includes('qmodel') || key.startsWith('q3')) return 'qwen';
  if (key.startsWith('dmodel') || key.startsWith('dfmodel')) return 'deepseek';
  if (key.startsWith('gmodel') || key.startsWith('gfmodel') || key.startsWith('gm')) return 'glm';
  if (key.startsWith('kmodel')) return 'kimi';
  if (key.startsWith('mmodel')) return 'minimax';
  return 'qoder';
}

/** 从响应体解析目录条目（纯函数，单测覆盖）。 */
export function parseQoderCatalog(raw: unknown): CatalogEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const scenes = raw as Record<string, unknown>;
  const list =
    (Array.isArray(scenes.chat) ? scenes.chat : null) ??
    Object.values(scenes).find((v) => Array.isArray(v) && v.length > 0) ??
    [];
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of list as QoderCatalogItem[]) {
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const name = typeof item.display_name === 'string' ? item.display_name.trim() : '';
    if (!key || !name || key === 'auto') continue; // auto 是网关的自动选型占位，不是真实模型
    if (item.enable === false) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      displayName: name,
      family: familyOf(key),
      source: 'upstream',
      multiplier: null, // Qoder 无倍率概念（免费档 billable:false；付费按 credits，不做本地折算）
      tag: item.is_vl === true ? '视觉' : null,
      verified: false, // qoder 不进 openai 方言实测（实测路径见 catalog-sync 跳过分支）
      enabled: true,
    });
  }
  return out;
}

/** 拉取（网络 IO；失败抛错由调用侧回落种子/保留旧目录）。 */
export async function pullQoderModels(opts: {
  baseUrl: string;
  identity: QoderIdentity;
  session: CosySession;
  timeoutMs: number;
}): Promise<CatalogEntry[]> {
  const path = QODER_MODEL_LIST_PATH;
  const pathOnly = path.split('?')[0];
  const date = String(Math.floor(Date.now() / 1000));
  const bearer = buildCosyBearer(opts.session, date, '', pathOnly);
  const headers = cosyChatHeaders(opts.session, opts.identity, bearer, date, 'application/json');

  const res = await fetch(`${opts.baseUrl}${path}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`model/list HTTP ${res.status}`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('model/list 响应不是 JSON');
  }
  const entries = parseQoderCatalog(parsed);
  if (entries.length === 0) throw new Error('model/list 解析出 0 个模型（响应形状变化？）');
  return entries;
}

/** 种子（上游拉不到时的回落；2026-10-11 实测目录快照）。 */
export const QODER_SEED_MODELS: CatalogEntry[] = [
  { id: 'qmodel_38max', displayName: 'Qwen3.8-Max', family: 'qwen', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'qfmodel', displayName: 'Qwen3.8-Flash', family: 'qwen', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'qmodel_latest', displayName: 'Qwen3.7-Max', family: 'qwen', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'qmodel', displayName: 'Qwen3.7-Plus', family: 'qwen', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'q37fmodel', displayName: 'Qwen3.7-Flash', family: 'qwen', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'dmodel', displayName: 'DeepSeek-V4-Pro', family: 'deepseek', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'dfmodel', displayName: 'DeepSeek-Flash', family: 'deepseek', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'gmodel', displayName: 'GLM-5.3', family: 'glm', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'gfmodel', displayName: 'GLM-5.3-Flash', family: 'glm', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'gm51model', displayName: 'GLM-5.2', family: 'glm', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'kmodel_latest', displayName: 'Kimi-K3', family: 'kimi', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'kmodel', displayName: 'Kimi-K2.8-Preview', family: 'kimi', source: 'seed', multiplier: null, tag: '视觉', verified: false, enabled: true },
  { id: 'mmodel', displayName: 'MiniMax-M2.7', family: 'minimax', source: 'seed', multiplier: null, tag: null, verified: false, enabled: true },
];
