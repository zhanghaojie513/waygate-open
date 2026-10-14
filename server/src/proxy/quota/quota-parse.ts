/**
 * 上游额度响应解析（task#53）—— **纯函数，无副作用**。
 *
 * ## [v1.3.0] 真实形状已实测（生产探针 2026-10-13，见 tools/probe-wb-activities.mjs）
 *
 * `POST /v2/billing/meter/get-user-resource`（带分页 body）返回：
 * ```
 * { code:0, msg:"OK", data:{ Response:{ Data:{
 *     TotalCount:28, TotalDosage:3741,
 *     Accounts:[{
 *       CapacityRemain:0, CapacitySize:1500,          // 整数口径
 *       CapacityRemainPrecise:"1500",                  // 字符串精确口径（优先）
 *       ExpiredTime:"2026-10-05 17:26:19" | "",       // 空 = 永久/未定；非空已过 = 作废
 *       CycleEndTime:"2026-11-03 01:35:13",
 *       PackageName:"CodeBuddy个人版拉新权益包", Status:3,   // 0=有效 3=已耗尽
 *       …
 *     }] } } } }
 * ```
 * 旧结论（task#57「上游 404 不供货」）的根因是**方法错**：GET → 404，POST + 分页 body → 200。
 *
 * 聚合口径（只按真实出现的数据算，不编造）：
 *   remain = Σ 有效包 CapacityRemain（Precise 优先）；total = Σ 有效包 CapacitySize。
 *   「有效」= `ExpiredTime` 为空（永久/未定）**或**未到过期时刻（北京时间）。过期包不计入。
 *   多资源包没有统一的「重置时刻」，`resetAt` 恒为 null（不猜单一时间）。
 *
 * 旧的扁平字段别名解析保留为回退分支（万一别的 openai 提供商返回那种形状）。
 * 设计期假设的 `remainCredit/totalCredit/…` 从未命中过真实响应，仍只在字段确实出现时取值。
 */

/** 上游响应只在字段真的出现时才取值；取不到即 null。 */
export interface ParsedQuota {
  remain: number | null;
  total: number | null;
  used: number | null;
  resetAt: string | null;
  /** [v1.4.1] 资源包明细（仅 Accounts 分支有；账本展示用——每包名称/剩余/总量/已用/过期）。 */
  packages: QuotaPackage[];
  /** `data` 对象里实际出现的键名——**排障用**（解析失败时告诉我们上游到底给了什么）。 */
  observedKeys: string[];
}

/** [v1.4.1] 单个资源包的账本行（只含真实出现的字段；缺失为 null）。 */
export interface QuotaPackage {
  name: string;
  remain: number;
  size: number;
  used: number | null;
  expireAt: number | null;
}

/** 字段别名表：按优先级排列，命中第一个即用。全部是「真的出现过才取」。 */
const REMAIN_KEYS = ['remainCredit', 'remainingCredit', 'creditRemain', 'remain', 'remaining', 'leftCredit', 'balance', 'left'];
const TOTAL_KEYS = ['totalCredit', 'creditTotal', 'totalQuota', 'total', 'quota'];
const USED_KEYS = ['usedCredit', 'consumedCredit', 'usedQuota', 'used', 'consumed'];
const RESET_KEYS = ['resetAt', 'resetTime', 'expireAt', 'expireTime', 'renewAt', 'reset_at', 'reset_time'];

/** 解析上游的北京时间字符串（"YYYY-MM-DD HH:mm:ss"）为 epoch ms；形状不符返回 null（按「未知」处理）。 */
function parseCnTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]), Number(m[6]));
}

/** 取数字（Precise 字符串口径优先于整数字段）；取不到为 null。 */
function pickAccountNumber(acc: Record<string, unknown>, preciseKey: string, intKey: string): number | null {
  const precise = acc[preciseKey];
  if (typeof precise === 'string' && precise.trim() !== '' && Number.isFinite(Number(precise))) return Number(precise);
  const plain = acc[intKey];
  if (typeof plain === 'number' && Number.isFinite(plain)) return plain;
  if (typeof plain === 'string' && plain.trim() !== '' && Number.isFinite(Number(plain))) return Number(plain);
  return null;
}

/**
 * 聚合 `Accounts[]` 资源包列表（真实形状见文件头）。
 * 过期包（ExpiredTime 非空且已过北京时间当下）不计入；remain/size 任一缺失的包跳过（不猜）。
 * [v1.4.1] 同时返回明细（packages）供账本展示。
 */
function aggregateAccounts(accounts: unknown[], nowMs: number): { remain: number | null; total: number | null; used: number | null; packages: QuotaPackage[] } {
  let remain = 0;
  let total = 0;
  let usedSum: number | null = 0; // Σ 非空 CapacityUsed；一个都没有则保持 null（不推算）
  const packages: QuotaPackage[] = [];
  for (const item of accounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const acc = item as Record<string, unknown>;
    const expireMs = parseCnTime(acc['ExpiredTime']);
    if (expireMs !== null && expireMs <= nowMs) continue; // 已过期：作废不计入
    const r = pickAccountNumber(acc, 'CapacityRemainPrecise', 'CapacityRemain');
    const s = pickAccountNumber(acc, 'CapacitySizePrecise', 'CapacitySize');
    if (r === null && s === null) continue; // 两数都没有：跳过该包，不猜
    remain += r ?? 0;
    total += s ?? 0;
    const used = pickAccountNumber(acc, 'CapacityUsedPrecise', 'CapacityUsed');
    usedSum = usedSum === null ? (used !== null ? used : null) : used !== null ? usedSum + used : usedSum || null;
    packages.push({
      name: typeof acc['PackageName'] === 'string' ? acc['PackageName'] : '',
      remain: r ?? 0,
      size: s ?? 0,
      used,
      expireAt: expireMs,
    });
  }
  if (packages.length === 0) return { remain: null, total: null, used: null, packages: [] };
  return { remain, total, used: usedSum || null, packages };
}

/** 取第一个「存在且可转为有限数」的值。数字或数字字符串都接受；其余（对象/布尔/null）跳过。 */
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** 取第一个「存在且非空」的字符串值（时间字段原样透传，本服务不解析其格式）。 */
function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * 解析上游额度响应。
 *
 * 信封形状先做**业务码闸**：`code` 是数字且非 0 ⇒ 上游业务失败 ⇒ 返回 null（不猜、不取值）。
 * 数据对象取 `data`（对象）优先，其次回落到顶层（兼容扁平返回）。`data` 存在但不是对象 ⇒ null。
 *
 * [v1.3.0] 新增 `data.Response.Data.Accounts` 数组分支（真实形状，见文件头）：聚合资源包，
 * `used`/`resetAt` 恒为 null（多包无统一口径，不编造）。命中 Accounts 后**不再**走扁平别名回退。
 *
 * @returns 解析结果；无法识别为对象时返回 null（交由上层按失败处理）。
 *           注意：返回非 null **不代表**拿到了数字 —— 用 `hasAmount` 判定。
 */
export function parseQuotaPayload(payload: unknown, nowMs: number = Date.now()): ParsedQuota | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;

  // 业务码闸：非 0 视为上游侧失败（信封 `{code:0,...}`；无 code 字段则跳过此闸）
  if (typeof obj.code === 'number' && obj.code !== 0) return null;

  let data: Record<string, unknown>;
  if ('data' in obj) {
    const d = obj.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    data = d as Record<string, unknown>;
  } else {
    data = obj;
  }

  // [v1.3.0] 真实形状分支：data.Response.Data.Accounts[]
  const response = data['Response'];
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const inner = (response as Record<string, unknown>)['Data'];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const accounts = (inner as Record<string, unknown>)['Accounts'];
      if (Array.isArray(accounts)) {
        const { remain, total, used, packages } = aggregateAccounts(accounts, nowMs);
        return { remain, total, used: used ?? null, resetAt: null, packages, observedKeys: Object.keys(inner) };
      }
    }
  }

  return {
    remain: pickNumber(data, REMAIN_KEYS),
    total: pickNumber(data, TOTAL_KEYS),
    used: pickNumber(data, USED_KEYS),
    resetAt: pickString(data, RESET_KEYS),
    packages: [], // 扁平回退分支无资源包明细
    observedKeys: Object.keys(data),
  };
}

/**
 * 是否解析出了**至少一个**可用数字。
 *
 * `total` 缺失是**合法**的（上游可能只给剩余）——那不算失败，remain 照样填。
 * 只有「一个数字都没有」才判失败：说明字段名对不上，需要人工补别名。
 */
export function hasAmount(p: ParsedQuota): boolean {
  return p.remain !== null || p.total !== null;
}
