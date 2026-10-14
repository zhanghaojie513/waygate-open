import type { DangerSpec } from '../components/settings/DangerConfirmModal';

/**
 * 三个「危险动作」的二次确认文案，按对应设置项的 key 索引。
 *
 * 抽到这里是因为它是**数据**（三个动作各自的标题 / 后果 / 确认语），
 * 与设置页的渲染逻辑无关；留在页面里会让那一页无谓变长。
 * 每条的 `action` 必须与后端 `POST /api/settings/danger/:action` 的路由段一致。
 */
export const DANGER_SPECS: Record<string, DangerSpec> = {
  'danger.clearLogs': {
    action: 'clearLogs',
    title: '清空全部日志？',
    body: '删除后「按模型 / 按客户端」明细会一并归零。剩余积分不受影响，服务也不中断。',
    lose: '将删除本机全部请求日志，覆盖保留天数内的所有记录，没有备份入口。',
    ok: '确认清空',
  },
  'danger.resetKeys': {
    action: 'resetKeys',
    title: '重置全部密钥？',
    body: '所有密钥会立即失效，每个客户端都要重新填一次。已消耗的积分不受影响。',
    lose: '将失效全部 sk-waygate- 密钥，正在使用它们的客户端会立刻收到 401。',
    ok: '确认重置',
  },
  'danger.restoreDefaults': {
    action: 'restoreDefaults',
    title: '恢复默认配置？',
    body: '会用默认值覆盖 ~/.relay/config.yml。你改过的端口、并发、日志保留天数都会回到出厂值。',
    lose: '将覆盖所有自定义配置，服务重启后生效。',
    ok: '确认恢复',
  },
};
// @zbiti-ai:f:32:0e38f75a
