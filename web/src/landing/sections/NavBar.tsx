import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BrandMark } from '../../components/BrandMark';
import { consoleHref } from '../../lib/consoleRoute';

/**
 * 顶栏。UI 与原型一致：品牌（logo→#top）+ 4 个页内锚点 + 版本胶囊 + 打开控制台。
 *
 * 两个细节：
 *   · 玻璃底由 page.ts 在滚动 > 28px 时加 `.stuck`（首屏保持全透明）。
 *   · 「打开控制台」用 `consoleHref()` —— 会补上控制台**上次停留的视图**，
 *     让来回切换时视图状态不丢（AC-10）。
 */
export function NavBar({ version }: { version: string }) {
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

  return (
    <nav className={`nav${open ? ' menu-open' : ''}`}>
      <a className="brand" href="#top" onClick={close}>
        <BrandMark size={28} id="relay-mark-nav" />
        <b>途关</b><span>Waygate</span>
      </a>
      <div className="nav-links">
        <a href="#ways" onClick={close}>运行方式</a>
        <a href="#quickstart" onClick={close}>快速开始</a>
        <a href="#clients" onClick={close}>客户端配置</a>
        <a href="#status" onClick={close}>运行状态</a>
      </div>
      <div className="nav-right" style={{ display: 'flex', alignItems: 'center', gap: 14, marginLeft: 'auto' }}>
        <span className="pill pill-brand">v{version}</span>
        <a className="btn btn-primary btn-sm" href={consoleHref()}>打开控制台</a>
        <button
          type="button"
          className="nav-menu-toggle"
          aria-label={open ? '关闭导航菜单' : '打开导航菜单'}
          aria-controls="landing-mobile-nav"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
        </button>
      </div>
      <div id="landing-mobile-nav" className="mobile-nav" aria-hidden={!open}>
        <a href="#ways" onClick={close}>运行方式</a>
        <a href="#quickstart" onClick={close}>快速开始</a>
        <a href="#clients" onClick={close}>客户端配置</a>
        <a href="#status" onClick={close}>运行状态</a>
      </div>
    </nav>
  );
}
// @zbiti-ai:f:33:06b35638
