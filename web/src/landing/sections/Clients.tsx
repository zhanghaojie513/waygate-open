import { cssVars, tlsLabel } from '../bits';
import { accessBaseUrl } from '../../lib/accessUrl';

/**
 * 客户端配置。三张配置卡 + 规格条。
 *
 * 代码块 `.code` 是 `white-space: pre-wrap` —— 换行与缩进必须**逐字节写死**
 * （JSX 会吃掉行首空白），因此每段都用 `{'\n'}` 与字符串字面量拼出，
 * 而不是靠源码缩进。这样渲染结果与原型完全一致，且长行允许折行（见 landing.css 说明）。
 *
 * [注意] 这里只演示**真实存在**的接法。Relay 现在暴露两个入口：
 *   · `POST /v1/chat/completions`（OpenAI 兼容）—— 客户端填的地址**要带** `/v1`
 *   · `POST /v1/messages`（Anthropic Messages 兼容，task #48 起）—— base **不带** `/v1`
 *     （Anthropic SDK 自己拼 `/v1/messages`）。两者是**同一批模型**的两个入口。
 * 措辞边界：Anthropic 那侧是本服务**新增的翻译层**（Anthropic 形状 ⇄ 上游的
 * Chat Completions）；**上游订阅本身只有 Chat Completions**。所以只写
 * 「提供 Anthropic Messages 兼容端点」，**不写**「支持 Claude Code 全部功能」这类断言 —— 未验证。
 * 地址与所在页面同源，由 `lib/accessUrl` 现算，绝不硬编码。
 */
const CAM = '{"x":148,"y":-94,"z":-630,"rx":6,"ry":-11,"rz":-2.5,"fog":0.60,"dim":0.34}';

/** 示例密钥：格式与真实一致（`sk-waygate-<hex>`），是占位符，不是可用密钥。 */
const KEY = 'sk-waygate-4f9c2a7e1b83d04f391c7a2e';
/** 接入地址（含 `/v1`）——从当前页面现算。OpenAI 兼容端点填这个。 */
const BASE_V1 = accessBaseUrl();
/**
 * Anthropic 兼容端点填的 base —— **不带** `/v1`（Anthropic SDK 自己拼 `/v1/messages`）。
 * 仍从 `accessBaseUrl()` 派生（唯一事实来源），只剥掉尾部 `/v1`，绝不另写字面量。
 */
const BASE_ANTHROPIC = accessBaseUrl().replace(/\/v1$/, '');

/**
 * 规格条。四项都必须**真实存在**：
 *   · 兼容协议 —— 两个入口（OpenAI 兼容 + Anthropic 兼容），见本文件顶部说明；
 *   · 接入方式 —— 证书来源按当前地址现算（域名=公共 CA / IP 直连=自签，见 bits.tlsLabel）。
 *     [task#68] 原先写死「公共 CA」，与 Hero 接入卡写死的「自签证书」**互相矛盾**，且
 *     两条通道各只有一边为真；改为与地址同源现算后两边一致。
 *   · 统计口径 —— [task#68] 替换掉不实的「积分同步 30s」（上游无额度接口，#57）。
 *     控制台所有指标都由本机请求日志聚合得出（overview.service 只读本地行）。
 *   · 日志存储 —— 本地 SQLite（`RELAY_DATA_DIR/relay.db`）。
 */
const SPECS = [
  { k: '兼容协议', v: 'OpenAI v1 · Anthropic' },
  { k: '接入方式', v: `HTTPS · ${tlsLabel()}` },
  { k: '统计口径', v: '本机日志聚合' },
  { k: '日志存储', v: '本地' },
];

export function Clients() {
  return (
    <section className="section" id="clients" data-cam={CAM}>
      <div className="wrap">
        <div className="sec-head reveal">
          <div>
            <div className="eyebrow">
              <span className="idx">04</span>客户端配置
            </div>
            <h2 className="display-2" style={{ marginTop: 20 }}>四处填好，立刻能用</h2>
          </div>
          <p className="lead">所有客户端都只需要一个地址加一个密钥。下面是最常见的四种接法。</p>
        </div>

        <div className="grid-2">
          <div className="glass glass-soft cfg reveal">
            <h3>编程工具 / IDE</h3>
            <div className="sub">Continue · Cline · 任意 OpenAI 兼容插件</div>
            <div className="code">
              {'OPENAI_BASE_URL='}<span className="s">{BASE_V1}</span>
              {'\nOPENAI_API_KEY='}<span className="s">{KEY}</span>
              {'\nOPENAI_MODEL='}<span className="s">kimi-k3</span>
            </div>
          </div>

          <div className="glass glass-soft cfg reveal" style={cssVars({ '--i': 1 })}>
            <h3>桌面聊天客户端</h3>
            <div className="sub">Cherry Studio · LobeChat</div>
            <div className="code">
              {'base_url = '}<span className="s">{BASE_V1}</span>
              {'\napi_key  = '}<span className="s">{KEY}</span>
              {'\nmodel    = 从下拉列表选择\n'}<span className="c"># 图形界面里填这三格</span>
            </div>
          </div>

          <div className="glass glass-soft cfg reveal" style={cssVars({ '--i': 2 })}>
            <h3>自己的代码 / 脚本</h3>
            <div className="sub">任意 OpenAI 兼容 SDK</div>
            <div className="code">
              <span className="k">from</span>{' openai '}<span className="k">import</span>
              {' OpenAI\nclient = OpenAI(\n    base_url='}
              <span className="s">&quot;{BASE_V1}&quot;</span>
              {',\n    api_key='}
              <span className="s">&quot;{KEY}&quot;</span>
              {')'}
            </div>
          </div>

          {/* [task#57] Anthropic Messages 兼容端点。放在**最后**一张卡，
              以免改变 `.cfg` / `.cfg h3` / `.cfg .sub` / `.cfg .code` 这些
              「取首个匹配」的选择器所解析到的元素（verify-landing.mjs 用 querySelector）。
              base **不带** `/v1`（与上面 OpenAI 那套相反）—— 这是最易填错的一点。 */}
          <div className="glass glass-soft cfg reveal" style={cssVars({ '--i': 3 })}>
            <h3>Anthropic 兼容</h3>
            <div className="sub">Claude Code · 任意 Anthropic 兼容客户端</div>
            <div className="code">
              {'ANTHROPIC_BASE_URL='}<span className="s">{BASE_ANTHROPIC}</span>
              {'\nANTHROPIC_API_KEY='}<span className="s">{KEY}</span>
              {'\nANTHROPIC_MODEL='}<span className="s">deepseek-v4.1-flash</span>
              {'\n'}<span className="c"># base 不带 /v1；鉴权头 x-api-key（也兼容 Authorization: Bearer）</span>
            </div>
          </div>
        </div>

        {/* [task#57] 把两个入口的 `/v1` 差异**并列**讲清，并给出翻译层边界 ——
            防止有人误以为上游原生支持 Anthropic。 */}
        <div className="cfg-note reveal" style={cssVars({ '--i': 4 })}>
          <div className="cfg-note-row">
            <span className="k">OpenAI 兼容</span>
            <code>POST /v1/chat/completions</code>
            <span className="v">base 填 <b>{BASE_V1}</b>（<b>带</b> /v1）</span>
          </div>
          <div className="cfg-note-row">
            <span className="k">Anthropic 兼容</span>
            <code>POST /v1/messages</code>
            <span className="v">base 填 <b>{BASE_ANTHROPIC}</b>（<b>不带</b> /v1，SDK 自己拼 /v1/messages）</span>
          </div>
          <p className="cfg-note-foot">
            两者是<b>同一批模型</b>的两个入口，模型 ID 沿用同一批（如 deepseek-v4.1-flash），不是 claude-*。
            错误体为 Anthropic 形状：<code>{'{"type":"error","error":{"type":"…","message":"…"}}'}</code>。
            {' '}
            {/* [task#68] 原句「证书是公共 CA，不需要导入任何根证书」只在**域名**通道为真；
                IP 直连是自签证书。两条通道并存，故两句一起说清（详见 bits.tlsLabel）。 */}
            证书由外层 nginx 终止：走域名是<b>公共 CA</b>（无需导入任何根证书）；
            走 <b>IP 直连</b>是<b>自签证书</b>（需先信任 CA，或改用域名访问）。
          </p>
          <p className="cfg-note-foot">
            说明：Anthropic 这侧是本服务<b>新增的翻译层</b>（Anthropic 形状 ⇄ 上游的 Chat Completions）——
            <b>上游订阅本身只有 Chat Completions</b>，我们实测 <code>POST /v2/messages</code> 是 404。
            这里只承诺「提供 Anthropic Messages 兼容端点」，不保证任何具体客户端的全部功能。
          </p>
        </div>

        <div className="specbar reveal" style={cssVars({ '--i': 5 })}>
          {SPECS.map((s) => (
            <div key={s.k}>
              <div className="k">{s.k}</div>
              <div className="v">{s.v}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:153:ea880c4b
