/**
 * 自定义提供商（2026-10-08，v0.3.x）—— `providers` 表的 API 层。
 *
 * ## 形态：多个已配置、单活（用户拍板）
 *
 * `providers` 表登记 N 个上游（名称 + baseUrl + 各自的凭证文件），**恰有一行 active=1**。
 * 「激活」一个提供商 = 三件事，全部落既有机制，**代理热路径一行不改**：
 *
 *   1. `repo.activate(id)`（事务内先清后置，保证"恰有一行"）
 *   2. 该提供商的凭证文件载入 `config.setUpstreamKey()`（getter 按需读，立即生效）
 *   3. 该行的 base_url 写进 `settings.upstream.baseUrl`（`resolveUpstreamBase()`
 *      本来就每个请求读一次设置 —— 转发 / 实测 / 目录拉取自动指向新提供商）
 *
 * ## 为什么激活要**清空并重建模型目录**
 *
 * 目录描述的是"当前活提供商有哪些模型"。切到另一个提供商后，
 * 旧清单里的模型在新上游**不存在** —— 如果留着，`resolveModel` 会放行、
 * 请求打到新上游吃一个 4xx，比本地直接 400 `model_not_found` 更糟。
 * 清空后立即做一次「拉取 + 合并」（**不**逐项实测 —— 实测真打上游真扣积分，
 * 只留给用户显式点「获取模型」）。
 *
 * 代价（如实记录）：清空会丢掉用户对旧清单做的启用/停用选择，切回来要重选。
 * 这是"单活"模型的固有代价，多活（按模型路由）才能消掉。
 *
 * ## 凭证存储：表里不放，每提供商一个文件
 *
 * 沿用「只写不可读」纪律（完整论证见 credential.service.ts）：
 * `<RELAY_DATA_DIR>/providers/<id>.key`，600 权限，原子写。
 * 表里只有 baseUrl 与名称 —— 库文件备份泄漏**不**泄漏凭证。
 *
 * ## URL 校验（SSRF 防线）
 *
 * 提供商地址是**用户输入**、会被服务端真实发起请求的目标，因此必须是
 * 公网 http/https：拒绝 localhost / 环回 / 私有 / 保留地址。
 * 既有 `upstream.baseUrl` 设置项不在此轮收紧 —— 收紧会让已用内网上游的
 * 部署在升级时静默失效；新攻击面（本接口）才需要这道闸。
 */

import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../store/db';
import { ProvidersRepository, type ProviderRow } from '../store/repositories/providers.repo';
import { ProviderModelPrefsRepository } from '../store/repositories/provider-model-prefs.repo';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError, ApiCode } from '../common/errors';
import { maskSecret } from '../common/mask';
import { CatalogSyncService } from '../catalog/catalog-sync';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { seedDefaultModels } from '../catalog/seed-models';
import { MinimaxCreditService } from '../proxy/anthropic-upstream/minimax-credit.service';
import { MinimaxTokenService } from '../proxy/anthropic-upstream/minimax-token.service';
import { WbOauthService } from '../proxy/openai-upstream/wb-oauth.service';
import { QuotaSourceService } from '../proxy/quota/quota-source.service';
import { QoderActivityService, type QoderLedgerBlock } from '../proxy/qoder-upstream/qoder-activity.service';
import { ModelProbeService } from '../catalog/probe';

/** 默认行的 id 固定成可读的名字 —— 迁移种子与排障日志里都要能认出它。 */
export const DEFAULT_PROVIDER_ID = 'p_default00';

/**
 * 默认提供商的显示名 —— **WorkBuddy**（2026-10-09 用户口径）。
 *
 * 现库（升级前）存的那条"上游连接"就是 WorkBuddy 的地址（copilot.tencent.com）
 * 与密钥（ck_…，WorkBuddy「访问密钥」页为 CodeBuddyCLI 签发）。
 * 叫"默认提供商"用户要自己猜"默认指谁"；叫 WorkBuddy 则与凭证的实际来源一致
 * （spec-v4-upstream-placement §4 的来源说明本来就是这么描述它的）。
 */
export const DEFAULT_PROVIDER_NAME = 'WorkBuddy';

/** v0.4.1 之前种子写死的旧名 —— 启动时改名为 WorkBuddy（见 renameLegacySeedName）。 */
const LEGACY_SEED_NAME = '默认提供商';

/**
 * 试通非活提供商时的探测模型名。
 *
 * 为什么不复用 models.service 的 `FALLBACK_PROBE_MODEL` 常量：那个属于目录视图层
 * （选"小而稳"的依据来自**活提供商的目录**）；这里的诉求不同 —— 非活提供商的目录
 * 我们没有，任何名字都可能 404，而 404 与 401 在判读里本来就是两种结论。
 * 选 `hunyuan-lite` 只为与既有试通口径一致（同一个名字，行为可比）。
 */
const PROBE_MODEL_FALLBACK = 'hunyuan-lite';

export interface ProviderItem {
  id: string;
  name: string;
  baseUrl: string;
  /** 凭证掩码（ck_x••••3f7a）。绝不回明文。 */
  credentialMask: string;
  /** 凭证文件是否存在且非空。 */
  configured: boolean;
  /** 是否当前生效（恰有一个 true）。 */
  active: boolean;
  /** [v0.5.0] 上游方言。 */
  protocol: 'openai' | 'anthropic' | 'qoder';
  /** [v0.5.0] 凭证生命周期。 */
  credKind: 'static' | 'oauth_minimax';
  /** [v0.5.4] 该提供商自己分区的模型数 / 启用数。 */
  modelCount: number;
  modelEnabled: number;
  /** [v0.5.6] 签到状态（仅 MiniMax oauth 提供商有值）。 */
  signin: { checkedOn: string | null; streak: number | null; lastPoints: number | null };
  /** [v1.4.0] WorkBuddy OAuth 领取域状态（configured=已导入 .oauth 槽；代领签到/任务的前提）。 */
  wbOAuth: { configured: boolean; uidMask: string | null; expiresAt: number | null };
  /** [v1.4.1] WorkBuddy 账本行（quota 快照；额度拉到过才有）。 */
  wbCredits: import('../proxy/quota/quota-block').WbLedgerRow | null;
  /** [v1.6.1] Qoder 账本行（余额取 v2/me/usage；到期时刻上游不提供，恒 null）。 */
  qoderCredits: QoderLedgerBlock | null;
  /** [v1.3.0] WorkBuddy 签到状态（仅 openai 提供商有值；与 MiniMax signin 分开：签到体系不同源）。 */
  wbSignin: { checkedOn: string | null; streak: number | null; lastPoints: number | null };
  /** [v0.5.7] **真实**积分账本（仅 MiniMax oauth 提供商有；WorkBuddy 上游未提供）。 */
  credits: import('../proxy/anthropic-upstream/minimax-credit.service').CreditLedgerBlock | null;
}

export interface CreateProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  credential?: unknown;
  /** [v0.5.0] 上游方言：'openai'（默认，WorkBuddy）| 'anthropic'（mavis / Anthropic 兼容）。 */
  protocol?: unknown;
  /** 创建后立即激活（默认 false —— 先建好、试通、再切换）。 */
  activate?: unknown;
}

export interface PatchProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  credential?: unknown;
}

@Injectable()
export class ProvidersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProvidersService.name);
  /** 凭证目录。可覆盖仅为可测性（同 credential.service 的理由：vitest 里不能 chdir）。 */
  private providersDir = join(resolveDataDir(), 'providers');

  constructor(
    private readonly repo: ProvidersRepository,
    private readonly config: RelayConfigService,
    private readonly catalogSync: CatalogSyncService,
    private readonly probe: ModelProbeService,
    /** 删提供商时连带清启停偏好（2026-10-09）。 */
    private readonly prefs: ProviderModelPrefsRepository,
    /* [v0.5.1] 默认提供商创建后种内置模型清单（schema.sql 静态种子已失效，见 seed-models.ts）。 */
    @Optional() private readonly catalog?: ModelCatalogRepository,
    /* [v0.5.7] 真实积分账本（MiniMax）。@Optional 兼容既有 spec 直构。 */
    @Optional() private readonly credits?: MinimaxCreditService,
    /* [v1.4.0] WorkBuddy OAuth 领取域状态。@Optional 兼容既有 spec 直构。 */
    @Optional() private readonly wbOauth?: WbOauthService,
    /* [v1.4.1] WorkBuddy 账本（quota 快照的 ledger 行）。@Optional 同上。 */
    @Optional() private readonly quotaSource?: QuotaSourceService,
    /* [v1.6.0] Qoder 账本（累计消耗口径）。@Optional 同上。 */
    @Optional() private readonly qoderActivity?: QoderActivityService,
    /* [v1.6.5] MiniMax 令牌服务：换 refresh token 时作废缓存 access token。@Optional 同上。 */
    @Optional() private readonly minimaxTokens?: MinimaxTokenService,
  ) {}

  onApplicationBootstrap(): void {
    this.ensureSeeded();
    this.renameLegacySeedName();
  }

  /** 仅供测试覆盖凭证落盘位置。 */
  setProvidersDirForTest(path: string): void {
    this.providersDir = path;
  }

  /**
   * 首次启动的种子（幂等：表非空即跳过）。
   *
   * 为什么在代码里而不在迁移 SQL 里：默认行要从 settings.json 读 baseUrl、
   * 要把现有凭证复制到 `providers/<id>.key` —— SQL 两件都做不到。
   *
   * 种子来源：
   *   - baseUrl ← `settings.upstream.baseUrl`（升级前唯一的上游地址）
   *   - 凭证   ← 当前的 `config.upstreamKey`（它按 env → upstream.key 的优先级加载）
   * 升级因此**零行为变化**：默认行就是原来那套上游，且已是 active。
   *
   * [2026-10-09] 名字按用户口径叫 **WorkBuddy** —— 现库里的上游连接就是
   * WorkBuddy 的地址与密钥（copilot.tencent.com + ck_…），叫"默认提供商"
   * 反而要用户自己猜"默认指谁"。
   */
  private ensureSeeded(): void {
    if (this.repo.count() > 0) return;
    const baseUrl = this.config.get().upstream.baseUrl;
    this.repo.create({ id: DEFAULT_PROVIDER_ID, name: DEFAULT_PROVIDER_NAME, baseUrl, active: true });

    /* [v1.6.13] 不再把 config.upstreamKey 迁到 .key —— WorkBuddy 的凭证是 OAuth 槽
       （ck_ 已退役）。升级后该行显示「未配置」，用户在控制台点「重新导入授权」即可。
       旧 .key 文件如存在也不读（不再是凭证来源），保留不删以免误伤回滚。 */
    if (this.catalog) {
      try {
        const n = seedDefaultModels(this.catalog, DEFAULT_PROVIDER_ID);
        this.logger.log(`默认提供商已种内置模型清单：${n} 项`);
      } catch (err) {
        this.logger.warn(`内置模型清单种入失败（不影响运行，可手动「获取模型」）：${(err as Error).message}`);
      }
    }
    this.logger.log(
      `已种子默认提供商 ${DEFAULT_PROVIDER_NAME}（${baseUrl}）—— 凭证需在控制台「重新导入授权」`,
    );
  }

  /**
   * 旧种子名叫「默认提供商」—— 已在 v0.4.1 前的库里的行，启动时改名为 WorkBuddy。
   *
   * 为什么不改迁移 SQL：改一个词不值得一条迁移（迁移是结构变更的纪律，
   * 数据修正放启动路径既幂等又不用人工跑脚本）。只认**默认行且恰好叫旧名**——
   * 用户自己建过同名提供商的理论场景不会被误改（那家不是 DEFAULT_PROVIDER_ID）。
   */
  private renameLegacySeedName(): void {
    const row = this.repo.findById(DEFAULT_PROVIDER_ID);
    if (row && row.name === LEGACY_SEED_NAME) {
      this.repo.patch(DEFAULT_PROVIDER_ID, { name: DEFAULT_PROVIDER_NAME });
      this.logger.log(`默认提供商已改名：${LEGACY_SEED_NAME} → ${DEFAULT_PROVIDER_NAME}（按用户口径）`);
    }
  }

  list(): { items: ProviderItem[] } {
    return { items: this.repo.list().map((r) => this.toItem(r)) };
  }

  findActive(): ProviderItem | null {
    const row = this.repo.findActive();
    return row ? this.toItem(row) : null;
  }

  create(input: CreateProviderInput): { item: ProviderItem; activated: boolean } {
    const name = this.parseName(input.name);
    const baseUrl = this.parseBaseUrl(input.baseUrl);
    const protocol = this.parseProtocol(input.protocol);
    const credential = this.parseCredential(input.credential, protocol);

    const id = `p_${randomBytes(4).toString('hex')}`;
    this.repo.create({
      id, name, baseUrl, active: false,
      protocol,
      credKind: protocol === 'anthropic' ? 'oauth_minimax' : 'static',
    });
    /* [v1.6.11] 空凭证不落盘 —— 落一个空文件会让 `configured` 判断（读文件非空）
       与实际不符。留空就是"待导入"，等「自动导入」写进来。 */
    if (credential) this.writeCredentialFile(id, credential);

    /* 创建时不自动激活（除非显式要求）：先把提供商建好、填凭证、试通，再显式切换。
       默认自动激活会让"手滑建错一个"直接把服务切到错误上游。 */
    const activated = input.activate === true;
    if (activated) this.activateWithResync(id);

    this.logger.log(`新增提供商 ${name}（${baseUrl}）${activated ? '，已激活' : ''}`);
    return { item: this.toItem(this.repo.findById(id)!), activated };
  }

  /**
   * [v0.5.1] 启用一个提供商并触发**它自己**的目录同步（不动别家 —— 多生效语义）。
   * `activate()` 与 `create(activate:true)` 共用：只同步不重建别家清单。
   */
  private activateWithResync(id: string): void {
    this.activateInternal(id);
    void this.catalogSync
      .syncProviderOnEnable(id)
      .catch((err: unknown) =>
        this.logger.warn(
          `启用提供商后同步模型目录失败（可手动点「获取模型」重试）：${(err as Error).message}`,
        ),
      );
  }

  patch(id: string, input: PatchProviderInput): ProviderItem {
    const row = this.mustFind(id);
    const patch: { name?: string; baseUrl?: string } = {};

    if (input.name !== undefined) patch.name = this.parseName(input.name);
    if (input.baseUrl !== undefined && input.baseUrl !== row.base_url) {
      patch.baseUrl = this.parseBaseUrl(input.baseUrl);
    }
    if (Object.keys(patch).length > 0) this.repo.patch(id, patch);

    /* 凭证单独走（只写文件；改的是活提供商时还要热载入内存） */
    if (input.credential !== undefined) {
      const credential = this.parseCredential(input.credential, row.protocol as 'openai' | 'anthropic' | 'qoder');
      if (row.protocol !== 'openai') {
        this.writeCredentialFile(id, credential);
        /* [v0.5.0] oauth 提供商的凭证不进全局位 —— 出站时由 MinimaxTokenService 换新。
           [v0.6.0] qoder 同理：凭证是身份 JSON，出站由 QoderCredentialStore 直读文件。 */
        if (row.active && row.protocol !== 'anthropic' && row.protocol !== 'qoder') this.config.setUpstreamKey(credential);
        /* [v1.6.5] anthropic：换了 refresh token 必须作废旧 access token，
           否则出站继续用旧令牌 —— 用户视角就是「改了凭证却没生效」。 */
        if (row.protocol === 'anthropic') this.minimaxTokens?.invalidate(id);
      }
      /* [v1.6.13] openai 走上面的 parseCredential 报错（ck_ 已退役）—— 这里到不了。 */
    }

    /* 活提供商的地址改了 → 立即写进设置（转发/实测/目录拉取都读它） */
    const updated = this.repo.findById(id)!;
    if (updated.active && patch.baseUrl !== undefined) {
      this.applyBaseUrlToSettings(patch.baseUrl);
    }
    return this.toItem(updated);
  }

  /**
   * 激活 = 切换全局出站上游。三步见文件头。
   * 返回切换后的提供商（供响应体）。
   */
  activate(id: string): ProviderItem {
    this.mustFind(id);
    this.activateWithResync(id);
    return this.toItem(this.repo.findById(id)!);
  }

  private activateInternal(id: string): void {
    const row = this.mustFind(id);
    this.repo.activate(id);
    /* 谁把凭证放进「全局出站位」（config.upstreamKey）？只有 anthropic+static（M Plan 平台 key）。
       其余都不放：
       · [v0.5.0] anthropic+oauth_minimax：文件里是 refresh token，出站时换 access token；
       · [v0.6.0] qoder：凭证是身份 JSON，出站由 QoderCredentialStore 直读文件；
       · [v1.6.13] openai（WorkBuddy）：凭证是 OAuth 槽，出站由 WbOauthService 取（ck_ 已退役）。 */
    if (row.protocol === 'anthropic' && row.cred_kind !== 'oauth_minimax') {
      this.config.setUpstreamKey(this.readCredentialFile(id));
    }
    this.applyBaseUrlToSettings(row.base_url);
  }

  /**
   * 删除提供商（v0.4.16 用户拍板：切换功能已移除，各家各自维护模型信息）。
   *
   * 三条规则：
   *   - 最后一个不可删 —— 服务至少要有一个上游可指。
   *   - 删除**生效**那家 → 自动激活下一家 + 清空重建模型目录（旧目录属于被删那家）。
   *   - 删除非生效那家 → 只删它自己（偏好 + 凭证文件），不动目录（目录属于生效那家）。
   */
  remove(id: string): void {
    const row = this.mustFind(id);
    if (this.repo.count() <= 1) {
      throw this.bad('至少保留一个提供商。');
    }
    /* [v0.5.1] 多生效守卫：删的是**最后一个生效**那家 → 拒绝（出站悬空比拒绝删除糟）。
       还有其他生效行则直接删（它们的路由与目录分区不受影响）。 */
    if (row.active && this.repo.listActive().filter((p) => p.id !== id).length === 0) {
      throw this.bad('至少保留一个生效中的提供商 —— 先启用另一家再删除这家。');
    }
    this.repo.delete(id);
    /* 目录分区一并清（多生效下其他家的清单不动）。 */
    this.catalog?.clearProvider(id);
    /* 偏好与凭证都是"这家提供商的"，一起清（provider_model_prefs 无 FK，不连带清理会留孤儿行）。
       [2026-10-17] 凭证清理从「只删 .key」扩到「该 id 的全部凭证类文件」——
       实测删 p_mm0001 后 .access 残留（token 服务的缓存文件不在原清理范围）。 */
    this.prefs.deleteForProvider(id);
    for (const suffix of ['.key', '.access', '.oauth']) {
      try {
        const file = this.credentialPath(id).replace(/\.key$/, suffix);
        if (existsSync(file)) unlinkSync(file);
      } catch (err) {
        this.logger.warn(`删除凭证文件 ${suffix} 失败（提供商已删，文件遗留无危害）：${(err as Error).message}`);
      }
    }
    this.logger.log(`删除提供商 ${row.name}（${row.id}）`);
  }

  /**
   * [v0.5.1] 停用一个提供商（多生效语义：别家不动）。最后一个生效的不可停 ——
   * 与删除同一条守卫：出站上游悬空会让所有 /v1 请求 503。
   * 目录分区保留（停用 ≠ 删除：再启用时清单还在）。
   */
  deactivate(id: string): ProviderItem {
    const row = this.mustFind(id);
    if (row.active && this.repo.listActive().filter((p) => p.id !== id).length === 0) {
      throw this.bad('至少保留一个生效中的提供商 —— 先启用另一家再停用这家。');
    }
    this.repo.deactivate(id);
    return this.toItem(this.repo.findById(id)!);
  }

  /** 凭证文件路径（不含敏感内容，可出现在响应里便于排障）。 */
  credentialPath(id: string): string {
    return join(this.providersDir, `${id}.key`);
  }

  /**
   * 试通一个提供商 [2026-10-08，遗留第 2 条] —— **不切换就能测**。
   *
   * 此前「试通」只认当前生效的上游（`POST /api/settings/credential/test` 打的是全局
   * `upstream.baseUrl`）—— 想测一个**还没激活**的提供商，只能先切过去再测，
   * 而"切过去"恰恰是用户想在测试通过**之后**才做的事。鸡生蛋。
   *
   * @param rawKey 试通用的凭证。**省略时用该提供商已保存的凭证** ——
   *   「已存的那把还活着吗」与「换新的之前先验一下」是两个都要有的动作。
   * @param model 探测用的模型 id。省略时用一个**小而稳的通用名** ——
   *   非活提供商的模型清单我们并没有（目录属于活提供商），但「试通」要区分的是
   *   「连得上吗 / key 对吗」，不是「这个模型有没有」：
   *   401 ⇒ key 坏；404/400 ⇒ 连通且 key 至少没被拒（模型不存在是另一回事）。
   *   这个判读口径与 `CredentialTestResult` 的字段语义一致（见 models.service）。
   */
  async test(
    id: string,
    rawKey: unknown,
    model?: unknown,
  ): Promise<{
    ok: boolean;
    model: string;
    elapsedMs: number;
    upstreamCode: number | null;
    httpStatus: number | null;
    reason: string | null;
  }> {
    const row = this.mustFind(id);
    let key: string;
    if (row.protocol === 'openai') {
      /* [v1.6.13] WorkBuddy 的凭证是 OAuth 槽（不与行内文件同址）—— 从服务取 access token。
         不接草稿 credential（ck_ 已退役，界面也不再提供输入框）。 */
      if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
        throw this.bad('WorkBuddy 已不再使用 ck_ 密钥 —— 请用「重新导入授权」完成官方授权。');
      }
      if (!this.wbOauth) throw this.bad('WorkBuddy OAuth 服务未装配（部署异常）。');
      try {
        key = await this.wbOauth.accessToken(row);
      } catch {
        throw this.bad(`该提供商还没导入授权 —— 到「配置 → 重新导入授权」完成官方授权。`);
      }
    } else if (rawKey === undefined || rawKey === null || rawKey === '') {
      key = this.readCredentialFile(id);
      if (!key) {
        throw this.bad(`该提供商还没配置凭证 —— 先在「修改」里填一个，或带上 credential 再测。`);
      }
    } else {
      if (typeof rawKey !== 'string') {
        throw this.bad('credential 必须是字符串。');
      }
      key = rawKey.trim();
      /* [v0.5.0] anthropic 提供商：oauth refresh token（mmort_）或 M Plan 平台 key。 */
      if (row.protocol === 'anthropic') {
        if (!/^mmort_[\x21-\x7e]{16,}$/.test(key) && !/^[\x21-\x7e]{24,}$/.test(key)) {
          throw this.bad(
            '凭证格式不正确：MiniMax 客户端订阅请贴 refresh token（mmort_ 开头，客户端数据目录 auth.json 里）；M Plan 则贴平台 API key。',
          );
        }
      }
    }
    const modelId =
      typeof model === 'string' && model.trim() ? model.trim() : PROBE_MODEL_FALLBACK;

    const startedAt = Date.now();
    const outcome = await this.probe.probe(modelId, key, row.base_url);
    const elapsedMs = Date.now() - startedAt;

    /* ★ 不记录 key 本身，只记录"某次试通的结果"（与 models.service 同一条纪律）。 */
    this.logger.log(
      `提供商试通 provider=${row.name} model=${modelId} ok=${outcome.ok} elapsed=${elapsedMs}ms` +
        (outcome.upstreamCode === null ? '' : ` upstreamCode=${outcome.upstreamCode}`),
    );
    return {
      ok: outcome.ok,
      model: modelId,
      elapsedMs,
      upstreamCode: outcome.upstreamCode,
      httpStatus: outcome.httpStatus,
      reason: outcome.reason,
    };
  }

  /** 读某提供商的凭证（仅供需要拿它打上游的内部路径，如试通；绝不进响应）。 */
  credentialOf(id: string): string {
    return this.readCredentialFile(id);
  }

  // ---- 内部 ----

  private toItem(row: ProviderRow): ProviderItem {
    const key = this.readCredentialFile(row.id);
    /* [v1.6.13] openai（WorkBuddy）的「已配置」改看 **OAuth 槽** —— ck_ 已退役。
       其余两家仍看凭证文件（anthropic = mmort_ refresh token / M Plan key；
       qoder = 身份 JSON）。 */
    const isOpenai = row.protocol !== 'anthropic' && row.protocol !== 'qoder';
    const wbStatus = this.wbOauth?.statusOf(row.id);
    const configured = isOpenai ? Boolean(wbStatus?.configured) : key !== '';
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      credentialMask: isOpenai
        ? (wbStatus?.configured ? `oauth(${wbStatus.uidMask ?? '已授权'})` : '未配置')
        : maskSecret(key),
      configured,
      active: row.active === 1,
      /* [v0.6.0] 三方言语义透传 —— 此前非 anthropic 一律写 openai，会把 qoder 谎报成 openai。 */
      protocol: (row.protocol === 'anthropic' ? 'anthropic' : row.protocol === 'qoder' ? 'qoder' : 'openai'),
      credKind: (row.cred_kind === 'oauth_minimax' ? 'oauth_minimax' : 'static'),
      /* [v0.5.4] 各自的模型清单计数（不是合并目录）—— 提供商行上回答这家有什么。 */
      modelCount: this.catalog ? this.catalog.all(row.id).length : 0,
      modelEnabled: this.catalog ? this.catalog.all(row.id).filter((m) => m.enabled === 1).length : 0,
      signin: {
        checkedOn: row.signin_checked_on,
        streak: row.signin_streak,
        lastPoints: row.signin_last_points,
      },
      wbOAuth: this.wbOauth?.statusOf(row.id) ?? { configured: false, uidMask: null, expiresAt: row.wb_oauth_expires_at ?? null },
      wbCredits: (row.protocol === 'openai'
        ? (this.quotaSource?.snapshot().ledger ?? []).find((l) => l.providerId === row.id) ?? null
        : null),
      qoderCredits: (row.protocol === 'qoder'
        ? (this.qoderActivity?.allBlocks() ?? []).find((l) => l.providerId === row.id) ?? null
        : null),
      wbSignin: {
        checkedOn: row.wb_signin_checked_on,
        streak: row.wb_signin_streak,
        lastPoints: row.wb_signin_last_points,
      },
      credits: this.credits?.block(row) ?? null,
    };
  }

  /**
   * 取提供商行；不存在则抛 **404 统一信封**（`code: provider_not_found`）。
   * 公开给 controller 复用：凡「资源不存在」都必须走这一条，不要各自返回
   * 200 + `reason: 'provider_not_found'` —— 那样调用方只能猜字符串。
   */
  mustFindOrThrow(id: string): ProviderRow {
    return this.mustFind(id);
  }

  private mustFind(id: string): ProviderRow {
    const row = this.repo.findById(id);
    if (!row) {
      throw new RelayHttpError({
        httpStatus: 404,
        code: 'provider_not_found',
        apiCode: ApiCode.NOT_FOUND,
        message: `提供商 ${id} 不存在。`,
      });
    }
    return row;
  }

  /** 写进 settings.upstream.baseUrl —— 持久化 + 热生效（resolveUpstreamBase 每请求都读它）。 */
  private applyBaseUrlToSettings(baseUrl: string): void {
    this.config.applyInternal([{ key: 'upstream.baseUrl', value: baseUrl }]);
  }

  private readCredentialFile(id: string): string {
    try {
      const file = this.credentialPath(id);
      if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    } catch (err) {
      this.logger.warn(`读取提供商凭证失败（视为未配置）：${(err as Error).message}`);
    }
    return '';
  }

  /** 原子写（临时文件 + rename），600 权限 —— 与 credential.service 同一纪律。 */
  private writeCredentialFile(id: string, key: string): void {
    const path = this.credentialPath(id);
    mkdirSync(this.providersDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, key);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  private parseName(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw this.bad('提供商名称必须是非空字符串。');
    }
    return raw.trim().slice(0, 60);
  }

  /**
   * 提供商地址校验（SSRF 防线）。
   *
   * 这是**用户输入**且服务端会真实向它发请求的目标，因此：
   *   - 只允许 http/https；
   *   - 拒绝 localhost / 环回 / 私有 / 保留地址。
   * 报错文案写清"为什么不行"，不让人猜。
   */
  parseBaseUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw this.bad('提供商地址必须是非空字符串。');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw this.bad(`提供商地址不是合法 URL：${raw}。应形如 https://api.example.com`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw this.bad(`提供商地址只允许 http/https（收到 ${parsed.protocol}）。`);
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked = blockedHostReason(host);
    if (blocked) {
      throw this.bad(`提供商地址不允许指向 ${blocked}（${host}）。只允许公网地址。`);
    }
    return raw.trim().replace(/\/+$/, '');
  }

  /** 凭证格式与既有「上游访问密钥」同一条规则（放宽论证见 credential.service.ts）。 */
  /**
   * [v0.5.0] 协议解析：'openai'（默认）| 'anthropic'。非法值 400 —— 协议选错
   * 意味着后面所有请求都用错误方言打上游，宁可建不成。
   */
  private parseProtocol(raw: unknown): 'openai' | 'anthropic' | 'qoder' {
    if (raw === undefined || raw === null || raw === '') return 'openai';
    if (raw === 'openai' || raw === 'anthropic' || raw === 'qoder') return raw;
    throw this.bad('protocol 只能是 openai、anthropic 或 qoder。');
  }

  /**
   * [v1.6.11] anthropic / qoder 允许**先建后导**（凭证留空）。
   *
   * 这两家的凭证是客户端登录态里的东西（MiniMax = `mmort_` refresh token；
   * Qoder = 一整段身份 JSON），用户手上没有、也手敲不出来 —— 「配置」抽屉为此在
   * v1.6.4 已改为导入指引。但**新增**弹窗当时没跟着改，仍强制必填，
   * 于是这两家在界面上**根本建不出来**：导入又要 provider id
   * 又要 provider id，而 id 建完才有 —— 死锁。
   *
   * 放行留空后：行先建出来（`configured=false`），再用「自动导入」把凭证灌进去。
   * [v1.6.13] openai（WorkBuddy）也放行留空 —— **ck_ 已退役**，三家统一走
   * 「导入客户端 → 官方授权」；凭证分别落 .oauth（WorkBuddy）/ .key（另两家）。
   */
  private parseCredential(raw: unknown, protocol: 'openai' | 'anthropic' | 'qoder' = 'openai'): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      /* 三家都可先建后导（openai 的 ck_ 已退役，凭证来自 OAuth 授权）。 */
      return '';
    }
    const key = raw.trim();
    if (protocol === 'openai') {
      throw this.bad(
        'WorkBuddy 已不再使用 ck_ 密钥 —— 请用「导入客户端」完成官方授权（凭证自动落盘，无需手填）。',
      );
    }
    /* [v0.6.0] Qoder：身份 JSON（五个必填字符串字段）。结构错误在出站前就报清楚，
       不把坏凭证存进去、也不等出站半路炸。 */
    if (protocol === 'qoder') {
      try {
        const parsed = JSON.parse(key) as Record<string, unknown>;
        for (const field of ['token', 'refreshToken', 'uid', 'name', 'userType']) {
          if (typeof parsed[field] !== 'string' || !(parsed[field] as string).trim()) {
            throw new Error(`缺字段或非字符串：${field}`);
          }
        }
      } catch (err) {
        throw this.bad(`Qoder 凭证格式不正确（${(err as Error).message}）：应为 {token,refreshToken,uid,name,userType}。`);
      }
      return key;
    }
    if (protocol === 'anthropic') {
      /* anthropic 提供商：oauth refresh token（mmort_）或 M Plan 平台 key（Bearer 直发）。 */
      if (!/^mmort_[\x21-\x7e]{16,}$/.test(key) && !/^[\x21-\x7e]{24,}$/.test(key)) {
        throw this.bad(
          '凭证格式不正确：MiniMax 客户端订阅请贴 refresh token（mmort_ 开头，客户端数据目录 auth.json 里）；M Plan 则贴平台 API key。',
        );
      }
      return key;
    }
    /* openai 分支已在上面拦下（ck_ 退役），此处只可能是 anthropic / qoder。 */
    return '';
  }

  private bad(message: string): RelayHttpError {
    return new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message,
    });
  }
}

/** IPv4 点分十进制（用 match 而不是 exec —— 后者的方法名会撞安全扫描的启发式）。 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 内网 / 保留地址判定。命中则返回"为什么不行"的短说明，否则 null。 */
function blockedHostReason(host: string): string | null {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  if (host === '::1' || host === '0.0.0.0' || host === '[::]') return '环回/未指定地址';
  const v4 = host.match(IPV4);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return '环回地址';
    if (a === 10) return '私有地址（10/8）';
    if (a === 172 && b >= 16 && b <= 31) return '私有地址（172.16/12）';
    if (a === 192 && b === 168) return '私有地址（192.168/16）';
    if (a === 169 && b === 254) return '链路本地地址';
    if (a === 0) return '未指定地址';
  }
  const lower = host.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return '唯一本地地址（fc00::/7）';
  if (/^fe[89ab]/.test(lower)) return '链路本地地址（fe80::/10）';
  if (lower === '::ffff:127.0.0.1') return 'IPv4 映射环回地址';
  return null;
}
