import type { SettingGroup } from './types';

/** 「危险操作」组 3 项（type:'action'，无 value，走独立端点 POST /api/settings/danger）。 */
export function dangerGroup(): SettingGroup {
  return {
    id: 'danger',
    label: '危险操作',
    items: [
      {
        key: 'danger.clearLogs',
        label: '清空全部日志',
        type: 'action',
        tone: 'warn',
        why: '删除后「积分与用量」的按模型 / 客户端明细将一并归零，剩余积分不受影响。',
      },
      {
        key: 'danger.resetKeys',
        label: '重置全部密钥',
        type: 'action',
        tone: 'warn',
        why: '所有 sk-waygate- 密钥立即失效，已填进客户端的密钥需要逐个替换。',
      },
      {
        key: 'danger.restoreDefaults',
        label: '恢复默认配置',
        type: 'action',
        tone: 'warn',
        why: '设置回到初始值，上游地址与并发上限需要重新确认。',
      },
    ],
  };
}
