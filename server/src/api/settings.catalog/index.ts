/**
 * 设置页的元数据（api-contract §3.8）。
 *
 * 这里是**唯一**把「25 项设置」的 label / type / why / readonly / requiresRestart
 * 写下来的地方。之所以放后端而不是前端常量：
 *   1. `why`（每项为什么存在）是产品语气的核心，散在前端会跟后端校验规则漂移
 *   2. 契约要求 `PUT` 是**全量替换**，服务端必须知道哪些 key 是合法的可写项
 *      —— 这正是 `EDITABLE_KEYS`，必须与实际校验逻辑同源
 *
 * 三组特殊项：
 *   - `credential.*`  → readonly，值由运行态计算（上游访问密钥来源/状态）
 *   - `danger.*`      → type:'action'，不需要 value，走独立端点
 *   - `config.mapping`→ type:'mapping'，静态对照表
 *
 * ⚠️ 文件组织（task#37）：原 `settings.catalog.ts` 332 行越过单文件 300 行门禁，
 * 已按分组拆进本目录（`group-*.ts` 各管一组、`types.ts` 放类型、`danger.ts` 放动作枚举）。
 * 本 `index.ts` 只做**组装与再导出**，不改任何一项的值。导入路径 `./settings.catalog`
 * 不变（解析到本目录的 index）。
 */

import type { RelaySettings } from '../../config/settings.defaults';
import { serviceGroup } from './group-service';
import { credentialGroup } from './group-credential';
import { quotaGroup } from './group-quota';
import { limitsGroup } from './group-limits';
import { logsGroup } from './group-logs';
import { signinGroup } from './group-signin';
import { dangerGroup } from './group-danger';
import { mappingGroup } from './group-mapping';
import type { RuntimeInfo, SettingGroup } from './types';

export type { SettingType, SettingItem, SettingGroup, RuntimeInfo } from './types';
export { CONFIG_MAPPING } from './config-mapping';
export { DANGER_ACTIONS, isDangerAction, type DangerAction } from './danger';

/** 组装设置组（顺序即契约 §3.8 的顺序，前端按此渲染）。[v1.3.0] 新增「每日签到」组（quota 后）。 */
export function buildSettingGroups(settings: RelaySettings, runtime: RuntimeInfo): SettingGroup[] {
  return [
    serviceGroup(settings),
    credentialGroup(settings, runtime),
    quotaGroup(settings),
    signinGroup(settings),
    limitsGroup(settings),
    logsGroup(settings),
    dangerGroup(),
    mappingGroup(),
  ];
}
