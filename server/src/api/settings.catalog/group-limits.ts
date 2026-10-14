import type { RelaySettings } from '../../config/settings.defaults';
import type { SettingGroup } from './types';

/** 「限流与重试」组 4 项。重试相关的两项当前**未实现**，故只读（task#37）。 */
export function limitsGroup(settings: RelaySettings): SettingGroup {
  return {
    id: 'limits',
    label: '限流与重试',
    items: [
      {
        key: 'limits.concurrency',
        label: '并发上限',
        value: settings.limits.concurrency,
        type: 'number',
        why: '同时向上游发出的请求数。超过则本机直接回 429，不排队（客户端需自行退避重试）。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'limits.retryOn429',
        label: '429 自动重试',
        value: settings.limits.retryOn429,
        type: 'number',
        /* 措辞里**不写版本号** —— 原先是「v0.4.1 尚未实现」，每升一次版那句话就过期一次，
           而它正是要挡住"改了就生效"的错觉（用户会读到它）。现在只说事实，与版本无关。 */
        why: '429 自动重试尚未实现。此值当前不产生任何行为，设为只读以免误以为改了就生效。',
        readonly: true,
        noop: true,
        requiresRestart: false,
      },
      {
        key: 'limits.retryCreditToOwner',
        label: '重试积分归属',
        value: settings.limits.retryCreditToOwner,
        type: 'switch',
        why: '依赖自动重试，而自动重试尚未实现。此值当前不产生任何行为，设为只读。',
        readonly: true,
        noop: true,
        requiresRestart: false,
      },
      {
        key: 'limits.firstByteTimeoutMs',
        label: '首字超时（毫秒）',
        value: settings.limits.firstByteTimeoutMs,
        type: 'number',
        why: '从发出请求到上游送出首个数据帧的上限。已开始的流不受总时长限制，仅受「连续 5 分钟无数据」的挂死保护。',
        readonly: false,
        requiresRestart: false,
      },
    ],
  };
}
