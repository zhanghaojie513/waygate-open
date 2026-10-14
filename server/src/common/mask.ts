/** 凭证遮蔽：只保留首尾各 4 位，中间固定 4 个圆点。短于 10 字符时只给圆点。 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '未配置';
  if (value.length <= 10) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * `sk-waygate-4f9c…7a2e`：只暴露 24 位随机段的首尾各 4 位（ADR-009 的泄漏量评估）。
 *
 * 前缀**不写死**：密钥形态是 `<前缀><24 位小写十六进制>`，前缀 = 去掉尾部 24 位十六进制
 * 之后的部分。前缀更名（`sk-relay-` → `sk-waygate-`）或将来再改都不必动这里，
 * 也避免与 `auth/keys.ts` 的前缀常量形成循环依赖或两份清单漂移。
 */
export function buildKeyHint(fullKey: string): string {
  const m = /^(.*?)([0-9a-f]{24})$/.exec(fullKey);
  const prefix = m ? m[1] : '';
  const body = m ? m[2] : fullKey;
  if (body.length < 8) return `${prefix}••••`;
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}
