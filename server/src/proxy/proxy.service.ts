import { Injectable, Logger, Optional } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { RelayHttpError, ApiCode } from '../common/errors';
import { buildUpstreamHeaders } from './headers';
import { rewriteRequestBody } from './rewrite';
import { interpretUpstreamFailure, parseUpstreamFailure } from './pipeline';
import { ModelCatalogRepository } from '../store/repositories/model-catalog.repo';
import { ProxyLogger, rejectionNote, type StreamContext } from './proxy-log';
import { createReadGuard, readUpstreamSse } from './sse-stream';
import { capBody } from './body-capture';
import { upstreamFetch } from './upstream-fetch';
import { resolveConcurrencyLimit } from './concurrency';
import { buildChatCompletionsUrl, buildCustomChatUrl, stripTrailingSlash } from './upstream-url';
import { scopeAllowsModel, describeScope } from './model-scope';
import { toAnthropicRequest } from './anthropic-upstream/translate';
import { anthropicToOpenAiSse } from './anthropic-upstream/stream-decode';
import { MinimaxTokenService } from './anthropic-upstream/minimax-token.service';
import { toQoderRequest } from './qoder-upstream/translate';
import { qoderToOpenAiSse } from './qoder-upstream/stream-decode';
import { QoderCredentialStore } from './qoder-upstream/credential';
import { readCustomApiKey } from './custom-upstream/credential';
import { buildCosyBearer, cosyChatHeaders, qEncode, DEFAULT_QODER_CHAT_PATH } from './qoder-upstream/cosy';
import { ProvidersRepository, type ProviderRow } from '../store/repositories/providers.repo';
import { WbOauthService, wbOauthHeaders } from './openai-upstream/wb-oauth.service';
import { ChannelBreaker, BREAKER_THRESHOLD } from './channel-breaker';
import type { ChatChunk, ChatRequestBody } from './types';

/** 写回客户端的动作，由 controller 负责真正落到 reply 上（service 不碰 req/res）。 */
export type StreamEvent =
  /** `parsed`：与 `data` 等价的已解析对象（readUpstreamSse 已解析过一次）。下游聚合/编码直接用它，
      不必对同一帧再 JSON.parse 一遍；**只读**，不得修改（与 data 必须保持一致）。缺省时回落解析 data。 */
  | { type: 'chunk'; data: string; parsed?: ChatChunk }
  | { type: 'ping' }
  | { type: 'done' }
  | { type: 'error'; error: RelayHttpError };

/** 上游「渠道校验」拒绝业务码（system 提示命中模板指纹，见 probe/05-11128-fix-plan.md）。 */
const CHANNEL_REJECT_CODE = 11128;

/** L2 降级重试的 note 留痕（契约 §2.1.6 静态表）。 */
const SYSPROMPT_DEGRADED_NOTE = 'sysprompt_degraded_retry';

/** [v0.2.0 B5] 同一请求发生重试后的 note 留痕（激活契约里沉睡的 `retried` 口径）。 */
function markRetried(ctx: import('./proxy-log').StreamContext): void {
  if (!ctx.notes.includes('retried')) ctx.notes.push('retried');
}

/**
 * [v0.6.3] 把「已读出的第一块字节」塞回原流头部，返回等价的新流。
 *
 * 用途：`doCallQoder` 需要先读一块判「零内容断流」，但那一块**不能丢**（是首帧内容）。
 * 用 ReadableStream 重新包装：先吐缓存的块，再接力原 reader 的剩余部分；
 * 原流取消/出错时同步 cancel/error，语义与直接 pipe 一致。
 */
export function prependFirstChunk(body: ReadableStream<Uint8Array>, first: Uint8Array): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sentFirst = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(first);
        return;
      }
      try {
        const r = await reader.read();
        if (r.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(r.value);
      } catch (err) {
        reader.releaseLock();
        controller.error(err);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** [v0.5.0] anthropic 协议的默认聊天端点路径（MiniMax Code mavis 网关，来自官方开源 CLI）。 */
export const DEFAULT_ANTHROPIC_CHAT_PATH = '/mavis/api/v1/llm/v1/messages';

/**
 * [v0.5.0 / v0.6.1] anthropic（MiniMax Code）出站 UA。
 *
 * 取值依据（2026-10-11 实机取证 + 官方 CLI 0.6.8 源码）：
 *   · 官方 CLI（npm `@minimax-ai/code`）里唯一的 LLM UA 常量是字面量 `"MiniMaxCode"`
 *     （chunk-3FETZOUF.js：`Bi="MiniMaxCode"`，缺 UA 时由 `JO()` 注入）；
 *     LLM 客户端本身是标准 `@anthropic-ai/sdk`（头即 `x-api-key` + `anthropic-version`）。
 *   · 桌面客户端（3.1.1）的 `MiniMaxAgent Mozilla/5.0 …` 属于**平台 API 通道**
 *     （/v1/api/*、/matrix/*），与本反代的 mavis LLM 路径无关。
 * 此前写死的 `pi/2.0.0 (...)` 是从社区项目抄来、从未实测的形态 —— 实测网关不校验 UA
 * （数千请求全通过），但这不构成保留一个无依据值的理由。详见
 * design/ua-fingerprint-plan.md §1.1。
 */
const ANTHROPIC_OUT_UA = 'MiniMaxCode';

/*
 * [v0.5.11 曾考虑、验证后放弃] 模型 id 前缀 → 提供商亲和（`MiniMax-` 前缀固定优先
 * MiniMax Code）。实测**不需要**：两家目录的 id 集合**大小写敏感地不相交** ——
 * WorkBuddy 的转发名全是小写 `minimax-m2.5/m2.7/m3`（source=upstream），
 * MiniMax Code 的原生 id 全是大写 `MiniMax-M2.7/M3/M3.1-Flash-Preview`（seed）。
 * 路由第一轮是大小写敏感的精确匹配，天然把两家分开；v0.5.10 又删掉了会制造
 * 同 id 幽灵行的 observed 泄漏。**仅剩的旁路**：把 MiniMax 分区的某个模型在控制台
 * 停用后，第二轮大小写不敏感的模糊匹配会命中 WorkBuddy 的小写 id（吃到错误协议）。
 * 真出现那种需求再加前缀亲和不迟 —— 为不存在的冲突加规则，只会让路由更难推理。
 */

/** [v0.2.0 B7] 取证开关是否处于生效期（recordBodyUntil 为空 = 不限时）。 */
function bodyCaptureActive(logs: { recordBodyUntil?: number | null }): boolean {
  const until = logs.recordBodyUntil;
  return !(typeof until === 'number' && Number.isFinite(until) && Date.now() >= until);
}

export interface UpstreamStream {
  traceId: string;
  /** 上游 HTTP 状态（2xx 才继续读流）。 */
  status: number;
  upstreamCode: number | null;
  /** 上游可用时提供；否则为 null —— 失败行已在 service 内落库，调用方只负责回响应。 */
  events: AsyncGenerator<StreamEvent> | null;
  failure: RelayHttpError | null;
  model: string;
}

interface ActiveSlot {
  release: () => void;
}

/** 代理业务编排层：并发闸 / 调上游 / 映射错误。不接触 Fastify reply（SSE 写字节在 controller）；落库与积分在 ProxyLogger。 */
@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly log: ProxyLogger;
  private active = 0;
  /** [v0.6.0] Qoder 凭证与会话缓存。无依赖（只读数据目录），直接实例化 —— 不占 DI 装配，
      三个手动 new ProxyService 的 wiring spec 也不需要跟着改构造。 */
  private readonly qoderCredentials = new QoderCredentialStore();
  /** [v1.6.27] 11128 渠道熔断（内存态，按提供商；重启即重学，见 channel-breaker.ts）。 */
  private readonly channelBreaker = new ChannelBreaker();

  constructor(
    private readonly config: RelayConfigService,
    private readonly catalog: ModelCatalogRepository,
    log: ProxyLogger,
    /* [v0.5.0] 协议路由依赖。@Optional：三个 wiring spec 手动 new ProxyService(...)，
       不改它们的构造调用（openai 路径不碰这两个依赖，行为不变）。 */
    @Optional() private readonly providers?: ProvidersRepository,
    @Optional() private readonly minimaxTokens?: MinimaxTokenService,
    /* [v1.6.13] WorkBuddy OAuth 令牌（openai 转发凭证）。@Optional：三个 wiring spec
       手动 new ProxyService(...)，不改它们的构造调用（openai 路径缺失时会明确报错）。 */
    @Optional() private readonly wbOauth?: WbOauthService,
  ) {
    this.log = log;
  }

  get activeCount(): number {
    return this.active;
  }

  /** 并发占用 / 上限快照，供 `/api/overview` 暴露（让槽位泄漏等失败状态可见；task#37）。 */
  stats(): { active: number; limit: number } {
    return { active: this.active, limit: resolveConcurrencyLimit(this.config) };
  }

  /** 并发闸：满了抛 429，**不排队**。 */
  private acquireSlot(): ActiveSlot {
    const limit = resolveConcurrencyLimit(this.config);
    if (this.active >= limit) {
      throw new RelayHttpError({
        httpStatus: 429,
        code: 'rate_limited',
        apiCode: ApiCode.RATE_LIMITED,
        message: `本机同时转发上限为 ${limit}，当前已满。请稍后重试或调低客户端并发。`,
        headers: { 'retry-after': '1' },
      });
    }
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }

  /**
   * 解析模型：命中则标记；未命中抛 400（不转发），并列出可选 id 供客户端纠正。
   * 传入 ctx 时命中即回填 `modelId`/`modelDisplay` ——「解析之后才抛」的越权/下架（403）
   * 失败行也能带上模型，「解析之前」的失败行保持为空（不编造）。
   *
   * [2026-10-08 补齐] **密钥权限范围（`key.scope`）在这里第一次真正生效。**
   * 契约 §2.1.2 第 3 步早就写着「命中后校验 key.scope；越权 403 model_not_allowed」，
   * 而实现里没有任何一处读过它 —— 界面上写着「仅 kimi 系」的密钥实际能调任何模型。
   * 判定规则见 `model-scope.ts`（纯函数，独立单测）。
   *
   * 顺序（相对既有两条检查）刻意如此：
   *   ① 未命中 400（模型不存在）→ ② 已下架 403（全局状态）→ ③ 越权 403（这把密钥）
   * 先报全局、再报个体：一个已下架的模型对**所有**密钥都不可用，
   * 先提示"越权"会把用户引去改密钥权限，而真正该做的是换个模型。
   */
  /**
   * [v0.5.1] 模型解析 = **路由**：在全部已启用提供商的目录并集里找模型，
   * 同一模型存在于多家时按「密钥绑定的优先级链 → 提供商创建序」取首家。
   *
   * 返回路由结果（提供商 + 模型行）。判定顺序沿用旧版：
   *   ① 找不到 → 400 model_not_found（并集里列可用模型）
   *   ② 找到但所有候选都被下架 → 403 model_not_allowed
   *   ③ ctx 回填（失败行也要带模型，否则排障无从下手）
   *   ④ 密钥 scope 判定 → 403
   */
  private resolveRoute(
    input: string,
    keyClients: string[] | null,
    ctx?: StreamContext,
  ): { provider: ProviderRow; id: string; displayName: string } {
    if (typeof input !== 'string' || !input.trim()) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'messages 与 model 为必填项，model 不能为空。',
      });
    }
    /* 候选提供商顺序：密钥优先级链（绑定名的启用户）在前，其余启用户按创建序垫后。 */
    const actives = this.providers?.listActive() ?? [];
    if (actives.length === 0) {
      throw new RelayHttpError({
        httpStatus: 503,
        code: 'no_active_provider',
        apiCode: ApiCode.INTERNAL,
        message: '没有生效中的提供商 —— 到「提供商管理」启用至少一家。',
      });
    }
    /* [2026-10-17] 绑定值改为**双匹配**：新绑定存提供商 ID（唯一，删除重建同名不会错绑——
       用户报告：删 MiniMax Code 后重建同名，密钥仍绑定旧名 = 名字碰撞）。旧数据存的是
       名字，按名兜底。两者共用同一条优先链语义（只排序，不过滤）。 */
    const bindById = new Map(actives.map((p) => [p.id, p]));
    const byName = new Map(actives.map((p) => [p.name, p]));
    const resolveBinding = (v: string): ProviderRow | undefined => bindById.get(v) ?? byName.get(v);
    const trimmed = input.trim();
    const ordered = [
      ...(keyClients ?? []).map((v) => resolveBinding(v)).filter((p): p is ProviderRow => p !== undefined),
      ...actives.filter((p) => {
        const binds = keyClients ?? [];
        return !binds.includes(p.id) && !binds.includes(p.name);
      }),
    ];

    /* ★ 两轮解析（跨全部候选，不是单家内部）：
       第一轮全集合**精确 id**（大小写敏感）—— 多提供商同存时 `MiniMax-M3`
       （mavis 官方 id）与 `minimax-m3`（WorkBuddy 转发名）在不同分区并存，精确必须先于
       一切模糊匹配，否则创建序在前的分区会把别人的模型"抢"走（生产实测踩过）。
       第二轮按序逐家做大小写不敏感/显示名/规范化匹配。

       [v1.5.0] observed 机制已废除（目录 = 接口清单，见 catalog-sync.ts）——
       下面的 observed 分组过滤是历史防御的保留（该 source 已不可能入库，恒空）；
       保留它不改变行为，也避免未来若有人重新引入同类机制时无声退化。 */
    const ids = ordered.map((p) => p.id);
    const byId = new Map(ordered.map((p) => [p.id, p]));
    const exactAll = this.catalog.resolveExactAllAcross(trimmed, ids);
    const attempts = [
      ...exactAll.filter((c) => c.row.source !== 'observed'),
      ...exactAll.filter((c) => c.row.source === 'observed'),
      ...(() => {
        for (const provider of ordered) {
          const found = this.catalog.resolveAcross(trimmed, [provider.id]);
          if (found.length > 0) return found;
        }
        return [];
      })(),
    ];

    let hit: { provider: ProviderRow; row: NonNullable<ReturnType<ModelCatalogRepository['findById']>> } | null = null;
    let disabledRow: { provider: ProviderRow; row: NonNullable<ReturnType<ModelCatalogRepository['findById']>> } | null = null;
    for (const candidate of attempts) {
      const provider = byId.get(candidate.providerId);
      if (!provider) continue;
      const row = candidate.row;
      if (row.enabled !== 1) {
        disabledRow = disabledRow ?? { provider, row }; // 记住首个命中（下架也要带上模型落库）
        continue; // 这家下架了 —— 继续看别家有没有
      }
      hit = { provider, row };
      break;
    }
    if (!hit) {
      if (disabledRow) {
        /* 失败行也要带模型（AC-F04 的口径）：先回填 ctx 再抛。 */
        if (ctx) {
          ctx.modelId = disabledRow.row.id;
          ctx.modelDisplay = disabledRow.row.display_name;
          /* 下架模型：本请求被拒、没有真实承接方 —— **不写 provider**，
             让统计按「未归属」处理，而不是把一次没发生的路由算到某家头上。 */
        }
        throw new RelayHttpError({
          httpStatus: 403,
          code: 'model_not_allowed',
          apiCode: ApiCode.FORBIDDEN,
          message: `模型 ${disabledRow.row.id} 已在控制台下架。`,
        });
      }
      const available = [
        ...new Set(
          actives.flatMap((p) =>
            this.catalog.all(p.id).filter((m) => m.enabled === 1).map((m) => m.id),
          ),
        ),
      ].join('、');
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'model_not_found',
        apiCode: ApiCode.BAD_PARAM,
        message: `模型 "${input}" 既不是 API ID 也匹配不到显示名。当前可用：${available}`,
      });
    }
    const { provider, row } = hit;
    if (ctx) {
      ctx.modelId = row.id;
      ctx.modelDisplay = row.display_name;
      /* [v1.6.30] 记录**实际路由到的**提供商 —— 归属统计必须读它，不能事后
         按目录反解（同一 model id 可能存在于多家，反解按创建序会挑错那家）。 */
      ctx.providerId = provider.id;
    }
    /* 密钥权限范围判定。放在 `enabled` 之后（见上面的顺序说明），
       且**必须在 ctx 回填之后** —— 这一支抛错也要让失败行带上模型，
       否则日志里只看到一条「403 但没有模型」的记录，排障时无从判断是哪个模型被挡。 */
    const scope = ctx?.keyContext?.scope;
    if (!scopeAllowsModel(scope, row)) {
      throw new RelayHttpError({
        httpStatus: 403,
        code: 'model_not_allowed',
        apiCode: ApiCode.FORBIDDEN,
        // 文案要能直接回答「那我该用什么」：把本密钥的范围与模型所属的系/标签都写出来。
        message:
          `这把密钥的权限范围是「${describeScope(scope)}」，不能使用模型 ${row.id}` +
          `（${row.family} 系${row.tag ? ` · ${row.tag}` : ''}）。请改用范围内的模型，或新建一把范围合适的密钥。`,
      });
    }
    return { provider, id: row.id, displayName: row.display_name };
  }

  /**
   * [v1.6.13] WorkBuddy 出站头（OAuth 形态）—— ck_ 退役后的转发凭证。
   *
   * 与旧 `buildUpstreamHeaders` + ck_ 的差异：令牌来自 `WbOauthService`（按需刷新），
   * 并在指纹头之外补账号级设备头（x-user-id / x-machine-id / x-session-id，按 uid
   * 稳定派生）—— 与独立版 wb 工具的 `authedHeaders` 同一形态（那边已在生产验证）。
   *
   * 未导入授权时**不回落**任何全局密钥，直接报错并指引「重新导入授权」（用户口径）。
   */
  private async buildWorkBuddyHeaders(
    ctx: StreamContext,
    provider: ProviderRow,
    incomingHeaders: Record<string, string | string[] | undefined>,
    cfg: ReturnType<RelayConfigService['get']>,
    slot: ActiveSlot,
  ): Promise<{ headers: Record<string, string> } | { error: UpstreamStream }> {
    if (!this.wbOauth) {
      slot.release();
      return {
        error: this.fail(ctx, new RelayHttpError({
          httpStatus: 500, code: 'internal_error', message: 'WorkBuddy OAuth 服务未装配（部署异常）。',
        }), 'wb oauth unavailable'),
      };
    }
    let token: string;
    try {
      token = await this.wbOauth.accessToken(provider);
    } catch (err) {
      slot.release();
      const missing = !this.wbOauth.credentialSnapshot(provider.id);
      return {
        error: this.fail(ctx, new RelayHttpError({
          httpStatus: 502,
          code: 'upstream_credential_invalid',
          message: missing
            ? `提供商 ${provider.name} 未导入授权 —— 到「提供商管理 → 重新导入授权」完成官方授权。`
            : `获取 WorkBuddy access token 失败：${(err as Error).message}`,
        }), missing ? 'missing wb oauth credential' : 'wb token refresh failed'),
      };
    }
    const snapshot = this.wbOauth.credentialSnapshot(provider.id);
    const cred = { accessToken: token, refreshToken: '', uid: snapshot?.uid ?? '', deviceToken: snapshot?.deviceToken };
    /* 入站 allowlist 透传（UA/accept 等）后叠加 OAuth 头族 —— 与旧路径同一纪律：
       本机密钥绝不外泄（wbOauthHeaders 只放上游令牌）。 */
    const { headers } = buildUpstreamHeaders(incomingHeaders, token, cfg.upstream.spoofUA, cfg.upstream.userAgent);
    const wb = wbOauthHeaders(cred, token);
    delete (wb as Record<string, string>)['content-type'];
    delete (wb as Record<string, string>)['x-requested-with'];
    Object.assign(headers, wb);
    if (cred.uid) headers['x-user-id'] = cred.uid;
    return { headers };
  }

  /** 兼容旧调用形状（测试/探测用）：只取模型 id 与显示名，不关心路由到哪家。 */
  resolveModel(input: string, ctx?: StreamContext): { id: string; displayName: string } {
    const r = this.resolveRoute(input, ctx?.keyContext?.clients ?? null, ctx);
    return { id: r.id, displayName: r.displayName };
  }

  /** 校验入站请求体结构（api-contract §2.1.1）。 */
  assertBodyShape(body: ChatRequestBody | undefined): asserts body is ChatRequestBody {
    if (!body || typeof body !== 'object') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: '请求体必须是 JSON 对象。',
      });
    }
    if (!Array.isArray(body.messages)) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'messages 字段缺失或不是数组。',
      });
    }
  }

  /** 记录「发生在 service 之外」的本地拒绝（body 形状 / 越权 / 并发闸）。`fail()` 负责
   *  service 内 return 的失败，两处不重叠、不会重复计行。 */
  logRejection(ctx: StreamContext, err: RelayHttpError): void {
    // trace 对齐客户端可见的 x-trace-id，用户才能拿它到日志里找到这一行
    this.log.persistFailure(
      { ...ctx, traceId: err.traceId },
      {
        status: err.httpStatus,
        upstreamCode: err.upstreamCode,
        note: rejectionNote(err),
        model: ctx.modelId || null,
        modelDisplay: ctx.modelDisplay || null,
        // 本地拒绝：请求根本没到上游 ⇒ 未消耗是**事实**（不是估算），记 0。
        credits: 0,
      },
    );
  }

  /** 发起上游调用。上游非 2xx 时不抛异常，把失败放进返回值交由 controller 处理。 */
  async callUpstream(
    ctx: StreamContext,
    incomingHeaders: Record<string, string | string[] | undefined>,
    body: ChatRequestBody,
  ): Promise<UpstreamStream> {
    const cfg = this.config.get();
    const slot = this.acquireSlot(); // 满了立即抛 429（由 controller 落库）
    ctx.release = () => slot.release();
    try {
      return await this.doCall(ctx, incomingHeaders, body, cfg, slot);
    } catch (err) {
      slot.release();
      throw err; // 本地拒绝（模型越权等）→ controller catch 落库
    }
  }

  private async doCall(
    ctx: StreamContext,
    incomingHeaders: Record<string, string | string[] | undefined>,
    body: ChatRequestBody,
    cfg: ReturnType<RelayConfigService['get']>,
    slot: ActiveSlot,
  ): Promise<UpstreamStream> {
    /* [v0.5.1] 路由驱动：协议由**路由到的提供商**决定（不再看全局唯一活行）。
       [v1.7.0] 路由提到**改写之前**：custom 出站要的是客户端原文 —— prompt 重写
       （中性 system 注入）是 WorkBuddy 指纹对抗的手段，对通用 OpenAI 端点只会
       污染用户的对话。先路由、按方言决定改不改，三家内置路径行为不变。 */
    const routed = this.resolveRoute(body.model, ctx.keyContext?.clients ?? null, ctx);
    if (routed.provider.protocol === 'custom') {
      return await this.doCallCustom(ctx, body, cfg, slot, routed.provider, routed.id);
    }

    const rewritten = rewriteRequestBody(body, {
      promptRewrite: cfg.upstream.promptRewrite,
      neutralPrompt: cfg.upstream.defaultSystemPrompt || undefined,
    });
    ctx.notes = [...rewritten.notes];

    if (routed.provider.protocol === 'anthropic') {
      return await this.doCallAnthropic(ctx, body, rewritten.body, cfg, slot, routed.provider);
    }
    /* [v0.6.0] Qoder CN 网关（COSY 协议）—— 第三种出站方言。 */
    if (routed.provider.protocol === 'qoder') {
      return await this.doCallQoder(ctx, body, rewritten.body, cfg, slot, routed.provider);
    }

    /* [v1.6.13] openai（WorkBuddy）转发改走 **OAuth** —— ck_ 已退役。
       令牌与账号级设备头由 WbOauthService 维护（与独立版 wb 工具同一形态）：
       access token 按需刷新，machine/session id 按 uid 稳定派生。 */
    /* [v1.6.27] 11128 渠道熔断闸：阵发期（见 channel-breaker.ts 头注）快速失败。
       放在并发槽语义之后、发请求之前 —— 槽在 callUpstream 已取得，这里立即释放，
       净占用微秒级；快速失败行不带上游业务码（上游根本没回，守反代保真铁律）。 */
    const breakerRemainMs = this.channelBreaker.blocked(routed.provider.id);
    if (breakerRemainMs !== null) {
      slot.release();
      const retryAfterSec = Math.max(1, Math.ceil(breakerRemainMs / 1000));
      return this.fail(
        ctx,
        new RelayHttpError({
          httpStatus: 502,
          code: 'upstream_channel_blocked',
          message:
            `上游渠道校验持续拒绝（11128 阵发），已启用熔断保护：预计约 ${retryAfterSec} 秒后自动放行探测请求，` +
            '无需改动任何配置，请稍后重试。',
          headers: { 'retry-after': String(retryAfterSec) },
        }),
        'breaker_open',
      );
    }
    const wbHeaders = await this.buildWorkBuddyHeaders(ctx, routed.provider, incomingHeaders, cfg, slot);
    if ('error' in wbHeaders) return wbHeaders.error;
    const headers = wbHeaders.headers;
    headers['x-request-id'] = ctx.traceId;
    headers['accept'] = 'text/event-stream';

    // 上游地址按路由到的提供商（[v0.5.1] 多生效：不再读全局设置项）。
    const url = buildChatCompletionsUrl(stripTrailingSlash(routed.provider.base_url));
    // ★ A3：仅在开关打开**且未过期**时记录**客户端原始请求体**（改写前）；写库前截断在 ProxyLogger。
    //   [v0.2.0 B7] recordBodyUntil 是「一键取证」的服务端自动过期闸：开启时带一个未来时间戳，
    //   到点后即使忘了关也不会继续把对话内容写进本地库（隐私兜底）。
    // 取证时立即截断（与落库同一 capBody，幂等）：避免整段长上下文在流式期间常驻内存
    if (cfg.logs?.recordRequestBody && bodyCaptureActive(cfg.logs)) ctx.requestBody = capBody(JSON.stringify(body));
    // 发往上游的体另算（含本服务补的 system 等改写），与「记录请求体」是两回事。
    const payload = JSON.stringify(rewritten.body);

    /** 同参重发（重试共用同一 headers/payload/超时；slot 由外层 finally 语义释放）。
     *  ★ 超时语义（2026-10-08 修复）：signal 来自 ReadGuard —— 只约束「发请求 →
     *    首个数据帧」（limits.firstByteTimeoutMs），此后转为空闲看门狗（sse-stream.ts）。
     *    此前挂 `AbortSignal.timeout` 是全程超时：>30s 的流式响应（agent 工具调用常态）
     *    一律在 30s 被我们自己掐断（生产实测 30009ms 必死，note=stream_abort）。
     *    重试（11133/降级）共用同一 guard：首字时限跨尝试累计，不会因重试白得新额度。 */
    const guard = createReadGuard(cfg.limits.firstByteTimeoutMs || 30_000);
    const send = () =>
      upstreamFetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: guard.signal,
      });

    let res: Response;
    try {
      /* [DEBUG v0.4.17] 生产排查：fetch 前后打点（用户报 30s 超时但直测正常，
         需要看到代理进程内 fetch 的实际 URL/体量/信号状态/耗时）。
         性能：降为 debug 级 —— main.ts 的日志级别只开 warn/error/log，默认不输出；
         原先每个请求两行 stdout 同步写（journald 管道下是同步 IO）。排障时把 'debug' 加进 logger 级别即可。 */
      const __t0 = Date.now();
      this.logger.debug(`PROXY-DEBUG fetch start trace=${ctx.traceId} url=${url} bodyLen=${payload.length} signalAborted=${guard.signal.aborted} ua=${headers['user-agent']}`);
      res = await send();
      this.logger.debug(`PROXY-DEBUG fetch done trace=${ctx.traceId} status=${res.status} elapsed=${Date.now() - __t0}ms`);
    } catch (err) {
      slot.release();
      this.logger.error(
        `上游不可达 trace=${ctx.traceId}: ${(err as Error).message} ` +
          `name=${(err as Error).name} cause=${String((err as Error).cause ?? 'none')}`,
      );
      return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
    }

    // ★ [v0.2.0 B5] 11133 瞬时 400 幂等重试：社区实测该码是网关偶发抖动（[1s,4s,10s,25s] 阶梯），
    //   同 payload 重发即过。这里取阶梯前两档（最多 2 次，总等待 5s 封顶）——自用场景里
    //   更长的阶梯会占住并发槽、拖高客户端时延，收益却递减。每次重发计 ctx.retries 并留 retried note。
    const TRANSIENT_400_DELAYS_MS = [1_000, 4_000];
    /* ★ [2026-10-12 生产事故] **上游失败体只准读一次**（Response.body 是单向流，读过即枯）。
       此前这里是「11133 探测先 `res.text()`，随后失败分支再 `res.text()` 一次」：真实 fetch 下
       第二次抛 `TypeError: Body is unusable`，被 `.catch(() => '')` 静默吞成空串，
       → 业务码恒为 null → 落到 `mapUpstreamHttpStatus(400)` 的「未预期状态码 400」兜底。
       生产表现（trace 409d1efa…）：上游明明回的是
       `{"code":11115,"msg":"prompt is too long: 1266460 tokens > 1048576 maximum"}`，
       日志、审计行的 upstream_code 与给客户端的 message 里却一个数都没有，排障只能看到「400」。
       单测没抓到是因为 mock 的 `text()` 可重复读（真 Response 不行）—— 已同步把 mock 改成
       忠实的一次性读取，见 proxy-failure-wire.spec.ts。 */
    let rawFailureBody: string | null = res.ok ? null : await res.text().catch(() => '');
    if (!res.ok) {
      for (let attempt = 0; attempt < TRANSIENT_400_DELAYS_MS.length; attempt += 1) {
        if (parseUpstreamFailure(res.status, rawFailureBody ?? '').businessCode !== 11133) break;
        this.logger.warn(`上游 11133 瞬时抖动，${TRANSIENT_400_DELAYS_MS[attempt]}ms 后幂等重试 trace=${ctx.traceId}`);
        await new Promise((r) => setTimeout(r, TRANSIENT_400_DELAYS_MS[attempt]));
        ctx.retries += 1;
        markRetried(ctx);
        try {
          res = await send();
        } catch (err) {
          slot.release();
          this.logger.error(`上游不可达（11133 重试）trace=${ctx.traceId}: ${(err as Error).message}`);
          return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
        }
        if (res.ok) break;
        // 重发是**新的** Response，重新读一次（仍只读一次）。
        rawFailureBody = await res.text().catch(() => '');
      }
    }

    if (!res.ok) {
      let raw = rawFailureBody ?? '';
      // ★ L2 fail-open（2026-10-07）：上游渠道校验拒绝（11128）→ 以 neutral 档降级重试一次。
      //    此时还没向客户端写过任何字节（fetch 响应阶段，早于 SSE 转发），重试无副作用。
      //    兜的是「L1 规则表漏掉上游新增指纹变体」的失效模式（社区 workbuddy2api-panel
      //    的降级重试同型实践）；仅重试一次，靠 note 防循环。重试成功则落入正常流式路径。
      if (
        parseUpstreamFailure(res.status, raw).businessCode === CHANNEL_REJECT_CODE &&
        cfg.upstream.promptRewrite !== 'off' &&
        !ctx.notes.includes(SYSPROMPT_DEGRADED_NOTE)
      ) {
        ctx.notes.push(SYSPROMPT_DEGRADED_NOTE);
        ctx.retries += 1;
        markRetried(ctx);
        const degraded = rewriteRequestBody(body, {
          promptRewrite: 'neutral',
          neutralPrompt: cfg.upstream.defaultSystemPrompt || undefined,
        });
        try {
          res = await upstreamFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(degraded.body),
            signal: guard.signal, // 与首发共用同一 ReadGuard（首字时限跨尝试累计）
          });
        } catch (err) {
          slot.release();
          this.logger.error(`上游不可达（降级重试）trace=${ctx.traceId}: ${(err as Error).message}`);
          return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
        }
        if (!res.ok) raw = await res.text().catch(() => '');
      }
      if (!res.ok) {
        slot.release();
        const failure = interpretUpstreamFailure(parseUpstreamFailure(res.status, raw));
        this.applyModelSideEffect(failure.upstreamCode, routed.provider.id, routed.id);
        /* [v1.6.27] 熔断计数只在「渠道级」信号上：降级重试（中性提示）也是 11128 才算 ——
           只拦下模板改写、降级能过的属于内容级问题，计入会把一个客户端的请求特征
           变成全提供商的闸门。反之任何非 11128 的业务失败（校验链路已工作到深层，
           如 11115）与成功一样视为渠道健康，全复位。 */
        if (failure.upstreamCode === CHANNEL_REJECT_CODE) {
          if (ctx.notes.includes(SYSPROMPT_DEGRADED_NOTE)) {
            const t = this.channelBreaker.recordChannelRejection(routed.provider.id);
            if (t.opened) {
              this.logger.warn(
                `11128 渠道熔断开闸：provider=${routed.provider.name} 连续${BREAKER_THRESHOLD}次渠道级拒绝，` +
                  `冷却 ${Math.round(t.cooldownMs / 1000)}s（第 ${t.opens} 次开闸）`,
              );
            }
          }
          // 未带降级标记的 11128（rewrite=off 或降级前的首败）：不计入也不复位 ——
          // 它区分不了内容级/渠道级，对熔断状态没有信息量。
        } else if (failure.upstreamCode !== null) {
          this.channelBreaker.recordHealthy(routed.provider.id);
        }
        return this.fail(ctx, failure, failure.code);
      }
    }

    if (!res.body) {
      slot.release();
      return this.fail(
        ctx,
        new RelayHttpError({
          httpStatus: 502,
          code: 'upstream_error',
          apiCode: ApiCode.INTERNAL,
          message: '上游返回 200 但响应体为空，无法读取流。',
        }),
        'upstream empty body',
      );
    }

    /* 上游接受了本次请求（含降级重试后被接受）= 渠道健康，熔断状态全复位。 */
    this.channelBreaker.recordHealthy(routed.provider.id);

    return {
      traceId: ctx.traceId,
      status: 200,
      upstreamCode: null,
      // guard 随流移交：readUpstreamSse 收到首个数据帧后解除首字超时，流式期间仅受
      // 空闲看门狗约束 —— 总时长不再有上限（长回答/长思考是常态，不是异常）。
      events: readUpstreamSse(res.body, ctx, this.log, cfg.logs?.recordResponseBody === true, guard),
      failure: null,
      model: routed.id,
    };
  }

  /**
   * [v0.5.0] anthropic 协议路径（mavis / Anthropic 兼容上游）。
   *
   * 与 openai 路径的差异全在"方言"：请求体 OpenAI→Anthropic、响应流 Anthropic→OpenAI
   * （TransformStream 喂给同一个 readUpstreamSse —— 看门狗/聚合/落库/断流判定全部复用）、
   * 鉴权 Bearer（oauth 提供商按需刷新 access token）、无客户端指纹头（实测网关不校验）。
   * 没有 WorkBuddy 的 11133/11128 方言怪癖，重试逻辑不需要。
   */
  private async doCallAnthropic(
    ctx: StreamContext,
    originalBody: ChatRequestBody,
    rewrittenBody: ChatRequestBody,
    cfg: ReturnType<RelayConfigService['get']>,
    slot: ActiveSlot,
    provider: ProviderRow,
  ): Promise<UpstreamStream> {
    /* 凭证：oauth_minimax 按需刷新；static（如 M Plan 的平台 key）读全局凭证位
       （单活跃模型下 activate 已把它写进 config.upstreamKey）。 */
    let credential: string;
    if (provider.cred_kind === 'oauth_minimax') {
      if (!this.minimaxTokens) {
        slot.release();
        return this.fail(ctx, new RelayHttpError({
          httpStatus: 500, code: 'internal_error', message: 'oauth 凭证服务未装配（部署异常）。',
        }), 'minimax tokens unavailable');
      }
      try {
        credential = await this.minimaxTokens.accessToken(provider);
      } catch (err) {
        slot.release();
        return this.fail(ctx, err instanceof RelayHttpError ? err : new RelayHttpError({
          httpStatus: 502, code: 'upstream_credential_invalid',
          message: `获取 MiniMax access token 失败：${(err as Error).message}`,
        }), 'token refresh failed');
      }
    } else {
      credential = this.config.upstreamKey;
      if (!credential) {
        slot.release();
        return this.fail(ctx, new RelayHttpError({
          httpStatus: 502, code: 'upstream_credential_invalid',
          message: `提供商 ${provider.name} 未配置凭证。`,
        }), 'missing credential');
      }
    }

    const url = `${stripTrailingSlash(provider.base_url)}${provider.chat_path ?? DEFAULT_ANTHROPIC_CHAT_PATH}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'user-agent': ANTHROPIC_OUT_UA,
      'x-request-id': ctx.traceId,
    };

    if (cfg.logs?.recordRequestBody && bodyCaptureActive(cfg.logs)) ctx.requestBody = capBody(JSON.stringify(originalBody));
    const payload = JSON.stringify(toAnthropicRequest(rewrittenBody));

    const guard = createReadGuard(cfg.limits.firstByteTimeoutMs || 30_000);
    let res: Response;
    try {
      res = await upstreamFetch(url, { method: 'POST', headers, body: payload, signal: guard.signal });
    } catch (err) {
      slot.release();
      this.logger.error(`上游不可达（anthropic）trace=${ctx.traceId}: ${(err as Error).message}`);
      return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
    }
    if (!res.ok) {
      slot.release();
      const raw = await res.text().catch(() => '');
      const failure = parseUpstreamFailure(res.status, raw);
      let upstreamMsg = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
        upstreamMsg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? upstreamMsg;
      } catch { /* 非 JSON 原样截断 */ }
      return this.fail(ctx, new RelayHttpError({
        httpStatus: res.status === 401 || res.status === 403 ? 502 : 502,
        code: res.status === 401 || res.status === 403 ? 'upstream_credential_invalid' : 'upstream_error',
        // [2026-10-12] 上游若仍带 5 位业务码就落进审计列（MiniMax 通常不带，为 null 即「无码」）；
        // 以前这里恒写 null，等于把上游可能给的码直接丢掉。
        upstreamCode: failure.businessCode,
        message: `上游（${provider.name}）HTTP ${res.status}：${upstreamMsg || '无响应体'}`,
      }), `anthropic upstream ${res.status}`);
    }
    if (!res.body) {
      slot.release();
      return this.fail(ctx, new RelayHttpError({
        httpStatus: 502, code: 'upstream_error',
        message: '上游返回 200 但响应体为空，无法读取流。',
      }), 'upstream empty body');
    }

    return {
      traceId: ctx.traceId,
      status: 200,
      upstreamCode: null,
      /* 响应流经 TransformStream 折成 OpenAI SSE 后进 readUpstreamSse：
         首字超时/看门狗/聚合/落库/断流语义与 openai 路径完全一致。 */
      events: readUpstreamSse(
        res.body.pipeThrough(anthropicToOpenAiSse()),
        ctx,
        this.log,
        cfg.logs?.recordResponseBody === true,
        guard,
      ),
      failure: null,
      model: ctx.modelId ?? '',
    };
  }

  /**
   * [v1.7.0] 自定义提供商出站（OpenAI 兼容方言，protocol='custom'）。
   *
   * 与内置三家的差异全在「**没有**上游特化」：
   *   · 凭证：本行 `.key` 里的静态 API key，`Authorization: Bearer` 直发；
   *   · 请求体：客户端原文透传 —— **不做 prompt 重写**（那是 WorkBuddy 指纹对抗）；
   *   · **没有** 11133/11128 重试梯与渠道熔断（通用端点不会发 111xx 业务码）；
   *   · **没有**指纹 UA / 设备头（undici 默认 UA）。
   *
   * 复用的部分（与 openai 路径同源）：URL 智能解析（buildCustomChatUrl）、首字
   * ReadGuard、并发槽、readUpstreamSse（OpenAI SSE 形状原样进）。
   */
  private async doCallCustom(
    ctx: StreamContext,
    body: ChatRequestBody,
    cfg: ReturnType<RelayConfigService['get']>,
    slot: ActiveSlot,
    provider: ProviderRow,
    modelId: string,
  ): Promise<UpstreamStream> {
    let credential: string;
    try {
      credential = readCustomApiKey(provider.id);
    } catch (err) {
      slot.release();
      return this.fail(ctx, new RelayHttpError({
        httpStatus: 502, code: 'upstream_credential_invalid',
        message: `提供商 ${provider.name} 的凭证不可用：${(err as Error).message}`,
      }), 'missing custom api key');
    }

    const url = buildCustomChatUrl(provider.base_url, provider.chat_path);
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-request-id': ctx.traceId,
    };

    if (cfg.logs?.recordRequestBody && bodyCaptureActive(cfg.logs)) ctx.requestBody = capBody(JSON.stringify(body));
    const payload = JSON.stringify(body);

    const guard = createReadGuard(cfg.limits.firstByteTimeoutMs || 30_000);
    let res: Response;
    try {
      res = await upstreamFetch(url, { method: 'POST', headers, body: payload, signal: guard.signal });
    } catch (err) {
      slot.release();
      this.logger.error(`上游不可达（custom）trace=${ctx.traceId} url=${url}: ${(err as Error).message}`);
      return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
    }
    if (!res.ok) {
      slot.release();
      /* 失败体只读一次（同 openai 路径的教训）：先 text() 再解析。 */
      const raw = await res.text().catch(() => '');
      const failure = parseUpstreamFailure(res.status, raw);
      let upstreamMsg = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
        upstreamMsg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? upstreamMsg;
      } catch { /* 非 JSON 原样截断 */ }
      const authRejected = res.status === 401 || res.status === 403;
      return this.fail(ctx, new RelayHttpError({
        httpStatus: 502,
        code: authRejected ? 'upstream_credential_invalid' : 'upstream_error',
        // 端点若带数字业务码（部分兼容网关有）就落审计列；标准 OpenAI 错误是字符串码，为 null。
        upstreamCode: failure.businessCode,
        message: `上游（${provider.name}）HTTP ${res.status}：${upstreamMsg || '无响应体'}`,
      }), `custom upstream ${res.status}`);
    }
    if (!res.body) {
      slot.release();
      return this.fail(ctx, new RelayHttpError({
        httpStatus: 502, code: 'upstream_error',
        message: '上游返回 200 但响应体为空，无法读取流。',
      }), 'upstream empty body');
    }

    return {
      traceId: ctx.traceId,
      status: 200,
      upstreamCode: null,
      /* 响应就是 OpenAI SSE 形状，无转换直进（首字超时/看门狗/聚合/落库语义同源）。 */
      events: readUpstreamSse(res.body, ctx, this.log, cfg.logs?.recordResponseBody === true, guard),
      failure: null,
      model: modelId,
    };
  }

  /**
   * [v0.6.0] Qoder CN 网关出站（COSY 协议，第三方言）。
   *
   * 与 doCallAnthropic 同骨架（并发位/首字守护/错误映射/审计同源），差异全在协议层：
   *   · 凭证来自 providers/<id>.key（JSON 身份材料），COSY 会话由 QoderCredentialStore 缓存；
   *   · 请求体 = toQoderRequest(OpenAI 形状) 再 qEncode 自定义 base64；
   *   · 头全部由 cosy.ts 构造（不透传入站头 —— 与 headers.ts allowlist 纪律一致）；
   *   · 响应流 qoderToOpenAiSse 折回 OpenAI SSE 后进同一 readUpstreamSse 管道。
   */
  private async doCallQoder(
    ctx: StreamContext,
    originalBody: ChatRequestBody,
    rewrittenBody: ChatRequestBody,
    cfg: ReturnType<RelayConfigService['get']>,
    slot: ActiveSlot,
    provider: ProviderRow,
  ): Promise<UpstreamStream> {
    let identity;
    let session;
    try {
      ({ identity, session } = this.qoderCredentials.session(provider.id));
    } catch (err) {
      slot.release();
      return this.fail(ctx, new RelayHttpError({
        httpStatus: 502, code: 'upstream_credential_invalid',
        message: (err as Error).message,
      }), 'qoder credential invalid');
    }

    /* 目录 id 即网关内部 key（qfmodel…）—— 见 catalog/qoder-models.ts 的设计说明。
       客户端发来的 model 已被路由解析为目录行，这里取行 id 直投网关；
       同一值也注入 SSE 解码器（网关响应里的 model 是 'auto' 占位，不能用）。 */
    const qoderKey = ctx.modelId ?? rewrittenBody.model;
    const qoderBody = toQoderRequest(rewrittenBody, qoderKey, identity.userType);
    const encoded = qEncode(JSON.stringify(qoderBody));

    const date = String(Math.floor(Date.now() / 1000));
    const path = provider.chat_path ?? DEFAULT_QODER_CHAT_PATH;
    const url = `${stripTrailingSlash(provider.base_url)}${path}`;
    /* 签名路径 = 端点的纯 path（查询串不参与），且剥 /algo 前缀（网关双形态规则）。 */
    const pathOnly = path.split('?')[0];
    const bearer = buildCosyBearer(session, date, encoded, pathOnly);
    const headers = cosyChatHeaders(session, identity, bearer, date, 'text/event-stream');

    if (cfg.logs?.recordRequestBody && bodyCaptureActive(cfg.logs)) ctx.requestBody = capBody(JSON.stringify(originalBody));

    /* [v0.6.3] 首字探测 + 零内容自动重试。
       ── 为什么：2026-10-12 00:59 实测，Qoder 网关在大上下文（2.7 万 token）时会
          「HTTP 200 但 27.8s 零字节后断流」—— 那时客户端什么都没收到，重发一次完全无感
          （客户端只感到响应变慢，不会看到半截内容）。同日 01:11 同模型重发 4.9s 成功。
       ── 为什么探首块而不是在 readUpstreamSse 里重试：一旦 yield 过任何事件，controller
          就已 writeHead(200) 提交响应，再重试会写出两段流。必须**在发电机启动前**等首字节：
          拿到就正常流式（首字延迟 = 上游首字延迟，铁律 2 不破）；零内容才重发。
       ── 上限：最多 1 次（自用场景，避免上游真故障时把延迟翻倍）。 */
    const MAX_QODER_RETRY = 1;
    let guard = createReadGuard(cfg.limits.firstByteTimeoutMs || 30_000);
    let upstreamBody: ReadableStream<Uint8Array> | null = null;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= MAX_QODER_RETRY; attempt += 1) {
      if (attempt > 0) {
        guard.dispose();
        await new Promise((r) => setTimeout(r, 1_000));
        guard = createReadGuard(cfg.limits.firstByteTimeoutMs || 30_000);
        ctx.retries += 1;
        markRetried(ctx);
        this.logger.warn(`Qoder 零内容断流，重试第 ${attempt} 次 trace=${ctx.traceId}`);
      }
      let res: Response;
      try {
        res = await upstreamFetch(url, { method: 'POST', headers, body: encoded, signal: guard.signal });
      } catch (err) {
        lastErr = err;
        guard.dispose();
        // 首字超时（guard.abort）在网络层表现为 AbortError —— 与零内容同属「可重试」类；
        // 额度用尽才判定失败。
        if (attempt < MAX_QODER_RETRY) continue;
        slot.release();
        this.logger.error(`上游不可达（qoder）trace=${ctx.traceId}: ${(err as Error).message}`);
        return this.fail(ctx, this.networkFailure(err), 'upstream unreachable');
      }
      if (!res.ok) {
        guard.dispose();
        slot.release();
        const raw = await res.text().catch(() => '');
        return this.fail(ctx, new RelayHttpError({
          httpStatus: 502,
          /* 401/403 里可能是 10605 并发准入（会话有效）—— 统一按凭据失败提示重新导入，
             但把原始体带出来让人能分辨。 */
          code: res.status === 401 || res.status === 403 ? 'upstream_credential_invalid' : 'upstream_error',
          message: `上游（${provider.name}）HTTP ${res.status}：${raw.slice(0, 300) || '无响应体'}`,
        }), `qoder upstream ${res.status}`);
      }
      if (!res.body) {
        guard.dispose();
        slot.release();
        return this.fail(ctx, new RelayHttpError({
          httpStatus: 502, code: 'upstream_error',
          message: '上游返回 200 但响应体为空，无法读取流。',
        }), 'upstream empty body');
      }

      /* 等首块字节：拿到 → 塞回新流一并交给解码器（不丢首帧内容）；
         流直接结束 → 零内容断流，还有额度就重试。 */
      const first = await this.readFirstBytes(res.body);
      if (first.done || !first.value || first.value.byteLength === 0) {
        guard.dispose();
        if (attempt < MAX_QODER_RETRY) continue;
        slot.release();
        return this.fail(ctx, new RelayHttpError({
          httpStatus: 502, code: 'upstream_error',
          message: '上游返回 200 但未产出任何内容即断开（已重试一次）。',
        }), 'stream_aborted');
      }
      upstreamBody = prependFirstChunk(res.body, first.value);
      break;
    }

    if (!upstreamBody) {
      // 防御性兜底：循环内必然 break 或 return；此处仅保证类型收窄
      slot.release();
      return this.fail(ctx, this.networkFailure(lastErr ?? new Error('qoder stream missing')), 'upstream unreachable');
    }

    return {
      traceId: ctx.traceId,
      status: 200,
      upstreamCode: null,
      events: readUpstreamSse(
        upstreamBody.pipeThrough(qoderToOpenAiSse(ctx.modelId ?? rewrittenBody.model)),
        ctx,
        this.log,
        cfg.logs?.recordResponseBody === true,
        guard,
      ),
      failure: null,
      model: ctx.modelId ?? '',
    };
  }

  /**
   * [v0.6.3] 读上游流的**第一块**字节（用于「零内容断流」判定）。
   * 读到的块由调用方经 `prependFirstChunk` 塞回流，不会丢内容。
   */
  private async readFirstBytes(body: ReadableStream<Uint8Array>): Promise<{ done: boolean; value?: Uint8Array }> {
    const reader = body.getReader();
    try {
      const r = await reader.read();
      return { done: r.done === true, value: r.value };
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 失败出口：先落一行失败日志，再返回给 controller 回响应。
   *
   * [2026-10-18 更正] 此前注释写「credits=0」，与实际相反：这里**不传** credits，
   * `persistFailure` 默认落 `null`（见 proxy-log.ts 的 `outcome.credits ?? null`）。
   * `null` 才是对的 —— 上游路径上的失败「花了多少不可知」，只有**本地拒绝**
   * （未打上游，见 logRejection）才记 `0`（那是事实）。first_byte_ms 同理为 NULL。
   */
  private fail(ctx: StreamContext, failure: RelayHttpError, note: string): UpstreamStream {    this.log.persistFailure(
      { ...ctx, traceId: failure.traceId },
      {
        status: failure.httpStatus,
        upstreamCode: failure.upstreamCode,
        note,
        model: ctx.modelId || null,
        modelDisplay: ctx.modelDisplay || null,
      },
    );
    return {
      traceId: ctx.traceId,
      status: failure.httpStatus,
      upstreamCode: failure.upstreamCode,
      events: null,
      failure,
      model: ctx.modelId,
    };
  }

  /** 上游 11102 → 把该模型标 verified=0（绝不删除）。 */
  private applyModelSideEffect(upstreamCode: number | null, providerId: string, modelId: string): void {
    if (upstreamCode === 11102) {
      this.catalog.setVerified(providerId, modelId, false);
      this.logger.warn(`上游返回 11102，模型 ${modelId} 标记为未验证（不删除，订阅后可能再开）。`);
    }
  }

  private networkFailure(err: unknown): RelayHttpError {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new RelayHttpError({
        httpStatus: 504,
        code: 'upstream_timeout',
        apiCode: ApiCode.INTERNAL,
        message: '连接上游超时：首个数据帧未在「首字超时」内到达。上游出字慢请调大设置里的「首字超时」；已开始的流不受总时长限制。',
      });
    }
    return new RelayHttpError({
      httpStatus: 502,
      code: 'upstream_unreachable',
      apiCode: ApiCode.INTERNAL,
      message: '无法连接上游（网络不可达或 DNS 失败）。请检查服务器出网与上游地址。',
    });
  }
}
