import type { LandingStatus } from '../data';
import { cssVars, DOT_COLOR, tlsLabel } from '../bits';
import { formatTokens } from '../../lib/format';
import { CopyButton } from '../CopyButton';
import { accessBaseUrl } from '../../lib/accessUrl';
import CountUp from '../bits/CountUp.jsx';
import { ScenePrism } from '../ScenePrism';

/**
 * 部署片段 —— 与实际形态一致：Ubuntu + **systemd 服务**（不是容器），
 * TLS 由外层 nginx 终止（域名用公共 CA、IP 直连用自签，见 `bits.tlsLabel`）。
 * 命令都是真实可跑的 `systemctl`，不再出现 docker 镜像 / ports —— 那是一段并不存在的部署方式。
 */
const DEPLOY = [
  '# 克隆并构建',
  'git clone <仓库地址> && cd relay-station',
  'npm ci --prefix server && npm run build --prefix server',
  'npm ci --prefix web && npm run build --prefix web',
  '',
  '# 启动 systemd 服务（TLS 由 nginx 终止）',
  'sudo systemctl start relay',
].join('\n');

/** 首屏。左栏正文 + 右栏接入卡 + 全页唯一一块厚玻璃（产品面板）。 */
export function Hero({ status }: { status: LandingStatus }) {
  const { online, real, numbers } = status;
  /* 接入地址与所在页面同源 —— 现算，绝不硬编码（换域名/端口自动跟着变）。 */
  const baseUrl = accessBaseUrl();
  /* 首屏可见的两个数字都出自控制台真有的指标。tokens 走紧凑记法（1.93M），
     与「当前运行状态」那条数据带、以及控制台概览卡**同一数字同一出处**
     （task#67：原先徽标与右侧面板都在展示已被删除的「剩余积分」）。 */
  const tokensText = numbers.totalTokens == null ? '—' : formatTokens(numbers.totalTokens);

  const badgeVars = online
    ? undefined
    : cssVars({
        color: 'var(--warn-amber)',
        background: 'color-mix(in srgb, var(--warn-amber) 7%, transparent)',
        borderColor: 'var(--warn-amber-line)',
      });

  return (
    <header className="hero" id="top">
      <div className="wrap">
        <div className="hero-grid">
          <div className="hero-inner">
            <div className="hero-badge reveal" style={badgeVars}>
              <i
                className={online ? 'dot dot-live' : 'dot'}
                style={{ color: online ? DOT_COLOR.live : DOT_COLOR.offline }}
              />
              {online ? '服务运行中' : '服务离线'} · 本窗口 tokens{' '}
              <span className="n">{tokensText}</span>
              {real ? null : '（示例）'}
            </div>

            <div className="hero-title reveal">
              <h1 className="hero-h1 display-1">
                <span className="rv-line"><span style={cssVars({ '--i': 0 })}>把自己的订阅积分</span></span>
                <span className="rv-line">
                  <span style={cssVars({ '--i': 1 })}>
                    <em className="bridge">变成一个</em>{' '}
                    <span className="mk lit">base_url</span>
                  </span>
                </span>
              </h1>
              <div className="hero-flip" aria-hidden="true">
                <h1 className="hero-h1 display-1">
                  把自己的订阅积分<br />
                  <em className="bridge">变成一个</em> <span className="mk lit">base_url</span>
                </h1>
              </div>
            </div>

            <p className="hero-sub reveal" style={cssVars({ '--i': 3 })}>
              部署在你自己机器上，把你的 AI 订阅积分（WorkBuddy / MiniMax / Qoder）暴露成 OpenAI 兼容接口。
              IDE、聊天客户端、手机、脚本共用同一个 Key，积分消耗实时可见。
            </p>

            <div className="hero-acts reveal" style={cssVars({ '--i': 4 })}>
              <CopyButton
                className="btn btn-primary"
                text={DEPLOY}
                label="复制部署命令"
                idle="复制部署命令"
              />
              <a className="btn btn-ghost" href="#clients">查看客户端配置</a>
            </div>

            <div className="trust reveal" style={cssVars({ '--i': 5 })}>
              {/* [注意] 这三条是安全/隐私承诺，必须与事实一致 —— 官网上写着的东西用户是会照着信的。
                  曾写「只监听本机与局域网」：应用确实只监听回环，但**对外是由 nginx 暴露的**，
                  那句话会让人以为它不在公网上可达（实际上 8443 就在公网）。已改为只陈述
                  「应用自身只监听回环」这一件为真的事，对外暴露方式交给 Ways.tsx 的长句说清楚。
                  曾写「密钥不经过第三方」：请求**本来就要发往上游**（那正是本产品的用途），
                  这句话含混得会被读成"流量不出本机"。已改为陈述"直连上游、无中转服务"。 */}
              <span>只监听本机回环</span>
              <span>外发直连上游，无中转</span>
              <span>请求日志保存在本地</span>
            </div>
          </div>

          {/* [v5] 右栏从「接入卡」改为「棱镜装置」。
              为什么：官网首屏最该被记住的是那个视觉（白光穿过玻璃散成七色），
              而接入地址是可复制的文字 —— 它不需要占首屏的一半。
              接入卡移到 Hero 下方（见 hero-access 段），信息一个没少。 */}
          <aside className="hero-side reveal" style={cssVars({ '--i': 2 })}>
            <div className="hero-scene">
              <ScenePrism variant="inline" />
            </div>
            <p className="scene-note">一束白光穿过棱镜散成七色 —— 也正是三路订阅分给七个客户端的样子</p>
          </aside>
        </div>

        {/* [v5] 接入卡从右栏移到这里：它是有用的信息，但不是首屏的主角。
            右栏让给棱镜装置（首屏最该被记住的视觉），地址/协议/TLS 读完
            「这是什么」之后自然过渡到「怎么接」。信息一个没少。 */}
        <div className="hero-access reveal" style={cssVars({ '--i': 6 })}>
          <div className="access-h">
            <span className="eyebrow" style={cssVars({ '--c': 'var(--text-ghost)' })}>接入地址</span>
            <span className={online ? 'pill pill-live' : 'pill pill-amber'}>
              <i className={online ? 'dot dot-live' : 'dot'} />
              {online ? '可用' : '离线'}
            </span>
          </div>
          <div className="access-url">
            <code>{baseUrl}</code>
            <CopyButton className="copy" text={baseUrl} label="复制接入地址" />
          </div>
          <div className="access-note">把它填进任何支持 OpenAI 兼容协议的工具</div>
          <dl className="kv">
            <div><dt>协议</dt><dd>OpenAI v1 · Anthropic</dd></div>
            <div><dt>日志保留</dt><dd>默认 30 天</dd></div>
            <div><dt>TLS</dt><dd>{tlsLabel()}</dd></div>
            <div><dt>部署形态</dt><dd>systemd + nginx</dd></div>
          </dl>
        </div>

        <div className="panel-wrap glass reveal" style={cssVars({ '--i': 6 })}>
          <div className="panel-left">
            <div className="winbar">
              <i style={{ background: 'var(--danger-red)' }} />
              <i style={{ background: 'var(--warn-amber)' }} />
              <i style={{ background: 'var(--signal-live)' }} />
              <span className="fname">deploy.sh</span>
              <span className="wtag">SHELL</span>
              <span className="wsp" />
              <CopyButton className="wbtn" text={DEPLOY} />
            </div>
            <div className="panel-code">
              <div className="cl"><i>1</i><span><span className="c"># Ubuntu + systemd（TLS 由 nginx 终止）</span></span></div>
              <div className="cl"><i>2</i><span><span className="fn">$ sudo systemctl start relay</span></span></div>
              <div className="cl"><i>3</i><span><span className="fn">$ sudo systemctl status relay</span></span></div>
              <div className="cl"><i>4</i><span><span className="fn">$ sudo systemctl restart relay</span></span></div>
              <div className="cl hl">
                <i>5</i>
                <span><span className="c"># 首次启动打印管理口令（仅此一次）</span></span>
              </div>
              <div className="cl"><i>6</i><span><span className="c"># API Key 在控制台「客户端与密钥」页新建</span></span></div>
            </div>
          </div>

          <div className="panel-right">
            <div className="pr-head">
              <h4>连接状态</h4>
              {/* [2026-10-07] 官网其它数字都有「示例数据」标注纪律（Spec §5），这块连接列表示意
                  数据同样标「示例」，不冒充真实在线状态。
                  [2026-10-17 评审修] 离线时标注「服务离线」替代「示例」——
                  同一页面不能同时宣称「离线」与「3 个在线」。 */}
              <span className="pr-count">{online ? '示例 · 3 个客户端' : '服务离线'}</span>
            </div>
            <div className="conn">
              <i className="dot dot-live" style={{ color: DOT_COLOR.live }} />
              <span className="cname">Claude Code</span>
              <span className="dev">本机</span>
              <span className="lat">12ms</span>
              <span className="pill pill-live">在线</span>
            </div>
            <div className="conn">
              <i className="dot dot-live" style={{ color: DOT_COLOR.live }} />
              <span className="cname">Cherry Studio</span>
              <span className="dev">桌面</span>
              <span className="lat">48ms</span>
              <span className="pill pill-live">在线</span>
            </div>
            <div className="conn">
              <i className="dot" style={{ color: DOT_COLOR.offline }} />
              <span className="cname">Cursor</span>
              <span className="dev">笔记本</span>
              <span className="lat">—</span>
              <span className="pill pill-amber">待机</span>
            </div>
            <div className="panel-metrics">
              {/* [v8] 数字滚动用 reactbits 的 CountUp（roll 模式：逐位滚轮 + 运动模糊）。
                  compact format 自动给 tokens 出 K/M 单位，与原 formatTokens 同形。
                  null（取不到）仍显示 —，不拿 0 冒充。 */}
              <div>
                <div className="k">本窗口 tokens</div>
                <div className="v num live" style={{ color: DOT_COLOR.live }}>
                  {numbers.totalTokens == null ? '—' : <CountUp to={numbers.totalTokens} mode="roll" format="compact" duration={1.6} />}
                </div>
              </div>
              <div>
                <div className="k">缓存命中率</div>
                <div className="v num">{numbers.cacheHitRate == null ? '—' : <CountUp to={numbers.cacheHitRate * 100} mode="roll" duration={1.4} decimals={1} suffix="%" />}</div>
              </div>
              <div>
                <div className="k">今日请求</div>
                <div className="v num">{numbers.requestsToday == null ? '—' : <CountUp to={numbers.requestsToday} mode="roll" duration={1.8} separator="," />}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="scroll-cue"><span className="tick" />SCROLL</div>
    </header>
  );
}
// @zbiti-ai:f:199:c3025f8a
