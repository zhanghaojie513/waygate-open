import { cssVars } from '../bits';

/**
 * 快速开始。三步 + 一段「首次启动输出」终端记录。
 *
 * 终端记录刻意放在步骤之后：用户此刻真正会问的是「跑起来之后我会看到什么」。
 * 先把结果给出来，比把步骤再讲一遍有用。
 *
 * [注意 task#44] 内容必须与实际一致：Ubuntu + **systemd 服务**（不是容器）；
 * 首次启动**只**打印管理口令 —— 不存在「默认 API Key」（Key 在控制台新建）。
 * 终端里那几行照抄后端**真实**的启动输出（admin-credential.service.ts / main.ts），
 * 不编造格式。
 *
 * `--type` 版本号取自 /healthz（与顶栏胶囊同源），避免同一页出现两个版本号。
 */
export function Quickstart({ version }: { version: string }) {
  return (
    <section className="section" id="quickstart">
      <div className="wrap">
        <div className="sec-head reveal">
          <div>
            <div className="eyebrow">
              <span className="idx">03</span>快速开始
            </div>
            <h2 className="display-2" style={{ marginTop: 20 }}>三步，十分钟内跑起来</h2>
          </div>
          <p className="lead">自己的一台机器就够。首次启动打印管理口令（只显示一次），客户端的 Key 在控制台新建。</p>
        </div>

        <ol className="steps">
          <li className="reveal">
            <div className="st-n">01</div>
            <h3>部署服务</h3>
            {/* [task#68] 「（自签 CA）」只在 IP 直连通道为真（域名通道是公共 CA，见 bits.tlsLabel），
                故这里只陈述恒成立的事实：TLS 由外层 nginx 终止。
                [2026-10-17 评审修] 步骤一此前没有任何可执行的动作（「装成 systemd 服务」
                是描述不是命令）—— 补 clone + build 的安装链，与 Hero/CTA 的承诺对齐。 */}
            <p>克隆仓库，构建前后端，装成 systemd 服务（nginx 在外层终止 TLS）。首次启动即打印管理口令。</p>
            <div className="cmd" style={{ marginTop: 8 }}>git clone … → npm ci → npm run build → systemctl start</div>
          </li>
          <li className="reveal" style={cssVars({ '--i': 1 })}>
            <div className="st-n">02</div>
            <h3>生成密钥</h3>
            <p>在控制台「客户端与密钥」页新建密钥，按客户端命名，可以随时停用或删除。</p>
            <div className="cmd">控制台 → 客户端与密钥 → 新建密钥</div>
          </li>
          <li className="reveal" style={cssVars({ '--i': 2 })}>
            <div className="st-n">03</div>
            <h3>填进客户端</h3>
            <p>把 base_url 填成控制台的同源地址，模型名照抄，其余代码不用改。</p>
          </li>
        </ol>

        <div className="term reveal">
          <div className="term-bar">
            <i className="dot dot-live" style={{ color: 'var(--signal-live)' }} />
            <span>首次启动输出</span>
            <span className="term-tag">relay · v{version}</span>
          </div>
          <div className="term-body">
            <div className="tl"><span className="pr">$</span> sudo systemctl start relay</div>
            <div className="tl out">Waygate · 首次启动，已生成管理口令（此口令只显示这一次）</div>
            <div className="tl out">
              口令：<span className="hl">••••••••••••••••</span>
            </div>
            <div className="tl out">请立即复制保存。忘记口令时：控制台「设置 → 管理口令」重置。</div>
            <div className="tl ok">Waygate 已在 http://127.0.0.1:8787 就绪（默认仅回环，不对公网直接暴露）</div>
          </div>
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:72:d9d6e449
