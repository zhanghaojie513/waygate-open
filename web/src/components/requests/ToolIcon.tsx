import type { CSSProperties } from 'react';

/**
 * UA 工具的图标（v0.4.27 重构：官方语言 SVG + 只在第一行显示）。
 *
 * ## 图标来源
 * 官方品牌 SVG（单色路径版，MIT/Apache 许可的 simple-icons 项目同源路径），
 * 内联渲染——不引外部文件、不加依赖。颜色走 CSS class（.ua-ico.<tone>）。
 *
 * ## 语义分组
 * python → Python 蛇形 · node → Node.js 六边形 · terminal → 命令行
 * sdk → 工具扳手 · cli → 通用代码 · none → 联网
 */
type Tone = 'python' | 'node' | 'terminal' | 'sdk' | 'cli' | 'none';

function toneOf(tool: string): Tone {
  const t = tool.toLowerCase();
  if (t.includes('python') || t.includes('httpx') || t.includes('aiohttp')) return 'python';
  if (t.includes('node') || t.includes('deno') || t.includes('bun') || t.includes('axios') || t.includes('undici')) return 'node';
  if (t.includes('curl') || t.includes('wget') || t.includes('http')) return 'terminal';
  if (t.includes('sdk')) return 'sdk';
  return 'cli';
}

/* ── 官方品牌 SVG 路径（单色，viewBox 统一 24×24）────────────────────── */

/** Python 蛇形 logo（两条互锁的蛇，简化单路径） */
const PYTHON_PATH =
  'M11.9 0C8.7 0 8.4 1.7 8.4 1.7v2.4h3.6v.7H5.3S2.4 4.5 2.4 8.4c0 3.8 2.5 3.7 2.5 3.7h1.5v-2.2s-.1-2.5 2.6-2.5h3.6s2.6 0 2.6-2.5V2.1S15.4 0 11.9 0zM9.3 1.5a.9.9 0 1 1 0 1.7.9.9 0 0 1 0-1.7zm6.3 3.4v2.3s.1 2.6-2.6 2.6H9.4s-2.5 0-2.5 2.5v4.4s-.2 2.7 4.8 2.7 4.7-2.3 4.7-2.3v-2.1h-3.6v-.7h6.7s3.2.3 3.2-3.7c0-4-2.8-3.8-2.8-3.8h-1.6v2.3s.1 2.6-2.6 2.6h-3.5s-2.4 0-2.4 2.4v4.1s-.4 2.4 4.4 2.4 4.5-2.1 4.5-2.1v-2h-3.4v-.7h6.6s3.4.4 3.4-3.9c0-4.3-2.9-4.1-2.9-4.1zM14.6 21.9a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z';

/** Node.js 六边形 logo（菱形切面） */
const NODE_PATH =
  'M12 1.5c-.3 0-.6.1-.9.3L3.4 6.4c-.5.3-.9.9-.9 1.5v8.2c0 .6.4 1.2.9 1.5l2 1.2c1 .5 1.8.1 1.8-1v-9c0-.7.5-1.2 1.2-1.2h7c.7 0 1.2.5 1.2 1.2v9c0 1.1.8 1.5 1.8 1l2-1.2c.5-.3.9-.9.9-1.5V7.9c0-.6-.4-1.2-.9-1.5L12.9 1.8c-.3-.2-.6-.3-.9-.3zm5.1 6c-.6 0-1.1.5-1.1 1.1v6.8c0 .6.5 1.1 1.1 1.1h5.2l-1.9 3.3 2.7-1.6c.5-.3.9-.9.9-1.5V7.9c0-.6-.4-1.2-.9-1.5l-7.7-4.6';

/** 终端 >_ */
const TERMINAL_D = 'M5 7l5 5-5 5m7 0h7';

/** 工具扳手 */
const SDK_D = 'M14.7 6.3a5 5 0 0 0-6.9 6l-6.1 6.1a2 2 0 1 0 2.8 2.8l6.1-6.1a5 5 0 0 0 6-6.9l-3.2 3.2-2.8-2.8 3.1-3.1z';

/** 通用代码 </> */
const CLI_D = 'M8 6l-6 6 6 6m8-12l6 6-6 6';

/* ── 组件 ───────────────────────────────────────────────────────────── */

/**
 * 工具图标：按工具名选**官方品牌 SVG** + 色调（.ua-ico.<tone>）。
 * 只在 UA 列第一行（原文行）使用；第二行（判定结果）不重复。
 */
export function ToolIcon({ tool, size = 14, style }: { tool: string | null; size?: number; style?: CSSProperties }) {
  const tone: Tone = tool ? toneOf(tool) : 'none';

  if (tone === 'none') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        className={`ua-ico ${tone}`} style={style} aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    );
  }

  if (tone === 'python' || tone === 'node') {
    // 品牌填充式图标（蛇形 / 六边形）
    const d = tone === 'python' ? PYTHON_PATH : NODE_PATH;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
        className={`ua-ico ${tone}`} style={style} aria-hidden="true">
        <path d={d} />
      </svg>
    );
  }

  // 线条式图标（终端 / SDK / CLI）
  const d = tone === 'terminal' ? TERMINAL_D : tone === 'sdk' ? SDK_D : CLI_D;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={`ua-ico ${tone}`} style={style} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
