/**
 * 章节轨（右侧固定）。纯装饰性指引 —— 原型自己说它是「这是一段被导演过的旅程」
 * 最便宜的提示。`.on` 由 page.ts 按「视口 42% 处」判定，≤1180px 隐藏（见 ui.css）。
 *
 * 用**原生锚点**指向页内区块，与控制台 hash 路由无关（契约 §2.1）。
 */
const SECTIONS: Array<{ href: string; label: string }> = [
  { href: '#top', label: '概览' },
  { href: '#ways', label: '运行方式' },
  { href: '#quickstart', label: '快速开始' },
  { href: '#clients', label: '客户端配置' },
  { href: '#status', label: '运行状态' },
  { href: '#cta', label: '开始使用' },
];

export function Rail() {
  return (
    <nav className="rail" aria-label="章节">
      {SECTIONS.map((s) => (
        <a key={s.href} href={s.href}>
          <i />
          <b>{s.label}</b>
        </a>
      ))}
    </nav>
  );
}
// @zbiti-ai:f:27:8282487b
