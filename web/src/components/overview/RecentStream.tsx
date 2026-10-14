import type { RequestLogRow } from '../../types/api';
import { formatClock, formatDuration, noteLabel, statusTone } from '../../lib/format';

/** 状态码语义色 —— 对应原型 `.c-code.ok / .warn / .bad`。 */
const TONE_COLOR = {
  live: 'var(--signal-live)',
  warn: 'var(--warn-amber)',
  fatal: 'var(--danger-red)',
  muted: 'var(--text-faint)',
} as const;

/**
 * note 的颜色 —— **照原型的 `.c-note`**：默认 `--text-ghost`，只有 warn / bad 才着色。
 *
 * 刻意**不**直接用 `TONE_COLOR`：`statusTone` 对普通成功行返回 `live`，用 TONE_COLOR 会让
 * 每一行的 note（多为 `-` 或「命中缓存」）都变绿，与 `.c-note { color: var(--text-ghost) }`
 * 的默认态相悖，一屏绿色也不是设计稿的样子。
 */
const NOTE_COLOR = {
  live: 'var(--text-ghost)',
  warn: 'var(--warn-amber)',
  fatal: 'var(--danger-red)',
  muted: 'var(--text-ghost)',
} as const;

/**
 * [task#72] 列宽：`时间 · model · status · 耗时 · note`。
 *
 * 这一行原先写成 `'58px 1fr auto auto'` —— 把 note 与耗时**并进同一格**、给了硬 `width: 62`
 * 且**没有 nowrap**。真实 note 远宽于 62px（如 `stream_options_stripped` → 「已移除 stream_options」，
 * 再加 `·131ms`），于是折成两行；第二行被卡片的 `overflow: hidden` 裁掉，看起来就是"右边超出/被切"。
 *
 * 根因是**丢了原型（console.css `.lg-row` / `.c-note`）的两点**：note 是**独立列**、
 * 且列宽是弹性可缩的 `minmax(0, 1.2fr)`；`.c-note` 还显式 `nowrap + ellipsis`。
 * 设计稿**从结构上就不可能换行**。
 *
 * 这里按原型的做法拆 5 列，**每一列的上下限都从 0 起**（`minmax(0, …)`）：
 *   · `minmax(0, …)` 是定值列唯一的兜底 —— 空间不够时先缩弹性列、再缩定值列，
 *     面板再窄也只会等比收缩 + 省略号，**结构上不可能溢出、不可能换行**；
 *   · 空间够时定值列会各自顶到 58 / 34 / 52，**与定值写法逐像素等价**（实测 720/900/1280 轨道
 *     与 `58px 34px 52px` 完全一致）—— 所以只在极窄时才降级；
 *   · fr 列宽**只由容器决定、与内容无关** ⇒ 每行列宽一致 ⇒ status / 耗时天然竖直对齐
 *     （原来那个 `width: 62` 就是为对齐才写死的，可惜太窄）。
 *
 * 两个弹性列的 `6px` 下限（而非 `minmax(0, 1fr)`）：容器极窄时，grid 会先把**非弹性**列
 * 最大化，弹性列只剩 0 —— 模型名与 note 会**整列消失**（实测 360px 下 cols=[11.47, 0, …, 0]）。
 * 给弹性列一个 6px 地板后变成 cols=[7.47, 6, …, 6]，五列都还在（只是全变省略号）。
 * `minmax(6px, 1fr)` 在任何「弹性列本就能拿到 ≥6px」的宽度下与 `minmax(0, 1fr)` **逐像素等价**
 * （实测 720/900/1280 三档轨道完全相同）。
 */
const GRID = 'minmax(0, 58px) minmax(6px, 1fr) minmax(0, 34px) minmax(0, 52px) minmax(6px, 1.2fr)';

/**
 * 列间距：**在极窄容器里也必须能缩**。
 *
 * 固定 `gap: 10px` 会在列之外再占死 4×10=40px —— 容器一旦窄于 40px，
 * 光是间距就把行顶出面板（实测 360px 视口下「最近请求」只有 39px 宽）。
 * `min(10px, 3%)` 在容器 ≥ 334px 时**恒等于 10px**（与原来逐像素一致），
 * 只有更窄时才按比例退让，间距不再成为溢出下限。
 */
const COL_GAP = 'min(10px, 3%)';

/**
 * 单格：单行 + 溢出省略。**五格都必须带全**。
 *
 * · `whiteSpace: nowrap` —— 少一格就又会折行（这就是原 bug）；
 * · `minWidth: 0` —— grid 子项的 `min-width` 默认是 `auto`，会被内容（nowrap 的整段文本）
 *   顶住而拒绝收窄，只有显式 `0` 才让它跟着轨道一起缩；
 * · `overflow: hidden` + `textOverflow: ellipsis` —— 没有它，盒子虽然被轨道压窄了，
 *   里面的文字仍会**可见地溢出**（`overflow: visible`），依旧把整行撑宽（实测 39px 面板下
 *   行 `scrollWidth` 仍达 61px）。加上之后行宽 == 容器宽，**结构上不可能溢出**。
 */
const CELL = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/**
 * [task#72 / #74] 单元格的等宽字体走 `.cell-mono`（app.css）—— **不要**用 `.code-chip`。
 *
 * 这里原来写的是 `className="mono"`，而 `.mono` 在当时是**行内代码芯片**
 * （`padding:1px 5px` + `--brand-tint` 底 + 圆角 + `font-size:.94em`），
 * 不是"等宽字体工具类"（它本来是给 `CredentialModal` 里 `<span>ck_</span>` 那种用法准备的）。
 * 把这个芯片套到网格单元格上带来两个真实缺陷：
 *   ① 左右各 5px padding（`box-sizing: border-box`）⇒ 每格**不可收缩下限 = 10px**，
 *      五格 50px，比 39px 的面板还宽 —— 这才是"窄面板必然溢出"的直接原因；
 *   ② 每格被画上淡紫底 + 圆角 + 10.81px 字号，与原型 `.log`（整块等宽 11.5px、无底色）不符。
 *
 * [task#74] 该芯片类已按它实际的样子改名为 `.code-chip`；"等宽数字"另立 `.cell-mono`
 * （声明与 tables 用的 `tokens.css .td-mono` 完全相同，只是不限定 `<td>`）。
 * 本组件因此显式挂 `.cell-mono`：不再单靠 `.log` 的继承，语义清楚、也不会再被同名类骗到。
 */

/** 最近请求：紧凑等宽流（对应原型 .log 的 .lg-row），语义着色与日志页一致。 */
export function RecentStream({ rows }: { rows: RequestLogRow[] }) {
  if (rows.length === 0) {
    return <div className="empty-note" style={{ padding: '12px 0' }}>暂无请求记录。</div>;
  }
  return (
    <div className="log" style={{ whiteSpace: 'normal' }}>
      {rows.map((r) => {
        const tone = statusTone(r.status, r.note);
        return (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              columnGap: COL_GAP,
              alignItems: 'center',
              lineHeight: 1.9,
              fontSize: 11.5,
            }}
          >
            <span className="cell-mono" style={{ ...CELL, color: 'var(--text-ghost)' }}>{formatClock(r.ts)}</span>
            <span className="cell-mono" style={{ ...CELL, color: 'var(--text-tertiary)' }}>{r.model}</span>
            <span className="cell-mono" style={{ ...CELL, color: TONE_COLOR[tone], textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {r.status}
            </span>
            <span className="cell-mono" style={{ ...CELL, color: 'var(--text-faint)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {formatDuration(r.ms)}
            </span>
            <span className="cell-mono" style={{ ...CELL, color: NOTE_COLOR[tone] }}>{noteLabel(r.note)}</span>
          </div>
        );
      })}
    </div>
  );
}
// @zbiti-ai:f:131:793a92bb
