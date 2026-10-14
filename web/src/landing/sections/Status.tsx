import type { LandingStatus } from '../data';
import { numProps } from '../bits';
import { formatTokens } from '../../lib/format';

/**
 * 当前运行状态（无卡片的数据带）。
 *
 * 数字来源见 data.ts：已登录 → /api/overview 真实值；未登录 → 示例值。
 * **未登录时必须标注**（Spec §5）：在章节标题行右侧补一枚「示例数据」胶囊。
 * 这是相对原型唯一的内容性增补 —— 原型没有登录态概念，而契约要求标注，
 * 因此把标注放在标题行内（不新增行高、不移动四个数字），把像素位移压到最小。
 *
 * [task#67] 前两格从「订阅剩余积分 / 距积分重置」换成控制台**真有的**指标
 * （对齐 task#62：本窗口总 tokens + 缓存命中率）。原型那两格承诺的是一个
 * 上游根本没提供的数（额度端点 404，`quota.available` 恒 false）—— 页面上
 * 永远只能渲染 `—`，等于把「取不到」伪装成「待加载」。四格结构保持不变。
 */
const CAM = '{"x":18,"y":-128,"z":-390,"rx":-7,"ry":-3,"rz":0,"fog":0.46,"dim":0.46}';

export function Status({ status }: { status: LandingStatus }) {
  const { real, numbers } = status;
  /* 本窗口 tokens 用紧凑记法（1.93M）——与「积分与用量」页的概览卡同一格式，
     且 54px 的大字号下 7 位原始数字（1,930,000）自然宽 >260px，会撑破 1fr 单元格。
     它是格式化后的字符串、不参与数字滚动，所以直接落文本（其余三格仍走 numProps）。 */
  const tokensText = numbers.totalTokens == null ? '—' : formatTokens(numbers.totalTokens);

  return (
    <section className="section band" id="status" data-cam={CAM}>
      <div className="wrap">
        <div
          className="reveal"
          style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}
        >
          <div className="eyebrow">
            <span className="idx">05</span>当前运行状态
          </div>
          {real ? null : (
            /* [注意] 绝对定位是**刻意的**：未登录时本区块必须标注「示例数据」（Spec §5），
               但标注不能改变原型的居中版式。绝对定位不参与布局，所以章节高度、
               眉标的水平位置与原型逐像素一致（否则整段会下移 2px、眉标左移 39px）。 */
            <span className="pill pill-amber" style={{ position: 'absolute', right: 0, top: 0 }}>
              示例数据
            </span>
          )}
        </div>
        <div style={{ height: 44 }} />
        <div className="status-strip reveal">
          <div>
            <div className="v num live">{tokensText}</div>
            <div className="k">本窗口 tokens</div>
          </div>
          <div>
            <div className="v num">
              <span {...numProps(numbers.cacheHitRate, 1, 'cacheHitRate')} />
              <span className="unit">%</span>
            </div>
            <div className="k">缓存命中率</div>
          </div>
          <div>
            <div className="v num" {...numProps(numbers.requestsToday, 0, 'requestsToday')} />
            <div className="k">今日请求数</div>
          </div>
          <div>
            <div className="v num">
              <span {...numProps(numbers.successRate, 1, 'successRate')} />
              <span className="unit">%</span>
            </div>
            <div className="k">今日成功率</div>
          </div>
        </div>
      </div>
    </section>
  );
}
// @zbiti-ai:f:74:4977c9bb
