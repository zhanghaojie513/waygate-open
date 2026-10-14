/**
 * 客户端「显示名」回落链（spec-v4-client-id §2，锁定）。
 *
 * client_id 是**稳定标识**（分组/过滤/聚合键），名字只是给人看的、会变。
 * 当某个 client_id 需要渲染成名字时，按下面这条链逐级回落，**末端绝不返回空串**：
 *
 *   'unidentified'            -> 未识别
 *   否则 client_keys.client   -> 绑定名（可改）
 *   否则 client_keys.name     -> 密钥名
 *   密钥已删                  -> 已删除的密钥 · <key_hint 掩码>
 *
 * 为什么抽成纯函数：AC-C08/C09 要断言的是「结果」，不是「某段 SQL 被拼了」。
 * 名字的解析规则集中在这里，改名/删键后各处（客户端页、概览、日志）口径一致。
 */

/** 兜底 client_id：没有可用识别依据时的字面量（spec-v4-client-id §2 规则 4）。 */
export const UNIDENTIFIED_ID = 'unidentified';

/** 'unidentified' 的显示名。 */
export const UNIDENTIFIED_NAME = '未识别';

export interface ClientNameParts {
  /** 分组键：稳定标识。 */
  clientId: string;
  /** client_keys.client —— 创建时绑定的客户端名（识别规则第 2 条的名字来源），可为空。 */
  boundName: string | null;
  /** client_keys.name —— 密钥名，可为空（表里 NOT NULL，理论不空）。 */
  keyName: string | null;
  /** 该 client_id 对应的密钥是否仍在 client_keys 里。 */
  keyExists: boolean;
  /** 请求行里冗余的 key_hint 掩码（'sk-waygate-4f9c…7a2e'），密钥已删时用它渲染。 */
  keyHint: string | null;
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * 把 (clientId + 密钥信息) 解析成给人看的显示名。
 *
 * ⛔ 任何分支都**不返回空串** —— 空串在界面上看起来像「没有客户端」，
 *    会把「密钥已删」这条重要信息藏起来（spec-v4-client-id §2）。
 */
export function resolveClientName(parts: ClientNameParts): string {
  if (parts.clientId === UNIDENTIFIED_ID) return UNIDENTIFIED_NAME;

  const bound = clean(parts.boundName);
  if (bound) return bound;

  const name = clean(parts.keyName);
  if (name) return name;

  const hint = clean(parts.keyHint);
  if (parts.keyExists) {
    // 密钥还在，却既无绑定名又无密钥名 —— 理论不可达（name 为 NOT NULL）。
    // 用掩码兜底，绝不留空串。
    return hint ?? parts.clientId;
  }
  // 密钥已删：key_hint 不随改名而变，正好用来认人。无 hint 时退回 client_id（仍非空）。
  return hint ? `已删除的密钥 · ${hint}` : `已删除的密钥 · ${parts.clientId}`;
}
