import type { RelaySettings } from '../../config/settings.defaults';
import type { SettingGroup } from './types';

/**
 * 「积分同步」组 4 项（[v0.6.5] 文案如实化）。
 *
 * ## 生效范围（务必与实现一致）
 *   · `quota.pollSeconds` / `quota.backoffMaxSeconds` → **仅对 openai 协议（WorkBuddy）生效**
 *     （`QuotaSourceService.fetchOnce` 只挑 `protocol === 'openai'` 的启用提供商）。
 *   · MiniMax Code（anthropic）**不用这套轮询** —— 它有**独立账本**：
 *     `MinimaxCreditService` 每 5 分钟拉 `minimax-cloud/api/v1/credit/details`，
 *     给「剩余 / 已用 / 累计发放」精确到 0.01（见概览页「积分账本」卡片）。
 *   · Qoder CN（qoder）**不用这套轮询**（`quota.pollSeconds` 只管 WorkBuddy）——
 *     它的余额走 `openapi.qoder.com.cn/sash/api/v2/me/usage`（套餐内 + 资源包），
 *     由 `QoderActivityService` 在每轮活动检查时顺带拉取，进账本卡片。
 *     ⚠️ v1.6.1 更正：此前判为「Qoder 没有任何额度端点」是**漏查 v2 的错判**
 *     （当时只看了 v1 端点集合，matrix 端点 503 也是另一码事）。
 */
export function quotaGroup(settings: RelaySettings): SettingGroup {
  return {
    id: 'quota',
    label: '积分同步',
    items: [
      {
        key: 'quota.pollSeconds',
        label: '同步间隔',
        value: settings.quota.pollSeconds,
        type: 'number',
        why: '【仅对 WorkBuddy（openai 协议）生效】额度接口的轮询间隔。[v1.3.0] 已打通：POST /v2/billing/meter/get-user-resource 返回资源包列表并聚合出剩余/总量（旧版 GET 实测 404 的根因是方法错）。MiniMax Code 的积分走独立账本（每 5 分钟固定拉取，不走本项）；Qoder CN 的积分走 v2/me/usage（资源包余额，每轮活动检查时拉取）。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'quota.backoffMaxSeconds',
        label: '失败退避',
        value: settings.quota.backoffMaxSeconds,
        type: 'number',
        why: '【仅对 WorkBuddy 生效】网络 / 临时失败时按指数退避，最长该值（秒）一次，避免拖垮上游。接口确定不存在（404）时退到每天一次。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'quota.onFailure',
        label: '同步失败时',
        value: settings.quota.onFailure,
        type: 'select',
        options: [
          { value: 'keep_and_mark', label: '保留旧值 + 标记' },
          { value: 'clear', label: '清空' },
        ],
        /* [v0.6.5] 收正：旧文案称「不把横幅清空」——积分横幅已在 task#62 改为 tokens 横幅。
           [v1.3.0] WorkBuddy 额度接口打通（POST 实测 200），失败策略恢复真实行为，去掉 noop。 */
        why: '额度同步失败时的策略（保留旧值更稳，清空更诚实，二选一）。MiniMax Code 的账本失败时固定「保留旧值 + 标记数据偏旧」，不由此项控制。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'quota.warnBelow',
        label: '额度告警',
        value: settings.quota.warnBelow,
        type: 'number',
        /* [v0.6.5] 收正：旧文案称「概览额度块标 low」——前端已不渲染额度块/low 标注。
           MiniMax 的余额告警走账本卡片自己的「偏旧 / 低额度」展示。 */
        why: '剩余积分低于该阈值时会在额度数据里标记 low。[v1.3.0] WorkBuddy 额度接口已打通，本项恢复真实行为；MiniMax Code 的余额展示由其账本卡片独立处理，不受本项影响。',
        readonly: false,
        requiresRestart: false,
      },
      /* [v0.5.8 删除] `quota.cacheDiscount`（缓存折扣系数）：唯一消费者是本地兜底积分
         公式，公式已整段移除（上游未回报即 credits=null）。留着它就是「界面能填、
         行为不变」的空壳配置 —— 本仓库明确把这类项当缺陷，故连 UI 一起删。 */
    ],
  };
}
