/**
 * 客户端 IP 提取（审计用）。
 *
 * ## 为什么要单独抽出来
 * `src/main.ts` 里 Fastify 显式设了 `trustProxy: false` —— 这是**安全选择**：
 * 若让 Fastify 自行推导，任何客户端都能用 `X-Forwarded-For` 头把自己的
 * `remoteAddress` 伪造成任意值。所以进程层面只认 socket 对端（即 Nginx 的
 * `127.0.0.1`）。真实客户端 IP 由**应用层显式**从 XFF 头里取。
 *
 * 代价是：取到的值**可被伪造**，因此它只用于**审计展示与限流**，
 * 绝不用于鉴权判定。这个前提必须一直成立。
 *
 * ## 为什么取"最后一段"，而不是"首段"
 * 最初这里取的是**首段**（最左）—— 那是常见写法，但在本部署里是**错的**，实测踩坑：
 *
 *   Nginx 原先用 `$proxy_add_x_forwarded_for`，它是**追加**语义：
 *     客户端发 `X-Forwarded-For: 1.2.3.4`  →  Nginx 转发 `1.2.3.4, <真实IP>`
 *   此时"最左"是**攻击者自己填的**。实测带伪造头打进来，日志真的记成了 `1.2.3.4`，
 *   后果有两个且都严重：
 *     - 审计日志的 IP 不可信（追责失效）
 *     - 限流按 IP 分桶 → 每次换个假 IP 就绕过锁定（限流形同虚设）
 *
 *   而"最右"是 Nginx **自己追加**的 `$remote_addr`，客户端无法伪造。
 *
 * 现在已把 Nginx 改成**覆写**（`X-Forwarded-For $remote_addr`），所以头里只有一段，
 * 取首段与取末段结果相同。但后端仍坚持取**末段**，作为**纵深防御**：
 * 即使将来有人把 Nginx 配置改回追加语义，这里取到的仍是最可信的那一段。
 *
 * ⚠️ 前提：**紧邻本服务的最后一跳（Nginx）必须自己写入/覆写 XFF**。
 *    若前面再挂 CDN 且它只是透传客户端的头，末段就变成客户端的原始值 —— 仍可伪造。
 *    那种部署下需要改成"从右往左跳过 N 个可信代理"的算法。
 */

/** 含 headers / ip 的最小请求形状 —— 不依赖 Fastify 类型，便于测试与复用。 */
export interface RequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * 从 XFF 值里取最可信的一段。
 *
 * 取**最后一段**：紧邻本服务的代理（Nginx）会把自己看到的 `$remote_addr`
 * 放在末尾（无论是追加还是覆写），这一段客户端伪造不了。
 * 见文件头注释「为什么取最后一段」。
 */
function lastHop(xff: string): string {
  const parts = xff.split(',');
  // 从右往左取第一个非空段：容忍 "a, b, " 这种尾部空段的写法
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const v = parts[i]!.trim();
    if (v) return v;
  }
  return '';
}

/**
 * 取客户端 IP。取不到时返回 'unknown'（调用方直接拿去写日志，
 * 不需要再处理 null）。
 */
export function clientIpOf(req: RequestWithIp): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const ip = lastHop(forwarded);
    if (ip) return ip;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const ip = lastHop(forwarded[forwarded.length - 1]!);
    if (ip) return ip;
  }
  return req.ip ?? 'unknown';
}

/**
 * 取真实的 socket 对端地址（`remoteAddress` 级别），**忽略 XFF**。
 *
 * 用途：审计日志里同时记「声称的客户端 IP」与「实际 TCP 对端」，
 * 两者不一致时就是有人在伪造 XFF —— 这本身是有价值的信号。
 */
export function socketPeerOf(req: RequestWithIp): string {
  return req.ip ?? 'unknown';
}

/** UA 写日志时的最大长度。见 `describeUa`。 */
export const UA_LOG_MAX = 120;

/**
 * 把 User-Agent 压成**可安全写日志的一行**。
 *
 * 三件事，缺一不可：
 *   · 截断到 120 字符 —— UA 无长度上限，超长会让日志难读、也可被用来刷屏；
 *   · 去掉换行与控制字符 —— 否则伪造的 UA 能往 journal 里**插假日志行**
 *     （日志注入：让排障的人读到一条不存在的记录）；
 *   · 空/缺失回落 `-`，不留空串（空串在日志里看起来像"这一项没打印"）。
 *
 * [2026-10-08] 从 `api/auth/auth.controller.ts` 提上来：**客户端密钥**的拒绝留痕
 * （`auth/key.guard.ts`）也要这一份，而"两处各写一份"正是这个仓库反复踩的坑
 * （同一个 XFF 头曾经在两个模块里取了不同的段，见本文件头）。入站的两条入口
 * （控制台口令 / 客户端密钥）现在共用同一套脱敏规则。
 */
export function describeUa(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['user-agent'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > UA_LOG_MAX ? `${cleaned.slice(0, UA_LOG_MAX - 3)}...` : cleaned || '-';
}
