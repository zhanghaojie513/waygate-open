/** danger 操作名 → 契约的 action 值。 */
export const DANGER_ACTIONS = ['clearLogs', 'resetKeys', 'restoreDefaults'] as const;
export type DangerAction = (typeof DANGER_ACTIONS)[number];

export function isDangerAction(value: unknown): value is DangerAction {
  return typeof value === 'string' && (DANGER_ACTIONS as readonly string[]).includes(value);
}
