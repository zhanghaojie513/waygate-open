import type { CSSProperties } from 'react';
import { BrandMark } from '../../components/BrandMark';
import type { LandingStatus } from '../data';
import { consoleHref } from '../../lib/consoleRoute';

/**
 * 页脚。三列（品牌 + 开始 + 控制台）+ 一条底线。
 *
 * [注意] 底线中间那句**免责声明是必须的**（Spec §6）：
 *    「个人自用工具，与 WorkBuddy / 腾讯无隶属关系」
 * 它是一个本地反代工具，明确这不是官方产品，避免被当成官方服务。
 *
 * 状态胶囊跟随 /healthz：离线时转琥珀，与首屏、接入卡保持同一套语义色。
 */
const CAM = '{"x":0,"y":-50,"z":-370,"rx":4,"ry":0,"rz":0,"fog":0.66,"dim":0.26}';

const BRAND_B: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 18,
  color: 'var(--text-primary)',
};
const BRAND_EN: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: 'var(--track-eyebrow)',
  color: 'var(--text-ghost)',
};

export function Footer({ status }: { status: LandingStatus }) {
  const { online, version } = status;
  const pill = online ? 'pill pill-live' : 'pill pill-amber';

  return (
    <footer className="footer" data-cam={CAM}>
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <BrandMark size={26} id="relay-mark-footer" />
              <b style={BRAND_B}>途关</b>
              <span style={BRAND_EN}></span>
            </div>
            <p>
              自用反代：把 WorkBuddy 订阅积分<br />
              变成任何客户端都能用的 OpenAI 接口。
            </p>
            <span className={pill}>
              <i className={online ? 'dot dot-live' : 'dot'} />
              {online ? '服务运行中' : '服务离线'}
            </span>
          </div>

          <div className="foot-col">
            <h5>开始</h5>
            <a href="#quickstart">快速开始</a>
            <a href="#clients">客户端配置</a>
            <a href="#status">运行状态</a>
          </div>

          <div className="foot-col">
            <h5>控制台</h5>
            <a href={consoleHref('requests')}>请求日志</a>
            <a href={consoleHref('keys')}>API Keys</a>
            <a href={consoleHref('settings')}>设置</a>
          </div>
        </div>

        <div className="foot-bar">
          <span>Waygate · 本地部署，数据不外发</span>
          <span>个人自用工具，与 WorkBuddy / 腾讯无隶属关系</span>
          <span>v{version} · MIT License</span>
        </div>
      </div>
    </footer>
  );
}
// @zbiti-ai:f:77:0db40508
