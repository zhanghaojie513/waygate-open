/**
 * 设置项校验（服务端必须做，不只信前端）。依据 api-contract §3.8 的约束表。
 * 失败时返回人话 message，指明是哪个字段、应该是什么。
 */

export interface SettingCheck {
  ok: boolean;
  message?: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

function isIp(value: string): boolean {
  if (value === 'localhost') return true;
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 已改为只读的键（task#37）。
 *
 * `applyUpdates` 会先按 `EDITABLE_KEYS` 拦掉这些 key；这里是**第二道闸** ——
 * 万一将来有人绕过 `EDITABLE_KEYS` 直接调 `validateSetting`，也必须被拒，
 * 而不是落进旧分支「校验通过」。体现「拒绝只读写入」是结构性的，不只靠一处判断。
 */
const READONLY_HINT: Record<string, string> = {
  'service.autostart': '由部署时的 systemd 单元管理（systemctl enable relay），不能通过 PUT 修改。',
  'service.forceStreamRewrite': '上游只接受流式请求，此兜底恒开、不可关闭，不能通过 PUT 修改。',
  'limits.retryOn429': '自动重试尚未实现，此值当前不产生任何行为，不能通过 PUT 修改。',
  'limits.retryCreditToOwner': '依赖自动重试，而自动重试尚未实现，不能通过 PUT 修改。',
  'logs.dir': '日志由 systemd / journald 收集，控制台不维护日志目录，不能通过 PUT 修改。',
  /* [v0.6.5] 多提供商后，出站/目录/额度都读 provider.base_url；这个全局位只作
     种子/老部署回落，改它不影响出站。提供商的地址请在「客户端管理 → 提供商」改。 */
  'upstream.baseUrl': '提供商地址已按家维护（见「客户端管理 → 提供商」），此全局位不再可改。',
};

export function validateListenHost(value: unknown): SettingCheck {
  if (typeof value !== 'string' || !isIp(value)) {
    return { ok: false, message: 'service.listenHost 必须是合法 IP 地址（如 127.0.0.1）' };
  }
  if (value !== '127.0.0.1' && value !== '::1' && value !== 'localhost') {
    if (process.env.RELAY_ALLOW_PUBLIC_BIND !== '1') {
      return {
        ok: false,
        message:
          'service.listenHost 只允许回环地址。确需对外监听请先在环境里设置 RELAY_ALLOW_PUBLIC_BIND=1，并自行承担公网暴露的后果。',
      };
    }
  }
  return { ok: true };
}

export function validateSetting(key: string, value: unknown): SettingCheck {
  const readonlyHint = READONLY_HINT[key];
  if (readonlyHint) {
    return { ok: false, message: `${key} 已是只读项：${readonlyHint}` };
  }
  switch (key) {
    case 'service.listenHost':
      return validateListenHost(value);
    case 'service.listenPort':
      if (!isInt(value) || value < 1 || value > 65535) {
        return { ok: false, message: 'service.listenPort 必须是 1–65535 之间的整数' };
      }
      return { ok: true };
    case 'upstream.spoofUA':
    case 'logs.recordRequestBody':
    case 'logs.recordResponseBody':
    case 'signin.workBuddyEnabled': // [v1.3.0] WorkBuddy 每日自动签到开关（布尔）
      if (typeof value !== 'boolean') {
        return { ok: false, message: `${key} 必须是布尔值` };
      }
      return { ok: true };
    /* [v0.6.5] upstream.baseUrl 改为只读（见 READONLY_HINT），校验 case 移除。
       upstream.userAgent 取而代之可写：WorkBuddy UA 基准值。 */
    case 'upstream.userAgent':
      if (typeof value !== 'string' || (value !== '' && !/^[\x21-\x7e]{1,200}$/.test(value))) {
        return {
          ok: false,
          message: 'upstream.userAgent 必须是可打印字符串（如 WorkBuddy/5.8.0），最长 200 字符；留空表示沿用入站 UA',
        };
      }
      return { ok: true };
    case 'upstream.promptRewrite':
      if (value !== 'template' && value !== 'neutral' && value !== 'off') {
        return {
          ok: false,
          message: 'upstream.promptRewrite 只能是 template（模板行改写，默认）、neutral（中性提示全量替换）或 off（关闭改写）',
        };
      }
      return { ok: true };
    case 'quota.pollSeconds':
      if (!isInt(value) || value < 5) {
        return { ok: false, message: 'quota.pollSeconds 必须是不小于 5 的整数（秒）' };
      }
      return { ok: true };
    case 'quota.backoffMaxSeconds':
      if (!isInt(value) || value < 5 || value > 3600) {
        return { ok: false, message: 'quota.backoffMaxSeconds 必须在 5–3600 之间（秒）' };
      }
      return { ok: true };
    case 'quota.onFailure':
      if (value !== 'keep_and_mark' && value !== 'clear') {
        return { ok: false, message: 'quota.onFailure 只能是 keep_and_mark 或 clear' };
      }
      return { ok: true };
    case 'quota.warnBelow':
      if (!isInt(value) || value < 0) {
        return { ok: false, message: 'quota.warnBelow 必须是不小于 0 的整数' };
      }
      return { ok: true };
    case 'limits.concurrency':
      if (!isInt(value) || value < 1 || value > 32) {
        return { ok: false, message: 'limits.concurrency 必须在 1–32 之间' };
      }
      return { ok: true };
    case 'limits.firstByteTimeoutMs':
      if (!isInt(value) || value < 1000 || value > 600000) {
        return { ok: false, message: 'limits.firstByteTimeoutMs 必须在 1000–600000 之间（毫秒）' };
      }
      return { ok: true };
    case 'logs.retainDays':
      if (!isInt(value) || value < 1 || value > 3650) {
        return { ok: false, message: 'logs.retainDays 必须在 1–3650 之间（天）' };
      }
      return { ok: true };
    case 'logs.recordBodyUntil':
      if (value === null) return { ok: true };
      if (!isInt(value) || value <= 0) {
        return { ok: false, message: 'logs.recordBodyUntil 必须是未来的毫秒时间戳（epoch ms），或 null 表示不限时' };
      }
      return { ok: true };
    default:
      return { ok: false, message: `${key} 不是可修改的设置项` };
  }
}
