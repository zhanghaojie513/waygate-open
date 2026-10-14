/**
 * `GET/PUT /api/settings` 与 `POST /api/settings/danger` 的业务逻辑（api-contract §3.8 / §3.9）。
 *
 * PUT 是**全量替换**，且只提交 `readonly:false` 且 `type != 'action'` 的项。
 * 实际的逐项校验、写盘、requiresRestart 计算都在 `RelayConfigService.applyUpdates`，
 * 本服务只负责：把请求体解析成 `{key,value}[]`、算出 danger 操作的影响面、执行 danger。
 */

import { Injectable, Logger } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { RequestsRepository } from '../store/repositories/requests.repo';
import { ClientKeysRepository } from '../store/repositories/client-keys.repo';
import { RelayHttpError, ApiCode } from '../common/errors';
import { buildSettingGroups, isDangerAction, type DangerAction, type SettingGroup } from './settings.catalog';

export interface SettingsPayload {
  groups: SettingGroup[];
  version: number;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly config: RelayConfigService,
    private readonly requests: RequestsRepository,
    private readonly keys: ClientKeysRepository,
  ) {}

  get(): SettingsPayload {
    const settings = this.config.get();
    return {
      groups: buildSettingGroups(settings, {
        credentialSource: this.config.maskedUpstreamKey(),
        credentialStatus: this.config.upstreamConfigured() ? '有效' : '未配置',
      }),
      version: this.config.getVersion(),
    };
  }

  put(body: unknown): { requiresRestart: boolean; applied: number; version: number } {
    const entries = parseSettingsBody(body);
    return this.config.applyUpdates(entries);
  }

  /** 危险操作：先量化影响面，再执行（契约 §3.9）。 */
  danger(body: unknown): { affected: Record<string, number> } {
    const obj = (body ?? {}) as Record<string, unknown>;

    // ★ confirm 必须**严格等于**字符串「确认」，否则 400/40002
    if (obj.confirm !== '确认') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'danger_confirm_mismatch',
        apiCode: ApiCode.DANGER_CONFIRM,
        message: '危险操作需要在 confirm 字段里原样填入「确认」两个字。',
      });
    }

    if (!isDangerAction(obj.action)) {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: 'action 只能是 clearLogs / resetKeys / restoreDefaults 之一。',
      });
    }

    return this.execute(obj.action);
  }

  private execute(action: DangerAction): { affected: Record<string, number> } {
    switch (action) {
      case 'clearLogs': {
        // clearAll 内部同时清 aggregates（同一事务），否则趋势图会残留
        const deleted = this.requests.clearAll();
        this.logger.warn(`危险操作：已清空全部日志，删除 ${deleted} 条`);
        return { affected: { logs: deleted } };
      }
      case 'resetKeys': {
        const deleted = this.keys.removeAll();
        this.logger.warn(`危险操作：已重置全部密钥，删除 ${deleted} 个`);
        return { affected: { keys: deleted } };
      }
      case 'restoreDefaults': {
        const before = this.config.getVersion();
        this.config.restoreDefaults();
        this.logger.warn(`危险操作：已恢复默认配置（version ${before} → ${this.config.getVersion()}）`);
        return { affected: { restored: 1 } };
      }
    }
  }
}

/**
 * 解析 `{"settings":[{"key":..,"value":..}]}`。
 * 结构错误在这里拦掉；**每一项的值校验交给 `validateSetting`**（单一权威）。
 */
function parseSettingsBody(body: unknown): Array<{ key: string; value: unknown }> {
  const obj = body as { settings?: unknown } | null | undefined;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.settings)) {
    throw new RelayHttpError({
      httpStatus: 400,
      code: 'invalid_request_body',
      apiCode: ApiCode.BAD_PARAM,
      message: '请求体必须是 {"settings":[{"key":"...","value":...}]} 形状。',
    });
  }
  return obj.settings.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: `settings[${i}] 不是对象。`,
      });
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.key !== 'string' || item.key.trim() === '') {
      throw new RelayHttpError({
        httpStatus: 400,
        code: 'invalid_request_body',
        apiCode: ApiCode.BAD_PARAM,
        message: `settings[${i}].key 必须是非空字符串。`,
      });
    }
    return { key: item.key.trim(), value: item.value };
  });
}
