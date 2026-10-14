import type { RelaySettings } from '../../config/settings.defaults';
import type { SettingGroup } from './types';

/** 「服务」组 4 项。 */
export function serviceGroup(settings: RelaySettings): SettingGroup {
  return {
    id: 'service',
    label: '服务',
    items: [
      {
        key: 'service.listenHost',
        label: '监听地址',
        value: settings.service.listenHost,
        type: 'text',
        why: '默认只对本机开放。改为 0.0.0.0 后局域网设备也能用（需环境变量 RELAY_ALLOW_PUBLIC_BIND=1；缺失时启动会降级回环并告警），但请自行确认网络可信。',
        readonly: false,
        requiresRestart: true,
      },
      {
        key: 'service.listenPort',
        label: '端口',
        value: settings.service.listenPort,
        type: 'number',
        why: '控制台与 API 共用，建议不要改成 8080 等常见端口。',
        readonly: false,
        requiresRestart: true,
      },
      {
        key: 'service.autostart',
        label: '开机自启',
        value: settings.service.autostart,
        type: 'switch',
        why: '由部署时的 systemd 单元管理（systemctl enable relay）。控制台不设开关，避免与实际服务管理状态不一致。',
        readonly: true,
        requiresRestart: false,
      },
      {
        key: 'service.forceStreamRewrite',
        label: '超长请求兜底',
        value: settings.service.forceStreamRewrite,
        type: 'switch',
        why: '上游只接受流式请求。本服务恒开此兜底：收到非流式调用时自动改写为流式再拼接返回，不可关闭。',
        readonly: true,
        requiresRestart: false,
      },
    ],
  };
}
