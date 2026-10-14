import type { SettingItem } from '../../types/api';
import { Switch } from '../ui/Switch';
import { Tag } from '../ui/Pill';
import { Select } from '../ui/Select';

/** 单项设置的输入控件：按 type 分发。只读项渲染为不可编辑的展示。 */
export function SettingControl({
  item,
  value,
  disabled,
  onChange,
}: {
  item: SettingItem;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  if (item.type === 'switch') {
    return (
      <Switch
        checked={Boolean(value)}
        disabled={disabled || item.readonly}
        label={item.label}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (item.type === 'badge') {
    return <Tag tone="live">{String(value)}</Tag>;
  }

  if (item.type === 'select') {
    const opts = (item.options ?? []).map((o) => ({ value: o.value, label: o.label }));
    return (
      <Select
        value={String(value)}
        options={opts}
        disabled={disabled || item.readonly}
        onChange={(v) => onChange(v)}
        width={188}
      />
    );
  }

  if (item.type === 'number') {
    return (
      <input
        className="field-input num"
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled || item.readonly}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        aria-label={item.label}
      />
    );
  }

  if (item.type === 'mapping') {
    return null; // mapping 单独渲染成代码块
  }

  // text / 未知
  return (
    <input
      className="field-input text"
      value={value === null || value === undefined ? '' : String(value)}
      disabled={disabled || item.readonly}
      onChange={(e) => onChange(e.target.value)}
      aria-label={item.label}
    />
  );
}
// @zbiti-ai:f:73:4304602b
