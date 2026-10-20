/**
 * 上游 URL 的**唯一解析处**（task#37）。
 *
 * 为什么要有这个文件：`upstream.baseUrl` 是设置项，但此前 `proxy.service.ts` 把
 * 上游地址**硬编码**成常量（`UPSTREAM_BASE`），于是设置页改了「上游地址」对真实转发
 * 毫无影响 —— 一个「界面能填、行为不变」的空壳项。这里把「读配置 → 去尾斜杠 → 拼路径」
 * 收敛成一处，转发 / 实测 / 目录拉取共用，杜绝各写各的（也避免 `/v2` 前缀漂移）。
 */

import type { RelayConfigService } from '../config/config.service';

/** chat/completions 路径（与上游网关一致）。 */
export const CHAT_COMPLETIONS_PATH = '/v2/chat/completions';

/**
 * 额度（剩余积分）端点路径（task#53 引入；**v1.3.0 结论再更新**）。
 *
 * ✅ **POST + 分页 body 返回 200**（2026-10-13 生产探针实测，tools/probe-wb-activities.mjs）：
 *    `POST <base>/v2/billing/meter/get-user-resource`，body 含 `ProductCode:'p_tcaca'`、
 *    `Status:[0,3]`、`PackageEndTimeRange{Begin,End}`（`YYYY-MM-DD HH:mm:ss` 时间窗）。
 *    响应 `data.Response.Data.Accounts[]` 为资源包数组（见 quota-parse.ts 的聚合口径）。
 *
 * 历史结论（task#57）：GET 打该路径 404 —— 根因是**方法错**，不是「上游没有」。
 * 旧的「上游对本账号不供货」判断作废；X-User-Id 头非必需（带/不带均 200）。
 */
export const QUOTA_PATH = '/v2/billing/meter/get-user-resource';

/** 由基地址拼出额度端点。 */
export function buildQuotaUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}${QUOTA_PATH}`;
}

/** [v1.3.0] WorkBuddy 签到状态端点（探针实测 2026-10-13：POST + Bearer ck_ + X-User-Id，信封 {code,msg,data}）。
 * ⚠️ 只读：领取端点 daily-checkin 对 ck_ 恒 403（上游原话 'API key not allowed for this path or method'），
 * 属用户会话域（OAuth）——本服务只做状态同步，不代领。 */
export const WB_SIGNIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';

/** 由基地址拼出 WorkBuddy 签到状态端点。 */
export function buildWbSigninUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}${WB_SIGNIN_STATUS_PATH}`;
}

/** [v1.4.0] WorkBuddy 签到领取端点（OAuth 域 —— ck_ 恒 403，见 wb-oauth.service.ts）。 */
export const WB_SIGNIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin';

/** [v1.4.0] WorkBuddy growth 任务族路径（OAuth 域；契约逆向自桌面端 H5，社区 2026-09 实证）。 */
export const WB_GROWTH_TASKS_PATH = '/v2/activity/growth/tasks';
export const WB_GROWTH_TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept';
export const WB_GROWTH_STREAK_PATH = '/v2/activity/growth/streak';
export const WB_GROWTH_REDEEM_PATH = '/v2/activity/growth/redeem';

/** 由基地址拼出上述端点。 */
export function buildWbPathUrl(baseUrl: string, path: string): string {
  return `${stripTrailingSlash(baseUrl)}${path}`;
}

/** 去掉尾部斜杠，避免拼出 `//v2`。 */
export function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/** 读当前生效的上游基地址（去尾斜杠）。转发与探测共用此解析。 */
export function resolveUpstreamBase(config: Pick<RelayConfigService, 'get'>): string {
  return stripTrailingSlash(config.get().upstream.baseUrl);
}

/** 由基地址拼出 chat/completions 端点。 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}${CHAT_COMPLETIONS_PATH}`;
}

/* =====================================================================
 * [v1.7.0] 自定义提供商（protocol='custom'）—— 任意 OpenAI 兼容端点。
 * 与上面 WorkBuddy 的 /v2 前缀无关：标准 OpenAI 布局是 /v1/chat/completions，
 * 但用户填 base 时两种惯例都有（https://api.x.com 与 https://api.x.com/v1），
 * 智能默认让两种填法都落到标准端点；不猜的兜底是显式 chatPath。
 * ===================================================================== */

/** 自定义提供商的默认 chat 路径（OpenAI 标准）。 */
export const CUSTOM_CHAT_PATH = '/v1/chat/completions';

/**
 * 自定义提供商的聊天端点。
 * ① 显式 chatPath（以 `/` 开头）优先 —— **根相对**：先剥掉 base 结尾的 `/vN` 版本段
 *    再拼（base 填了 `…/v1` 又显式给 `/v1/chat/completions` 的双写不会翻倍）；
 * ② base 以 `/v1`（或任意 `/vN`）结尾 → 只拼 `/chat/completions`（用户把版本段含进了 base）；
 * ③ 其余 → 拼 `/v1/chat/completions`。
 * 新建表单里要实时预览这个结果 —— 用户看到的 URL 就是将要请求的 URL。
 */
export function buildCustomChatUrl(baseUrl: string, chatPath?: string | null): string {
  const base = stripTrailingSlash(baseUrl);
  if (typeof chatPath === 'string' && chatPath.startsWith('/')) {
    return `${base.replace(/\/v\d+$/i, '')}${chatPath}`;
  }
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}${CUSTOM_CHAT_PATH}`;
}

/** 自定义提供商的模型清单端点（OpenAI 标准 GET /v1/models；同样吸收 /vN 结尾的 base）。 */
export function buildCustomModelsUrl(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl);
  return /\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}
