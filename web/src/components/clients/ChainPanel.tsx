import { ArrowRight } from 'lucide-react';

/**
 * 链路卡 —— 「客户端与密钥」页的**第一块**。
 *
 * ## 它为什么必需（不是可有可无的说明文字）
 *
 * 接入密钥与上游访问密钥都叫「密钥」、都会因到期导致 401、都带到期日 ——
 * 但**方向完全相反**：前者决定**谁能进来**（入站，可多把），后者决定
 * **额度**（出站，只有 1 把）。界面上没有一句话画出这条链路时，
 * 最危险的误解就会发生：用户以为「新建一个密钥能多一条上游通道」。
 * 实际上加一把接入密钥**不增加任何积分额度**，只多一个能进来的入口，
 * 也就多一个要保管的东西。
 *
 * ## 文案是契约，不是文案
 *
 * `spec-v4-upstream-placement.md` §2 把这两句**逐字锁定**（两侧一致），
 * 改词会让实现与设计稿漂移 —— 要动先改契约。
 *
 * [2026-10-09] 链路**终点**随提供商走（`providerName`）：原来硬编码 WorkBuddy，
 * 有了多提供商后切到别家，图上却仍写着 WorkBuddy —— 图在说谎。
 * 兜底仍是 WorkBuddy（默认种子名，也是 providers 列表加载完成前的首帧）。
 */
export function ChainPanel({ providerName = 'WorkBuddy' }: { providerName?: string }) {
  return (
    <div className="card chain">
      <div className="chain-flow">
        <span className="cd">你的客户端</span>
        <span className="lk">
          <b>接入密钥</b>
          <ArrowRight size={12} aria-hidden />
        </span>
        <span className="cd here">Waygate</span>
        <span className="lk up">
          <b>上游访问密钥</b>
          <ArrowRight size={12} aria-hidden />
        </span>
        <span className="cd">{providerName}</span>
      </div>

      <p className="chain-note">
        接入密钥决定<b>谁能进来</b>，可以有很多把；积分额度只由<b>上游访问密钥</b>决定，只有 1 把。
        <b>加一把接入密钥不会增加任何积分额度</b>，只是多一个能进来的入口，也就多一个要保管的东西。
      </p>

      {/* 指路：改判后上游访问密钥与本页同页（spec §1），这里写清它在页面上的位置 */}
      <p className="chain-note chain-where">
        上游访问密钥就在<b>本页</b>、密钥列表上方的「提供商」面板里 —— 不在密钥表内。
      </p>
    </div>
  );
}
// @zbiti-ai:f:48:941fe2c3
