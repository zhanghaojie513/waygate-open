/**
 * IP 白名单条目的解析与匹配（纯函数，无依赖）。
 *
 * 服务对象：
 *   · `keys.parsing.ts` —— 创建/修改密钥时校验用户输入的白名单条目；
 *   · `auth/key.guard.ts` —— 每个入站请求判定来源 IP 是否放行。
 *
 * 支持的条目形态（够用且可预期，不追求数学完备）：
 *   · IPv4 精确：`203.0.113.7`
 *   · IPv4 CIDR：`203.0.113.0/24`
 *   · IPv6 精确：`2001:db8::1`（仅小写化比较，不做 `::` 展开的等价归一）
 *
 * 为什么 IPv6 不做 CIDR：本部署的真实来源 IP 是 Nginx 写入的 `$remote_addr`
 * （见 common/client-ip.ts 文件头的取信论证），以 IPv4 为主；给 v6 补全
 * 128 位掩码数学换来的覆盖率是零，却增加出错面。等真有 v6 网段需求再补。
 */

/** 解析 IPv4 为 32 位无符号整数；不合法返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** 是不是像 IPv6（含冒号即可；精确匹配场景下不需要更严的校验）。 */
function looksLikeIpv6(s: string): boolean {
  return s.includes(':') && /^[0-9a-fA-F:]+$/.test(s);
}

/** 归一化一个白名单条目；不合法返回 null（调用方负责报 400）。 */
export function normalizeIpEntry(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // CIDR（仅 IPv4）
  const slash = s.indexOf('/');
  if (slash > 0) {
    const base = s.slice(0, slash);
    const prefixStr = s.slice(slash + 1);
    if (!/^\d{1,2}$/.test(prefixStr)) return null;
    const prefix = Number(prefixStr);
    if (prefix > 32) return null;
    if (ipv4ToInt(base) === null) return null; // 不允许 IPv6 CIDR（见文件头）
    return `${base}/${prefix}`;
  }
  if (ipv4ToInt(s) !== null) return s;
  if (looksLikeIpv6(s)) return s.toLowerCase();
  return null;
}

/** 来源 IP 是否命中单个白名单条目。 */
export function ipMatches(ip: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash > 0) {
    const base = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    if (prefix === 0) return true; // /0 = 全放行（用户显式写的，按字面执行）
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  // 精确匹配：v4 数字比较等价字符串比较；v6 小写化比较
  if (ipv4ToInt(ip) !== null && ipv4ToInt(entry) !== null) return ip === entry;
  return ip.toLowerCase() === entry.toLowerCase();
}

/**
 * 白名单整表判定。
 *
 * @param ip 来源 IP；null 表示取不到（如未经 nginx 的直连）。
 * @param whitelist 归一化后的白名单（空数组 = 不限）。
 * @returns true = 放行。
 *
 * ⚠️ ip 为 null 且白名单非空时**拒绝**（fail closed）：设置了白名单就意味着
 *    「只许名单内来源」，来源未知比来源不符更不能放。生产路径恒经 nginx，
 *    ip 为 null 只出现在配置错误的部署里 —— 拒绝并让用户看到，比静默放行好。
 */
export function ipAllowed(ip: string | null, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  if (ip === null || ip === '' || ip === 'unknown') return false;
  return whitelist.some((entry) => ipMatches(ip, entry));
}
