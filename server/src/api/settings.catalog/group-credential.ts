import type { RelaySettings } from '../../config/settings.defaults';
import type { RuntimeInfo, SettingGroup } from './types';

/**
 * 「提供商策略」组（原「上游连接」，[v0.6.5] 改名并重写）。
 *
 * ## 为什么改名 + 重写
 * 本部署已从**单上游**演进为**多提供商并存**（WorkBuddy=openai / MiniMax Code=anthropic /
 * Qoder CN=qoder，各按 `providers` 表一行、各带自己的地址/凭证/模型目录）。
 * 旧文案仍写「你那把 ck_ 密钥」「WorkBuddy 桌面端」，把一家当成全局 —— 会直接误导。
 * 且**提供商身份（地址 / 凭证 / 模型清单）已整体移到「提供商管理」**，
 * 本组只剩**跨提供商的全局策略**；下面每一项的生效范围各不相同（见各 why）。
 *
 * ## 各项的生效范围（务必与实现一致，勿再笼统写"全局"）
 *   · `upstream.userAgent`     → **仅 openai 协议（WorkBuddy）**：UA 三段式展开的基准值
 *   · `upstream.spoofUA`       → **仅 openai 协议**：官方指纹头族开关；anthropic/qoder 走各自固定头
 *   · `upstream.promptRewrite` → **三家都改写 system**，但 11128 指纹校验是 WorkBuddy 专有
 */
export function credentialGroup(settings: RelaySettings, runtime: RuntimeInfo): SettingGroup {
  return {
    id: 'credential',
    label: '提供商策略',
    items: [
      {
        key: 'credential.source',
        label: '活动提供商',
        value: runtime.credentialSource,
        type: 'text',
        why: '当前生效提供商的凭证摘要（各家形态不同：WorkBuddy = 官方 OAuth 授权的账号前缀、MiniMax Code = 登录态 refresh token、Qoder CN = 身份 JSON）。逐家查看 / 重新导入请到「提供商管理 → 重新导入授权」。',
        readonly: true,
        requiresRestart: false,
      },
      {
        key: 'credential.status',
        label: '凭证状态',
        value: runtime.credentialStatus,
        type: 'badge',
        why: '活动提供商的凭证是否已导入（「有效」= 已通过官方授权导入）。只读运行态，只反映「导了没有」，不解析到期时间 —— 各家续期方式不同：MiniMax 自动刷新 refresh token、WorkBuddy / Qoder 需重新导入授权。',
        readonly: true,
        requiresRestart: false,
      },
      {
        key: 'upstream.baseUrl',
        label: '提供商地址',
        value: '（按家维护于「提供商管理」）',
        type: 'text',
        why: '【只读】多提供商后，出站转发、目录拉取、额度探测都读各自提供商的 base_url；本项曾是可改的全局地址，现仅作说明位。改地址请到「提供商管理 → 配置」。',
        readonly: true,
        requiresRestart: false,
      },
      {
        key: 'upstream.userAgent',
        label: 'WorkBuddy UA 基准值',
        value: settings.upstream.userAgent,
        type: 'text',
        why: '【仅对 WorkBuddy（openai 协议）生效】出站 User-Agent 的基准值，会展开成官方桌面端三段式（WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cli>）。官方客户端升版后改这里即可跟上，无需改代码发版。MiniMax Code 固定发 MiniMaxCode、Qoder CN 固定发 qodercli/<ver>，均不受本项影响。留空时：伪装档（spoofUA=开，默认）回落到内置默认版本并覆盖入站 UA；透明转发档（spoofUA=关）才沿用入站 UA。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'upstream.spoofUA',
        label: '请求头伪装（WorkBuddy）',
        value: settings.upstream.spoofUA,
        type: 'switch',
        why: '【仅对 WorkBuddy（openai 协议）生效】开启时把出站请求伪装成官方 WorkBuddy 桌面端：UA 展开为三段式，并注入用量归因头族（X-Product / X-IDE-* / X-Agent-Purpose / X-Agent-Intent 等），个人中心「使用端」才归因到 WorkBuddy。MiniMax Code 走标准 Anthropic SDK 头、Qoder CN 走 COSY 签名头，本开关对它们无效果。',
        readonly: false,
        requiresRestart: false,
      },
      {
        key: 'upstream.promptRewrite',
        label: 'system 提示改写',
        value: settings.upstream.promptRewrite,
        type: 'select',
        options: [
          { value: 'template', label: '模板行改写（默认·推荐）' },
          { value: 'neutral', label: '中性提示全量替换（激进）' },
          { value: 'off', label: '关闭' },
        ],
        why: '转发前对 system 正文做改写，三家提供商都会应用。改写要解决的主要是 WorkBuddy 的 11128 渠道校验（按 system 模板指纹拦截 Claude Code 系客户端）；MiniMax Code / Qoder CN 无此校验。「模板行改写」语义等价地改标签行（模型读法不变、指纹失效），被拒时自动降级重试一次；「中性替换」整段换掉（会改变模型行为，应急用）；「关闭」即不改写。改后立即生效。',
        readonly: false,
        requiresRestart: false,
      },
    ],
  };
}
