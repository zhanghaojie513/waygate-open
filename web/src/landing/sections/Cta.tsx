import { cssVars } from '../bits';
import { consoleHref } from '../../lib/consoleRoute';
import { CopyButton } from '../CopyButton';

/**
 * 转化区。场景在这里最亮（相机冲向灭点），所以内容背后垫了一层局部压暗
 * （`.cta::before`，见 landing.css）。
 *
 * 命令行的 `data-type` 交给 page.ts 做打字机 —— 它只在进入视口时接管，
 * 此前显示的就是完整命令；`prefers-reduced-motion` 下 page.ts 直接不动它。
 * React 不会因此产生 diff：虚拟 DOM 里始终是同一个字符串，重渲染不会去改这段 textContent。
 */
const CAM = '{"x":0,"y":-96,"z":-130,"rx":-3,"ry":0,"rz":0,"fog":0.30,"dim":0.92}';
const CMD = 'git clone <仓库地址> && cd relay-station && npm ci && npm run build';

export function Cta() {
  return (
    <section className="cta" id="cta" data-cam={CAM}>
      <div className="wrap">
        <h2 className="display-2 reveal">几步，起在你自己机器上</h2>

        <div className="cmdbox reveal" style={cssVars({ '--i': 1 })}>
          <span className="pr">$</span>
          <span data-type={CMD}>{CMD}</span>
        </div>

        <p className="note reveal" style={cssVars({ '--i': 2 })}>
          首次启动打印管理口令（只显示一次），之后可在控制台重置。客户端用的 API Key 在控制台新建。
        </p>

        <div className="acts reveal" style={cssVars({ '--i': 3 })}>
          <CopyButton
            className="btn btn-primary"
            text={CMD}
            label="复制部署命令"
            idle="复制部署命令"
          />
          <a className="btn btn-ghost" href={consoleHref()}>打开控制台</a>
        </div>

        <div className="trust reveal" style={cssVars({ '--i': 4 })}>
          <span>Ubuntu + systemd</span>
          {/* [task#68] 原写「nginx 终止 TLS（自签 CA）」——只在 IP 直连通道为真；
              域名通道是 Let's Encrypt 公共 CA（#49）。两条通道并存，这里不再写死证书类型，
              证书与信任方式在「客户端配置」区按当前地址给全。 */}
          <span>nginx 终止 TLS</span>
          <span>请求日志留在本机</span>
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:46:0c5430ab
