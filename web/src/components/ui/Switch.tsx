/**
 * 开关：真正的 button + role=switch，键盘可达（空格/回车切换）。
 * 外观沿用原型 .switch，用 aria-checked 驱动 on/off 两态。
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? '' : ' off'}`}
      onClick={() => onChange(!checked)}
    />
  );
}
