import type { CSSProperties } from 'react';
import { cssVars } from '../bits';

/**
 * 运行方式。左侧粘性标题 + 右侧 4 条线项（发丝线分隔，不用卡片）。
 *
 * 图标是**内联 SVG 线稿**：原型如此，且这 4 个图形不在任何通用图标库里
 * （「单向阀」「订阅同步」「盾牌」是这一页的私有语义）。描边色只有一个 ——
 * 原型写死了电光青的十六进制值；这里改用 currentColor + `--accent-cyan` 令牌，
 * 满足「组件样式零色值字面量」（铁律 A：换一次品牌色，它必须跟着动）。
 */
const ICON: CSSProperties = { color: 'var(--accent-cyan)' };
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;

export function Ways() {
  return (
    <section className="section" id="ways">
      <div className="wrap">
        <div className="split">
          <div className="split-l reveal">
            <div className="eyebrow">
              <span className="idx">02</span>运行方式
            </div>
            <h2 className="display-2">
              一个进程，<br />管住所有客户端的积分
            </h2>
            <p>不用为每个客户端单独登录、单独算积分。服务跑在你自己的机器上，所有请求走同一个出口。</p>
          </div>

          <ul className="linelist">
            <li className="reveal">
              <span className="ll-ico">
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={ICON} {...S}>
                  <circle cx="6.5" cy="10" r="3.5" />
                  <path d="M10 10h8M15 10v3M17.5 10v3" strokeLinecap="round" />
                </svg>
              </span>
              <span className="ll-tx">
                <b>一个 Key，多端共用</b>
                <i>桌面客户端、IDE、手机、脚本共用同一个密钥，控制台按客户端拆开看用量。</i>
              </span>
            </li>
            <li className="reveal" style={cssVars({ '--i': 1 })}>
              <span className="ll-ico">
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={ICON} {...S}>
                  <path d="M4 10h4M12 10h4" strokeLinecap="round" />
                  <circle cx="10" cy="10" r="2" />
                  <path d="M12 10V5.5M12 10v4.5" strokeLinecap="round" />
                </svg>
              </span>
              <span className="ll-tx">
                <b>请求只在你自己的机器上流转</b>
                <i>应用默认只监听本机回环，对外由你自己的 nginx 暴露，没有第三方中转。</i>
              </span>
            </li>
            <li className="reveal" style={cssVars({ '--i': 2 })}>
              <span className="ll-ico">
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={ICON} {...S}>
                  <rect x="2" y="4.5" width="16" height="11" rx="2.5" />
                  <path d="M2 8.5h16" />
                  <path d="M4.5 13h4" strokeLinecap="round" />
                </svg>
              </span>
              <span className="ll-tx">
                <b>用量与消耗实时同步</b>
                <i>本窗口总 tokens、缓存命中率、每条请求消耗多少积分，控制台里一眼看清。</i>
              </span>
            </li>
            <li className="reveal" style={cssVars({ '--i': 3 })}>
              <span className="ll-ico">
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={ICON} {...S}>
                  <path
                    d="M10 2.5 16.5 5v5c0 4-2.8 6.4-6.5 7.5C6.3 16.4 3.5 14 3.5 10V5L10 2.5Z"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="ll-tx">
                <b>请求日志与超限保护</b>
                <i>每条请求都落库、可回溯；超过并发上限时直接回 429，失败不会被静默吞掉。</i>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:90:ec29e8b1
