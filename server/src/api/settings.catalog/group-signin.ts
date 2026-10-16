import type { RelaySettings } from '../../config/settings.defaults';
import type { SettingGroup } from './types';

/**
 * 「每日签到」组 1 项（v1.3.0 新增）。
 *
 * ## 两套签到体系（务必与实现一致）
 *   · **WorkBuddy（openai 协议）**：`WbSigninService` 每日 08:05 后代签
 *     （`/v2/billing/meter/daily-checkin`，Bearer = 转发在用的 ck_ 密钥，无凭证互踢）。
 *     本组的 `signin.workBuddyEnabled` 只控制它的**自动**签到；手动按钮不受影响。
 *   · **MiniMax Code（anthropic）**：`MinimaxSigninService` 恒开（凭证链原因：
 *     签到与反代互斥，代签是客户端不再登录的前提），不设开关。
 *   · **Qoder CN**：无积分体系，无签到。
 */
export function signinGroup(settings: RelaySettings): SettingGroup {
  return {
    id: 'signin',
    label: '每日签到',
    items: [
      {
        key: 'signin.workBuddyEnabled',
        label: 'WorkBuddy 签到状态同步',
        value: settings.signin.workBuddyEnabled,
        type: 'switch',
        why: '每日 08:05 后自动为 WorkBuddy（openai 协议）提供商签到领积分（100/天 + 连签加成），凭证用已导入的授权，对客户端无影响。关闭只停自动，提供商管理页的手动签到按钮不受影响。MiniMax Code 的签到恒开（其凭证链要求由 relay 代签，客户端不再登录）。',
        readonly: false,
        requiresRestart: false,
      },
    ],
  };
}
