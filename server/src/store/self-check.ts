import type { Db } from './db';

/** 启动自检：把「改了列名而 TS interface 没改」从运行时提前到启动时必炸（ADR-001 缓解）。 */
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  requests: [
    'id', 'ts', 'trace_id', 'client', 'client_rule', 'client_id', 'key_id', 'key_hint', 'model',
    'model_display', 'status', 'upstream_code', 'ms', 'queued_ms', 'first_byte_ms',
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens',
    'credits', 'stream',
    'retry_count', 'note', 'remote_ip', 'ua', 'request_body', 'response_body', 'created_at',
  ],
  aggregates: [
    'bucket', 'dim', 'dim_value', 'requests', 'errors', 'credits',
    'prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_ms', 'updated_at',
  ],
  client_keys: [
    'id', 'name', 'key_hash', 'key_hint', 'scope', 'client', 'clients', 'ip_whitelist', 'max_ips', 'token_quota', 'enabled',
    'expires_at', 'source', 'created_at', 'last_seen_at', 'last_seen_ip',
  ],
  model_catalog: [
    'provider_id', 'id', 'display_name', 'family', 'tag', 'multiplier', 'source', 'verified',
    'enabled', 'last_verified_at', 'created_at', 'updated_at',
  ],
  admin_credential: ['id', 'hash', 'source', 'updated_at', 'rotated_at'],
  providers: ['id', 'name', 'base_url', 'active', 'protocol', 'chat_path', 'cred_kind', 'access_expires_at', 'signin_checked_on', 'signin_streak', 'signin_last_points', 'wb_signin_checked_on', 'wb_signin_streak', 'wb_signin_last_points', 'wb_oauth_expires_at', 'created_at', 'updated_at'],
  provider_model_prefs: ['provider_id', 'model_id', 'enabled', 'updated_at'],
};

export function tableColumns(db: Db, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function assertSchema(db: Db): void {
  const problems: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = tableColumns(db, table);
    if (actual.length === 0) {
      problems.push(`表 ${table} 不存在`);
      continue;
    }
    const missing = expected.filter((c) => !actual.includes(c));
    const extra = actual.filter((c) => !expected.includes(c));
    if (missing.length) problems.push(`表 ${table} 缺列：${missing.join(', ')}`);
    if (extra.length) problems.push(`表 ${table} 多出未声明列：${extra.join(', ')}`);
  }
  if (problems.length) {
    throw new Error(`数据库结构自检未通过：\n  - ${problems.join('\n  - ')}\n请核对 schema.sql 与本文件 EXPECTED_COLUMNS。`);
  }
}
