import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from '../common/crypto';
import { RelayHttpError, ApiCode } from '../common/errors';
import { resolveDataDir } from '../store/db';
import { defaultSettings, EDITABLE_KEYS, REQUIRES_RESTART_KEYS, RelaySettings, CREDENTIAL_FILE } from './settings.defaults';
import { validateSetting } from './settings.validate';

export interface SettingsFile {
  version: number;
  settings: RelaySettings;
}

const SETTINGS_FILE = 'settings.json';
const SECRET_FILE = 'relay.secret';

function deepMerge(base: unknown, patch: unknown): unknown {
  /*
   * 只有 `patch` **缺值**时才保留 `base`。标量（number / string / boolean）必须**原样采用 patch**。
   *
   * ⚠️ 这里曾经是 `if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;`
   * —— 它把「patch 是标量」和「patch 缺值」混为一谈，后果是 `settings.json` 里
   * **所有标量设置**（`service.listenPort`、`upstream.baseUrl`、`logs.retainDays`…）在**启动加载**时
   * 被**默认值覆盖**：控制台里保存的值一重启就静默回退。`false` 还会被 `!patch` 吃掉，
   * 于是 `upstream.spoofUA` 这类默认 true 的开关**根本关不掉**。
   *
   * 为什么长期没被发现：运行时 `PUT /api/settings` 走的是另一条路径（直接改内存里的 this.settings），
   * **当场生效**，所以控制台看起来一切正常；只有"重启后从文件重载"这一条路是坏的，
   * 而它只在**重启**时才暴露 —— 直到 task#43 用「把 listenPort 写进 settings.json 再启动、
   * 看它绑哪个端口」实测出来（设 29123，实际绑 8787）。
   */
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

@Injectable()
export class RelayConfigService implements OnModuleInit {
  private settings: RelaySettings = defaultSettings();
  private version = 1;

  /**
   * 出站凭证（ck_…）的当前值。
   *
   * 注意这里是**可变字段**而非 `readonly`：控制台可以通过
   * `PUT /api/settings/credential` 在运行时替换它，无需重启进程
   * （见 credential.service.ts 的说明）。
   *
   * 所有消费点（proxy.service / models.service / catalog/pull）都写成
   * `this.config.upstreamKey` 按需读取，而不是构造时快照到局部变量，
   * 因此替换后立即对后续请求生效。
   *
   * 加载优先级见 `loadUpstreamKey()`：**环境变量 → 数据目录文件**。
   * 仍然坚持"只从服务端读"的语义：**没有**任何接口能让调用方把密钥读回去，
   * 掩码展示走 maskedUpstreamKey()。
   */
  private upstreamKeyValue: string;

  /** HMAC 密钥，用于 key_hash 与会话签名。 */
  readonly secret: string;

  constructor() {
    /*
     * ⚠️ 设置必须在**构造函数里**加载，不能等到 `onModuleInit()`。
     *
     * 原因（task#43 实测暴露）：`main.ts` 在 `app.listen()` **之前**就要拿监听地址与端口
     * （`resolveListen(config.get(), process.env)`），而 Nest 的 `onModuleInit()` 是在
     * `app.listen()` 期间才跑的。于是 `get()` 在那一刻只会返回**字段初始值**（默认设置），
     * `settings.json` 里的 `service.listenHost` / `listenPort` **永远读不到** ——
     * 表现为「在控制台把端口改成 X、重启后仍绑 8787」。
     *
     * 这类 bug 特别隐蔽：`get()` **有值**（默认值），不报错、不告警，只是**是错的**。
     * 加载提前后，`get()` 在任何时刻都反映磁盘上的真实设置。
     */
    this.settings = this.loadSettings();
    this.upstreamKeyValue = this.loadUpstreamKey();
    this.secret = this.resolveSecret();
  }

  /**
   * 按优先级取上游凭证。
   *
   * 1. `RELAY_UPSTREAM_KEY` 环境变量 —— 部署时预置，优先级最高
   *    （systemd 的 `EnvironmentFile` 会把它注入进程环境）。
   * 2. `<数据目录>/upstream.key` —— 控制台运行时写入的位置。
   *
   * 为什么"环境变量"排在"文件"前面：环境变量是运维**显式**在部署配置里
   * 写下的意图，应当能覆盖界面上曾经填过的值；否则运维改了 `.env` 却发现
   * 不生效，会非常困惑。
   *
   * 读取失败一律降级为空串（而不是抛错）：凭证缺失只是让 /v1 报
   * `upstream_credential_invalid`，不该让整个服务起不来。
   */
  private loadUpstreamKey(): string {
    const fromEnv = (process.env.RELAY_UPSTREAM_KEY ?? '').trim();
    if (fromEnv) return fromEnv;

    const file = join(resolveDataDir(), CREDENTIAL_FILE);
    try {
      if (existsSync(file)) {
        return readFileSync(file, 'utf8').trim();
      }
    } catch (err) {
      console.warn(`[config] 读取凭证文件 ${file} 失败：${(err as Error).message}`);
    }
    return '';
  }

  /** 当前上游凭证。每次读取都取最新值，支持运行时替换。 */
  get upstreamKey(): string {
    return this.upstreamKeyValue;
  }

  /**
   * 运行时替换上游凭证（仅供 CredentialService 调用）。
   *
   * 入参不做格式校验 —— 校验属凭证服务职责，这里只负责赋值。
   * 传空串表示"清除配置"。
   */
  setUpstreamKey(key: string): void {
    this.upstreamKeyValue = key.trim();
  }

  onModuleInit(): void {
    // 设置已在**构造函数**里加载（见那里的说明）—— 这里**不要**再 loadSettings()：
    // 那会把构造函数之后的内存改动（例如启动瞬间刚 PUT 过的值）用磁盘旧值覆盖回去。
    if (!this.upstreamKeyValue) {
      console.warn(
        '[config] 未设置 RELAY_UPSTREAM_KEY。/v1/chat/completions 会在转发时报 upstream_credential_invalid。',
      );
    }
  }

  private resolveSecret(): string {
    const fromEnv = (process.env.RELAY_SECRET ?? '').trim();
    if (fromEnv) return fromEnv;
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, SECRET_FILE);
    if (existsSync(file)) {
      return readFileSync(file, 'utf8').trim();
    }
    const generated = randomHex(32);
    writeFileSync(file, generated, { mode: 0o600 });
    console.warn(
      `[config] 未提供 RELAY_SECRET，已生成随机密钥写入 ${file}（权限 600）。` +
        '该文件丢失会导致全部 sk-waygate- 密钥失效。生产环境请用环境变量注入。',
    );
    return generated;
  }

  private settingsPath(): string {
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    return join(dir, SETTINGS_FILE);
  }

  private loadSettings(): RelaySettings {
    const path = this.settingsPath();
    if (!existsSync(path)) {
      const fresh = { version: 1, settings: defaultSettings() };
      writeFileSync(path, JSON.stringify(fresh, null, 2), { mode: 0o600 });
      return fresh.settings;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SettingsFile>;
      this.version = typeof parsed?.version === 'number' ? parsed.version : 1;
      const merged = deepMerge(defaultSettings(), parsed.settings ?? {}) as RelaySettings;
      /* [v0.5.8] 清掉已废弃键：`quota.cacheDiscount` 曾是本地兜底积分公式的折扣系数，
         公式整段移除后本键已无消费者。旧 settings.json 里可能还留着它 —— 若不清，
         deepMerge 会把它带进内存并再次落盘，变成一份**永远存在但没人读**的死配置。
         显式删除，让「配置项 = 有消费者的项」这条不变量保持成立。 */
      delete (merged.quota as unknown as Record<string, unknown>).cacheDiscount;
      return merged;
    } catch (err) {
      throw new RelayHttpError({
        httpStatus: 500,
        code: 'internal_error',
        apiCode: ApiCode.INTERNAL,
        message: `读取 ${path} 失败：${(err as Error).message}。修复或删除该文件后重启。`,
      });
    }
  }

  get(): RelaySettings {
    return this.settings;
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * 更新设置项。**实际语义是逐项应用**：只写 `entries` 里出现的 key，未提交的保持原值
   * —— 不是「全量替换」，漏传一项**不会**把它重置为默认值。
   * 协议约定仍是「前端先 GET 再 PUT 全量」，故正常路径上两者不可区分；
   * 「全量替换」是历史命名，不要据此推断漏传等于重置。danger 组不参与。
   */
  applyUpdates(entries: Array<{ key: string; value: unknown }>): {
    applied: number;
    requiresRestart: boolean;
    version: number;
  } {
    let requiresRestart = false;
    for (const entry of entries) {
      if (!EDITABLE_KEYS.has(entry.key)) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: `${entry.key} 不是可修改的设置项`,
        });
      }
      const check = validateSetting(entry.key, entry.value);
      if (!check.ok) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: check.message ?? `${entry.key} 校验失败`,
        });
      }
      this.assign(entry.key, entry.value);
      if (REQUIRES_RESTART_KEYS.has(entry.key)) requiresRestart = true;
    }
    this.version += 1;
    writeFileSync(
      this.settingsPath(),
      JSON.stringify({ version: this.version, settings: this.settings }, null, 2),
      { mode: 0o600 },
    );
    return { applied: entries.length, requiresRestart, version: this.version };
  }

  /**
   * 内部系统写入：**不走 `EDITABLE_KEYS` 闸**（那是用户设置 PUT 的防线）。
   *
   * 用途：提供商激活 / 改址时同步 `upstream.baseUrl` —— 该键 v0.6.5 起对用户只读
   * （出站都读 `provider.base_url`），但仍是「空库种子」与「无 active 提供商时的
   * 额度回落」的数据源，系统侧需要保持它指向当前活提供商。
   *
   * ⚠️ [2026-10-17 事故] 此前激活路径误走 `applyUpdates` —— 撞只读闸抛
   * 「upstream.baseUrl 不是可修改的设置项」，而 `repo.activate()` 已先落库：
   * 用户看到报错、刷新后却已启用（启用按钮自 v0.6.5 起一直带着这个静默故障，
   * 首次 UI 触发激活是本次删除重导才暴露）。
   */
  applyInternal(entries: Array<{ key: string; value: unknown }>): void {
    for (const entry of entries) {
      const check = validateSetting(entry.key, entry.value);
      if (!check.ok) throw new RelayHttpError({
        httpStatus: 400, code: 'invalid_request_body', apiCode: ApiCode.BAD_PARAM,
        message: check.message ?? `${entry.key} 校验失败`,
      });
      this.assign(entry.key, entry.value);
    }
    this.version += 1;
    writeFileSync(
      this.settingsPath(),
      JSON.stringify({ version: this.version, settings: this.settings }, null, 2),
      { mode: 0o600 },
    );
  }

  private assign(key: string, value: unknown): void {
    const [group, field] = key.split('.');
    const target = this.settings as unknown as Record<string, Record<string, unknown>>;
    if (!target[group]) return;
    target[group][field] = value;
  }

  restoreDefaults(): void {
    this.settings = defaultSettings();
    this.version += 1;
    writeFileSync(
      this.settingsPath(),
      JSON.stringify({ version: this.version, settings: this.settings }, null, 2),
      { mode: 0o600 },
    );
  }

  /** 上游凭证的掩码形态，用于设置页展示（ck_x••••3f7a）。 */
  maskedUpstreamKey(): string {
    const key = this.upstreamKeyValue;
    if (!key) return '未配置';
    if (key.length <= 8) return `${key.slice(0, 4)}••••`;
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }

  upstreamConfigured(): boolean {
    return this.upstreamKeyValue.length > 0;
  }

  /**
   * 全局数据目录，供凭证服务定位 .env 文件。
   * 与 settings.json / relay.secret 同目录，避免路径逻辑散落各处。
   */
  dataDir(): string {
    return resolveDataDir();
  }
}
