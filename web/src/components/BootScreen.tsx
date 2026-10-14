import { BrandMark } from './BrandMark';

/** 首屏会话判断期间的过渡屏 —— 不闪红、不报错，只是安静等一下。 */
export function BootScreen() {
  return (
    <div className="login-wrap">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <BrandMark size={40} />
        <div style={{ fontSize: 12.5, color: 'var(--text-ghost)' }}>正在确认会话…</div>
      </div>
    </div>
  );
}
