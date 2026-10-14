/**
 * `config.mapping`：控制台 key → config.yml key（契约 §3.8 原文照抄）。
 *
 * ⚠️ [v0.6.5] config.yml **已不是本服务的配置载体**（现在用 `settings.json`，
 * 见 `config.service.ts` 的 SETTINGS_FILE）。本表只剩"老部署文件键名对照"的历史参照作用。
 */
export const CONFIG_MAPPING: Record<string, string> = {
  'service.listenHost': 'listen.host',
  'service.listenPort': 'listen.port',
  'service.autostart': 'autostart',
  'credential.source': 'credential.source',
  'upstream.baseUrl': 'upstream.baseUrl',
  'upstream.userAgent': 'upstream.userAgent',
  'upstream.spoofUA': 'upstream.spoofUA',
  'upstream.promptRewrite': 'upstream.promptRewrite',
  'quota.pollSeconds': 'quota.poll',
  'quota.backoffMaxSeconds': 'quota.backoff',
  'quota.warnBelow': 'quota.warnBelow',
  'signin.workBuddyEnabled': 'signin.workBuddyEnabled', // [v1.3.0] 新增（无老部署对照，自映射）
  'limits.concurrency': 'limits.concurrency',
  'limits.retryOn429': 'limits.retryOn429',
  'limits.firstByteTimeoutMs': 'limits.firstByteTimeout',
  'logs.retainDays': 'logs.retainDays',
  'logs.recordRequestBody': 'logs.body',
};
