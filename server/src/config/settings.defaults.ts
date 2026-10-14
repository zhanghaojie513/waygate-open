/** 设置项类型与默认值。键名与 api-contract §3.8 的 7 组 23 项一致。 */

/**
 * 上游凭证在数据目录下的文件名。
 *
 * 定义在这个中性文件里（而不是 credential.service.ts）是为了**避免循环依赖**：
 * `CredentialService` 依赖 `RelayConfigService`，若 `RelayConfigService` 反过来
 * 从 `credential.service.ts` 取常量，两者就构成 import 环。
 *
 * 为什么落盘在数据目录而不是 `.env`：见 credential.service.ts 的详细说明 ——
 * systemd 的 `ProtectSystem=strict` 不允许进程写自己的 `.env`。
 */
export const CREDENTIAL_FILE = 'upstream.key';

export interface ServiceSettings {
  listenHost: string;
  listenPort: number;
  autostart: boolean;
  forceStreamRewrite: boolean;
}

export interface UpstreamSettings {
  baseUrl: string;
  spoofUA: boolean;
  /** 伪装用的 User-Agent。留空表示沿用入站 UA。 */
  userAgent: string;
  /** 首条消息非 system 时补进去的默认提示词（v0.1 不在 UI 暴露）。 */
  defaultSystemPrompt: string;
  /**
   * system 提示改写档位（2026-10-07，上游 11128 根因定案后引入）：
   * - `template`（默认）：转发前对 system 正文做模板行**语义等价改写**，破坏上游的
   *   长 n-gram 指纹匹配（实测验证）；
   * - `neutral`：把 system 全量替换为中性提示（更激进，改变模型行为，降级/应急用）；
   * - `off`：不改写（上游命中指纹即 400/11128）。
   * 另有兜底：命中 11128 时服务层自动以 neutral 档重试一次（proxy.service.ts）。
   */
  promptRewrite: 'template' | 'neutral' | 'off';
}

export interface QuotaSettings {
  pollSeconds: number;
  backoffMaxSeconds: number;
  onFailure: 'keep_and_mark' | 'clear';
  warnBelow: number;
  /* [v0.6.5 移除] `endpoint`（额度端点）与下方 `limits.minMaxTokens` 都是**死配置**：
     全仓无任何消费者（grep 零命中），且 minMaxTokens 的值（64）与运行时实际用的
     硬编码常量 `MIN_MAX_TOKENS=16`（rewrite.ts）还互相矛盾。按本仓库纪律
     「界面能填、行为不变 = 缺陷」，一并删除。 */
}

export interface LimitSettings {
  concurrency: number;
  retryOn429: number;
  retryCreditToOwner: boolean;
  firstByteTimeoutMs: number;
  /* [v0.6.5 移除] `minMaxTokens`：无任何消费者，且值与运行时常量矛盾 —— 见 QuotaSettings 尾注。 */
}

export interface LogSettings {
  retainDays: number;
  recordRequestBody: boolean;
  recordResponseBody: boolean;
  dir: string;
  /**
   * [v0.2.0 B7] 请求体取证的**自动过期时间**（epoch 毫秒；null = 不限时）。
   * 请求日志页的「取证 30 分钟」会连同 recordRequestBody 一起写一个未来时间戳；
   * 到点后即使忘了关，也不会继续把对话内容写进本地库（隐私兜底）。
   * **不在设置页渲染**（隐藏键），但可经 PUT /api/settings 修改。
   */
  recordBodyUntil: number | null;
}

export interface SigninSettings {
  /**
   * [v1.3.0] WorkBuddy（openai 协议）每日签到状态同步开关。
   * 上游不允许 ck_ 代领（403 实证），本服务只读查询签到状态（用户在官方端领过后
   * 显示今日已签）；每日 08:05 后同步（幂等闸 wb_signin_checked_on）。
   * MiniMax 的签到无开关（凭证链原因恒开，见 minimax-signin.service.ts）。
   */
  workBuddyEnabled: boolean;
}

export interface RelaySettings {
  service: ServiceSettings;
  upstream: UpstreamSettings;
  quota: QuotaSettings;
  limits: LimitSettings;
  logs: LogSettings;
  signin: SigninSettings;
}

export const DEFAULT_UPSTREAM_BASE_URL = 'https://copilot.tencent.com';
export const DEFAULT_UPSTREAM_PATH = '/v2/chat/completions';
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export function defaultSettings(): RelaySettings {
  return {
    service: {
      listenHost: '127.0.0.1',
      listenPort: 8787,
      autostart: true,
      forceStreamRewrite: true,
    },
    upstream: {
      baseUrl: DEFAULT_UPSTREAM_BASE_URL,
      spoofUA: true,
      userAgent: 'WorkBuddy/5.8.0',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      promptRewrite: 'template',
    },
    quota: {
      pollSeconds: 30,
      backoffMaxSeconds: 300,
      onFailure: 'keep_and_mark',
      warnBelow: 500,
    },
    limits: {
      concurrency: 4,
      retryOn429: 3,
      retryCreditToOwner: true,
      firstByteTimeoutMs: 30000,
    },
    logs: {
      retainDays: 30,
      recordRequestBody: false,
      recordResponseBody: false,
      dir: '~/.relay/logs/',
      recordBodyUntil: null,
    },
    signin: {
      workBuddyEnabled: true,
    },
  };
}

/**
 * 修改后必须重启进程才生效的键。
 *
 * 只保留**仍然可写**且**确实只在启动时消费**的键：readonly 项（`service.autostart`
 * / `logs.dir` 等）已不在 `EDITABLE_KEYS` 里，留在本表只会误导（task#37）。
 *
 * ⚠️ `upstream.baseUrl` **不在**此表（task#58）：它由 `proxy.service.ts` 在每个请求里
 * `buildChatCompletionsUrl(resolveUpstreamBase(config))` **逐请求实时读**（probe / 目录拉取 /
 * 额度探测同理），改后**立即生效，无需重启**。此前误标为需重启，与实际不符。
 * 监听地址/端口则确实只在 `main.ts` 的 `resolveListen()`（`app.listen()` 之前）读一次 → 仍需重启。
 */
export const REQUIRES_RESTART_KEYS = new Set<string>([
  'service.listenHost',
  'service.listenPort',
]);

/**
 * PUT 可提交的键（readonly 与 action 项不在此集合）。
 *
 * ⚠️ 与契约 §3.8 及 `settings.catalog/` 的 `readonly` 标记**必须同源**：
 * 一个 key 要么在这里、要么在 catalog 里标 `readonly:true`，不能两边都不认。
 * 本集合 = 服务端**实际接受**的写入键（`RelayConfigService.applyUpdates` 的闸）。
 *
 * task#37 移出（改为 readonly）：`service.autostart`（交给 systemd）、
 * `service.forceStreamRewrite`（恒开不可关）、`limits.retryOn429` 与
 * `limits.retryCreditToOwner`（自动重试未实现）、`logs.dir`（journald 收集）。
 */
export const EDITABLE_KEYS = new Set<string>([
  'service.listenHost',
  'service.listenPort',
  /* [v0.6.5] `upstream.baseUrl` 已移出可写：出站/目录/额度都读 `provider.base_url`（多提供商），
     改这个全局位对出站无效（会被下次激活覆写）。字段本体保留（种子/老部署回落用），
     但不再作为设置页可写项 —— 提供商的地址请在「客户端管理 → 提供商」改。 */
  'upstream.userAgent', // [v0.6.5] 新增可写：WorkBuddy UA 基准值，跟随官方客户端版本不用改代码
  'upstream.spoofUA',
  'upstream.promptRewrite',
  'quota.pollSeconds',
  'quota.backoffMaxSeconds',
  'quota.onFailure',
  'quota.warnBelow',
  'limits.concurrency',
  'limits.firstByteTimeoutMs',
  'logs.retainDays',
  'logs.recordRequestBody',
  'logs.recordResponseBody',
  'logs.recordBodyUntil',
  'signin.workBuddyEnabled', // [v1.3.0] WorkBuddy 每日自动签到开关（实时读，改完下轮生效）
]);
