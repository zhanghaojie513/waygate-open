/**
 * `GET/POST/PATCH/DELETE /api/keys`（api-contract §3.10 / SPEC §9 AC-08）。
 *
 * 铁律：
 *   1. **明文只在 POST 响应里出现一次**，之后任何读取路径（列表、详情）都拿不到 ——
 *      库里只有 `key_hash`（HMAC）+ `key_hint`（首尾各 4 位）。
 *   2. `name` 唯一：重名返回 409（契约错误码表 `40901` 幂等冲突）。
 *      唯一性在这里查（`countByName`）而不是靠库里 UNIQUE 索引，
 *      因为"重名"要回人话错误而不是抛 SQLITE_CONSTRAINT。
 *   3. `client` 字段必填且有默认值 —— 识别规则第 2 级「密钥归属」全靠它，
 *      没有它就少了一条识别依据（build-plan Phase 3）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { StatsRepository } from '../store/repositories/stats.repo';
import { parseScope, parseClients, parseIpWhitelist, type ClientKeyRow, type KeyScope } from '../store/repositories/client-keys.repo';
import { generateKey } from '../auth/keys';
import { RelayHttpError, ApiCode } from '../common/errors';
import { randomHex } from '../common/crypto';
import { toIso } from './window';
// 输入解析抽到单独文件（纯函数、无依赖），见 keys.parsing.ts 顶部说明。
import { normalizeScope, parseExpiresAt, normalizeIpWhitelist, parsePositiveLimit } from './keys.parsing';

export interface KeyListItem {
  id: string;
  name: string;
  hint: string;
  scope: KeyScope;
  /** 首选提供商（= clients[0]），识别规则第 2 级用它归因。 */
  client: string | null;
  /** [v0.4.20] 绑定的提供商有序数组，第 1 项优先级最高。 */
  clients: string[];
  /** [v0.4.35] IP 白名单（归一化条目），空 = 不限。 */
  ipWhitelist: string[];
  /** [v0.4.35] 最大 IP 数，null = 不限。 */
  maxIps: number | null;
  /** [v0.4.35] Token 配额，null = 不限。 */
  tokenQuota: number | null;
  /**
   * 累计用量（白名单/配额的可视化对照）：不同来源 IP 数 + 累计 tokens。
   * **null = 未计算**（该密钥没设 maxIps/tokenQuota，服务端不为展示而查全量聚合）。
   * 与「用过 0 次」是两回事 —— 0 是事实，null 是没查。
   */
  usedIps: number | null;
  usedTokens: number | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  requests24h: number;
  source: string;
}

export interface CreateKeyInput {
  name?: unknown;
  scope?: unknown;
  client?: unknown;
  /** [v0.4.20] 有序提供商数组；给了它则忽略 client（clients 更完整）。 */
  clients?: unknown;
  /** [v0.4.35] IP 白名单（字符串数组，逐条校验）。 */
  ipWhitelist?: unknown;
  /** [v0.4.35] 最大 IP 数（正整数或 null）。 */
  maxIps?: unknown;
  /** [v0.4.35] Token 配额（正整数或 null）。 */
  tokenQuota?: unknown;
  expiresAt?: unknown;
}

/**
 * [v0.4.20] 归一化「绑定的提供商列表」：去空、去重、保序。
 * 兼容三种输入：clients 数组（新） / client 字符串（旧） / 都不给。
 */
function normalizeClients(clientsRaw: unknown, clientRaw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  };
  if (Array.isArray(clientsRaw)) clientsRaw.forEach(push);
  else if (typeof clientsRaw === 'string' && clientsRaw.trim()) push(clientsRaw); // 容错：单字符串
  if (out.length === 0) push(clientRaw); // 回落旧字段
  return out;
}

const DAY = 24 * 3600 * 1000;

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    private readonly config: RelayConfigService,
    private readonly keys: ClientKeysRepository,
    private readonly stats: StatsRepository,
  ) {}

  list(): { items: KeyListItem[] } {
    const since = Date.now() - DAY;
    return { items: this.keys.list().map((row) => this.render(row, since)) };
  }

  /** DB 行 → API 形状（list / patch 共用，形状只此一处）。 */
  private render(row: ClientKeyRow, since: number = Date.now() - DAY): KeyListItem {
    /* [v0.4.35] 用量只在设了限额时才查 —— 没限额的密钥显示它没有意义，
       还给每个无限制密钥白搭两条聚合查询。
       [2026-10-18] 未计算时返回 **null** 而不是 0：0 会被读成「一次都没用过」，
       与「没查」是两回事（本项目的「0 不是未知」铁律）。前端本就只在
       maxIps/tokenQuota 非 null 时渲染这两个字段，改 null 不破界面。 */
    const limited = row.max_ips !== null || row.token_quota !== null;
    const usage = limited ? this.keys.usageForKey(row.id) : null;
    return {
      id: row.id,
      name: row.name,
      hint: row.key_hint,
      scope: parseScope(row.scope),
      client: row.client,
      clients: parseClients(row.clients),
      ipWhitelist: parseIpWhitelist(row.ip_whitelist),
      maxIps: row.max_ips,
      tokenQuota: row.token_quota,
      usedIps: usage ? usage.distinctIps : null,
      usedTokens: usage ? usage.tokensUsed : null,
      enabled: row.enabled === 1,
      expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
      createdAt: toIso(row.created_at),
      lastSeenAt: row.last_seen_at === null ? null : toIso(row.last_seen_at),
      requests24h: this.stats.requestsForKey(row.id, since),
      source: row.source,
    };
  }

  /** ★ 创建：明文只在这一处产生并返回，绝不落库。 */
  create(input: CreateKeyInput): {
    id: string;
    key: string;
    hint: string;
    name: string;
    scope: KeyScope;
    client: string | null;
    clients: string[];
    createdAt: string;
    warning: string;
  } {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: '缺少 name 字段：密钥需要一个便于识别的名字。',
      });
    }
    if (name.length > 64) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'name 最长 64 个字符。',
      });
    }
    if (this.keys.countByName(name) > 0) {
      throw new RelayHttpError({
        httpStatus: 409,
        code: 'key_name_conflict',
        apiCode: ApiCode.CONFLICT,
        message: `已存在名为「${name}」的密钥。请换一个名字，或先删除原密钥。`,
      });
    }

    const scope = normalizeScope(input.scope);
    /* [v0.4.20] 支持多提供商绑定：clients 数组优先，回落旧的 client 单值。
       `client` 列 = clients[0]（首选），识别规则第 2 级仍读它 —— 归因逻辑零改动。 */
    const clients = normalizeClients(input.clients, input.client);
    const client = clients[0] ?? null;
    const expiresAt = parseExpiresAt(input.expiresAt);
    /* [v0.4.35] 访问策略三项：白名单逐条校验，限额必须正整数（空 = 不限）。 */
    const ipWhitelist = normalizeIpWhitelist(input.ipWhitelist);
    const maxIps = parsePositiveLimit(input.maxIps, 'maxIps');
    const tokenQuota = parsePositiveLimit(input.tokenQuota, 'tokenQuota');

    const generated = generateKey();
    const id = `k_${randomHex(4)}`;

    this.keys.create({
      id,
      name,
      keyHash: generated.hashFactory(this.config.secret),
      keyHint: generated.hint,
      scope: JSON.stringify(scope),
      client,
      clients: JSON.stringify(clients),
      ipWhitelist: JSON.stringify(ipWhitelist),
      maxIps,
      tokenQuota,
      expiresAt,
      source: 'console',
    });

    this.logger.log(`已创建密钥 id=${id} name=${name} hint=${generated.hint}`);

    return {
      id,
      key: generated.plain,
      hint: generated.hint,
      name,
      scope,
      client,
      clients,
      createdAt: toIso(Date.now()),
      // 契约原文要求的提示语，一字不改
      warning: '关掉这页又没保存，只能删除重建。此明文不会再出现。',
    };
  }

  /**
   * 局部更新。返回**更新后的完整行**（与 GET 列表同一形状），
   * 因为前端 `patchKey` 的返回类型就是 `ClientKeyRow` —— 只回 `{id}`
   * 会在下次有人真正使用返回值时静默出错。
   */
  patch(
    id: string,
    body: {
      name?: unknown;
      enabled?: unknown;
      client?: unknown;
      clients?: unknown;
      ipWhitelist?: unknown;
      maxIps?: unknown;
      tokenQuota?: unknown;
    },
  ): KeyListItem {
    // 先确认存在：PATCH 不存在的 id 要 404 而不是静默 no-op
    this.mustFind(id);

    const patch: { name?: string; enabled?: number; client?: string | null; clients?: string } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: 'name 必须是非空字符串。',
        });
      }
      const name = body.name.trim();
      // 改名也要查重，但允许改成自己原来的名字
      const existing = this.keys.list().find((k) => k.name === name);
      if (existing && existing.id !== id) {
        throw new RelayHttpError({
          httpStatus: 409,
          code: 'key_name_conflict',
          apiCode: ApiCode.CONFLICT,
          message: `已存在名为「${name}」的密钥。`,
        });
      }
      patch.name = name;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: 'enabled 必须是布尔值。',
        });
      }
      patch.enabled = body.enabled ? 1 : 0;
    }
    /* [v0.4.20] 绑定提供商可改、可解绑（多选 + 优先级）。传 `clients` 数组（新）
       或 `client` 单值（旧）任一即可：clients 优先。空数组 / null / 空串都等价于解绑。
       与「没传这个字段」区分开 —— 前者覆写，后者不动。 */
    if (body.clients !== undefined || body.client !== undefined) {
      if (body.clients !== undefined && !Array.isArray(body.clients)) {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: 'clients 必须是字符串数组。',
        });
      }
      if (body.client !== undefined && body.client !== null && typeof body.client !== 'string') {
        throw new RelayHttpError({
          httpStatus: 400,
          code: 'invalid_request_body',
          apiCode: ApiCode.BAD_PARAM,
          message: 'client 必须是字符串或 null。',
        });
      }
      const clients = normalizeClients(body.clients, body.client);
      patch.clients = JSON.stringify(clients);
      patch.client = clients[0] ?? null;
    }
    /* [v0.4.35] 访问策略三件套：任一字段出现即整组覆写（未出现的两项保持现值）。
       清空语义：ipWhitelist 传 [] / maxIps、tokenQuota 传 null = 解除该项限制。 */
    const policyTouched = body.ipWhitelist !== undefined || body.maxIps !== undefined || body.tokenQuota !== undefined;
    if (policyTouched) {
      const current = this.keys.findById(id)!;
      const ipWhitelist =
        body.ipWhitelist !== undefined
          ? normalizeIpWhitelist(body.ipWhitelist)
          : parseIpWhitelist(current.ip_whitelist);
      const maxIps =
        body.maxIps !== undefined ? parsePositiveLimit(body.maxIps, 'maxIps') : current.max_ips;
      const tokenQuota =
        body.tokenQuota !== undefined ? parsePositiveLimit(body.tokenQuota, 'tokenQuota') : current.token_quota;
      this.keys.patchPolicy(id, {
        ipWhitelist: JSON.stringify(ipWhitelist),
        maxIps,
        tokenQuota,
      });
    }
    if (Object.keys(patch).length === 0 && !policyTouched) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: '请求体至少要包含 name / enabled / client(s) / ipWhitelist / maxIps / tokenQuota 之一。',
      });
    }

    this.keys.patch(id, patch);
    // 回读一行，与 list() 的渲染形状保持一致
    return this.render(this.keys.findById(id)!);
  }

  remove(id: string): { deleted: number } {
    this.mustFind(id);
    const deleted = this.keys.remove(id);
    this.logger.log(`已删除密钥 id=${id}`);
    return { deleted };
  }

  private mustFind(id: string): void {
    if (!this.keys.findById(id)) {
      throw new RelayHttpError({
        httpStatus: 404,
        code: 'key_not_found',
        apiCode: ApiCode.NOT_FOUND,
        message: `密钥 ${id} 不存在（可能已被删除）。`,
      });
    }
  }
}
