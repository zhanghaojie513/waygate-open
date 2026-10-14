import type { RelaySettings } from '../../config/settings.defaults';
import type { SettingGroup } from './types';

/** 「日志」组 4 项。前 3 项已接线（task#37）；`logs.dir` 只读。 */
export function logsGroup(settings: RelaySettings): SettingGroup {
  return {
    id: 'logs',
    label: '日志',
    items: [
      {
        key: 'logs.retainDays',
        label: '保留天数',
        value: settings.logs.retainDays,
        type: 'number',
        why: '超期日志每日自动清理一次。它决定「积分与用量」页明细表能回溯多久。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'logs.recordRequestBody',
        label: '记录请求体',
        value: settings.logs.recordRequestBody,
        type: 'switch',
        why: '关闭后只记模型、tokens 与状态。开启会把对话内容写进本地库（默认关闭，超长请求体会被截断到 128 KiB）。绝不记录任何密钥 —— Authorization 只在请求头，不入库。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'logs.recordResponseBody',
        label: '记录响应体',
        value: settings.logs.recordResponseBody,
        type: 'switch',
        why: '同上，记录上游返回内容。默认关闭，排查上游异常时才临时打开（超长响应体会被截断）。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'logs.dir',
        label: '日志文件',
        value: settings.logs.dir,
        type: 'text',
        why: '日志由 systemd / journald 收集（journalctl -u relay）。控制台不单独维护日志目录，故只读。',
        readonly: true,
        requiresRestart: false,
      },
    ],
  };
}
