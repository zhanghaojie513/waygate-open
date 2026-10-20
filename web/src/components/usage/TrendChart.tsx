import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TrendPoint } from '../../types/api';
import { formatBucket, formatInt, formatTokens } from '../../lib/format';

/** 趋势可看两个量：同一个 `trend` 数组的两个字段，不是两次请求。
 * [v0.5.11] `credits` → `tokens`：积分对 MiniMax 是未知/免费（credits=null 不进合计），
 * token 才是跨提供商的普适量纲 —— 图上看积分会把 MiniMax 的量全部隐掉。 */
export type TrendMetric = 'tokens' | 'requests';

export const METRIC_LABEL: Record<TrendMetric, string> = {
  tokens: '消耗 tokens',
  requests: '请求次数',
};

/**
 * 近 30 天趋势：单一色系（青）+ 一个语义强调（薄荷＝今天）。
 *
 * [audit 2026-10-12] 柱 vs 折线的选择：这是**离散桶**（每小时/每天的量），不是
 * 连续趋势测量 —— 柱是正确形态；黑名单禁的是「连续时间序列用柱墙」。
 * 失败另有红点 + tooltip 数值 + aria-label 三重补充，不靠柱形编码。
 * 数据源是本地日志聚合，不是额度接口 —— 口径在「配额数据来源」卡里摊开。
 * 对应原型 .bars30 / .avgline。
 *
 * `avg` 由调用方传入（用服务端字段算好），**图表不自己求和**：
 * 否则图表里的「日均」和统计条里的「日均」会各算各的，同一页出现两个日均值。
 *
 * [task#54] 悬停提示从**原生 `title` 属性**改成自绘：
 *   原生 `title` 走浏览器默认 tooltip —— 约 1 秒延迟、样式完全不可控、还可能被上层
 *   CSS（`pointer-events` / 覆盖层）挡掉。用户实测的感受就是「移上去没反应」。
 *   现在改成即时跟手的自绘浮层，并且**键盘也能看**（柱可聚焦，←/→/Home/End 漫游，
 *   与鼠标共用同一个浮层）。鼠标与键盘共用一个 `active`，不会互相抢。
 */
export function TrendChart({
  points,
  metric,
  avg,
}: {
  points: TrendPoint[];
  metric: TrendMetric;
  avg: number | null;
}) {
  /* 浮层当前指向的柱；鼠标进入 / 柱获得焦点都会设它，移出即清空。 */
  const [active, setActive] = useState<number | null>(null);
  /* 键盘漫游位置（roving tabindex）：整块图只占**一个** Tab 位，
     否则 30 根柱子会把 Tab 顺序冲垮。null = 还没漫游过，起点取最后一根（今天）。 */
  const [cursor, setCursor] = useState<number | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  /* [v7.0-f] 箭头像素偏移（相对浮层左缘）。null = 还没测，伪元素回落到居中。
     详见浮层渲染处的大段注释 —— 一句话：柱心在图表坐标系，伪元素在浮层坐标系，
     中间差着「浮层被居中/贴边后挪过的距离」，只能实测换算。 */
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipArrow, setTipArrow] = useState<number | null>(null);

  /* 浮层挂上 / 换柱 / 窗口变化后重测：柱心（图表系）→ 浮层左缘（浮层系）。
     依赖里带上 active（换柱）和 metric（浮层内容宽度随口径切换变化，宽度变则左缘变）。 */
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const bars = barsRef.current;
    if (!tip || !bars || active === null || points.length === 0) {
      setTipArrow(null);
      return;
    }
    const measure = () => {
      const barCenterX = ((active + 0.5) / points.length) * bars.clientWidth;
      /* translateX(-50%) 不改变 offsetLeft（布局值），但视觉左缘 = 布局左缘 − 宽/2；
         tip-left/tip-right 贴边时 transform 又不同。两个 rect 同坐标系（都相对视口），
         相减即得浮层系内的箭头偏移 —— 不依赖对 transform 的假设。 */
      const barsRect = bars.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const computed = barCenterX - (tipRect.left - barsRect.left);
      /* 钳制在浮层内缘（12px），箭头跑出浮层会失去与主体的视觉连接。 */
      setTipArrow(Math.max(12, Math.min(computed, tipRect.width - 12)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active, metric, points.length]);

  /* 每根柱的读屏文案只随数据/口径变化，预先算好：
     原先在渲染循环里用的是**悬停那根**（tip）的模型与较前值，每次换柱 30 个 aria-label 全部改写，
     且文案内容也是错的。这里每根柱只用自己的 models 与 points[i-1]。 */
  const ariaLabels = useMemo(
    () =>
      points.map((p, i) => {
        const prevP = i > 0 ? points[i - 1] : null;
        const d = prevP ? (metric === 'tokens' ? p.tokens - prevP.tokens : p.requests - prevP.requests) : null;
        const isHourly = /T\d{2}$/.test(p.bucket);
        const modelSummary = (p.models ?? []).slice(0, 5).map((m) => `${m.model} ${formatTokens(m.tokens)} tokens`).join('、');
        const deltaLabel = d === null ? '' : ` · 较${isHourly ? '上一小时' : '昨日'} ${d > 0 ? '增加' : d < 0 ? '减少' : '持平'}${d === 0 ? '' : ` ${formatInt(Math.abs(d))}`}`;
        return (
          `${formatBucket(p.bucket)} · ${formatInt(p.requests)} 次请求 · ${formatTokens(p.tokens)} tokens` +
          (p.errors > 0 ? ` · ${formatInt(p.errors)} 次失败` : '') +
          (modelSummary ? ` · 模型：${modelSummary}` : '') +
          deltaLabel
        );
      }),
    [points, metric],
  );

  if (points.length === 0) {
    return <div className="empty-note" style={{ padding: '24px 0' }}>该窗口内没有请求记录。</div>;
  }

  const values = points.map((p) => (metric === 'tokens' ? p.tokens : p.requests));
  const max = Math.max(1, ...values);
  const fmt = formatInt;
  /* 日均线落在柱区里的**比例**（0 = 图顶，1 = 图底），夹到 0–1：
     传入的均值与图上量纲不一致时，线会画到框外 —— 那是"图在说谎"，宁可夹住。
     用比例而不是像素：柱区高度是 --chart-h（CSS），改高度时线自己跟着走。
     此前这里算的是 18 + pct*150 的像素值，"150"因此在三处各写了一遍。 */
  const avgFrac = avg === null ? null : Math.round(Math.min(1, Math.max(0, avg / max)) * 1e4) / 1e4;
  /* 轴刻：每 ceil(n/5) 根标一个，末尾补上今天。槽位数 = 柱数（空槽留白），
     标签才会落在对应那根柱的正下方 —— 见 app.css 的 .axis。 */
  const axisStep = Math.ceil(points.length / 5);

  const focusIdx = cursor ?? points.length - 1;

  const onBarsKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = points.length - 1;
    let next: number;
    if (e.key === 'ArrowRight') next = Math.min(last, focusIdx + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, focusIdx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    setCursor(next);
    setActive(next);
    /* ★ 按 data-idx 找列，不用 children[next]：.bars30 的子元素里还有零线（.grid）
       和 tooltip —— 按下标取会**偏一列**（此前键盘漫游其实落在相邻列上，鼠标没事、
       键盘一直错位）。data-idx 只认柱列。 */
    const el = barsRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`) ?? undefined;
    el?.focus();
  };

  /* 浮层水平对齐：首尾两根贴边，其余居中 —— 保证不越过图（也就不会越过卡片）的左右边界。 */
  /* [v0.4.28] tipAlign 已废弃——tooltip 位置改为跟随柱子实际百分比（见 bar-tip 的 --tip-x）。 */
  const tip = active === null ? null : points[active];
  /* 较前值变化：同一 trend 数组相邻两点相减（天级=较昨日，小时级=较上一小时）。
     首个点位没有前值 → 不显示，绝不拿别处的数凑。 */
  const hourly = tip ? /T\d{2}$/.test(tip.bucket) : false;
  const prev = tip && active !== null && active > 0 ? points[active - 1] : null;
  const delta =
    tip && prev ? (metric === 'tokens' ? tip.tokens - prev.tokens : tip.requests - prev.requests) : null;

  return (
    <>
      {/* --avg 是**比例**，柱区高度由 CSS 的 --chart-h 决定 —— 改高度只改一处。 */}
      <div className="avgline" style={{ '--avg': avgFrac ?? 0 } as React.CSSProperties}>
        {avgFrac === null ? null : (
          /* 标签 + 引线排成一行：单独把标签挂在线的右端会压住「今天」那根柱，
             留在卡片右上角又会和线隔着一整张图。合起来才是"一条被标注的参考线"。 */
          <span className="avg-row">
            <span className="avg-tag">日均 {fmt(avg as number)}</span>
            <i className="avg-rule" />
          </span>
        )}
        <div className="bars30 js-grow" ref={barsRef} onKeyDown={onBarsKey} onMouseLeave={() => setActive(null)}>
          {/* 地面（零线）。放在 .bars30 内但绝对定位 —— 它是 flex 容器，
              普通子元素会变成 flex item，把 30 根柱挤窄。 */}
          <span className="grid" aria-hidden="true">
            <i className="base" />
            <i className="mid" />
            <i className="q1" />
          </span>
          {points.map((p, i) => {
            const v = metric === 'tokens' ? p.tokens : p.requests;
            const isLast = i === points.length - 1;
            /* peak 只给**并列最高**的那一根。原来是 v >= max*0.92 —— 30 天里有 5 根越线，
               六分之一的柱都在"强调"，等于没有强调。 */
            const cls = isLast ? 'today' : v >= max ? 'peak' : '';
            /* [2026-10-08] 失败可见性：`trend.errors` 一直在响应里，但图上从没画过 ——
               于是「哪天开始出问题」在趋势上看不见，只能一根根悬停去试。
               这里给有失败的时段在柱顶加一个红点。
               [注意] 红点是**布尔标记**（有/无失败），高度不编码失败数 ——
               那是刻意的：柱高已经被积分/请求占用了，再叠一个"错误有多少"的纵向编码
               就会变成双轴图，而双轴图最容易让人读出错误的相关性。
               精确数量与失败率在浮层里给（都是服务端的原始值，不做二次换算）。 */
            const err = p.errors > 0;
            const label = ariaLabels[i];
            /* [v0.5.12] 交互（hover/focus/aria）挂在**全高的 .bcol** 上，不再挂在柱身上：
               柱子只有底部一段高，悬在柱子上方的空白处什么都不触发 —— 用户实测
               「必须精准移到柱子上才显示 tooltip」。现在整列都是命中区，
               可见柱体 .b 只是列底部的填充。键盘漫游的 children 也变成了 .bcol。 */
            return (
              <div
                key={p.bucket}
                data-idx={i}
                className={`bcol${i === active ? ' on' : ''}`}
                role="img"
                aria-label={label}
                tabIndex={i === focusIdx ? 0 : -1}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((cur) => (cur === i ? null : cur))}
              >
                <div className={`b ${cls}`.trim() + (err ? ' err' : '')} style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }}>
                  {err ? <span className="err-dot" aria-hidden="true" /> : null}
                </div>
              </div>
            );
          })}
          {tip ? (
            /* [v0.4.28] tooltip 位置跟随柱子的实际位置（--tip-x 百分比）。
               [v7.0-f] 箭头定位修复：原先伪元素直接用 --tip-x（**图表坐标系**的柱心百分比），
               但伪元素相对**浮层**定位 —— 浮层被 translateX(-50%) 居中、首尾还被钳到贴边，
               两个坐标系差出「半个浮层宽」。桶越密柱越窄（24 小时桶柱宽约 14px），
               偏差越醒目，箭头指着别根柱（用户实测报障）。
               修法：渲染后用 ref 实测浮层左缘与图表宽度，把柱心位置换算成
               **相对浮层左缘的像素值**（--tip-arrow）传给伪元素。
               浮层位置/宽度只随 edge 类与内容变化，用 ref 实测一次即为准确值；
               窗口 resize 会重挂浮层（active 状态不变但样式重算），useLayoutEffect 兜底重测。 */
            (() => {
              const tipX = active !== null && points.length > 0
                ? ((active + 0.5) / points.length) * 100
                : 50;
              const edge = tipX < 12 ? ' tip-left' : tipX > 88 ? ' tip-right' : '';
              return (
                <div
                  ref={tipRef}
                  className={`bar-tip${edge}`}
                  style={{
                    '--tip-x': `${tipX}%`,
                    '--tip-arrow': tipArrow !== null ? `${tipArrow}px` : undefined,
                  } as React.CSSProperties}
                  aria-hidden="true"
                >
                  <div className="bt-head">
                    <b>{formatBucket(tip.bucket)}</b>
                    {/* [v1.6.31] 首/末桶常只覆盖窗口的一部分（窗口按 now 滚动，
                        不对齐整点）。数字是真实的，但不足一整格 —— 不标出来，
                        读者会以为「这一小时/这一天流量怎么这么低」。 */}
                    {tip.partial ? <span className="bt-tag bt-tag-partial">不足一格</span> : null}
                    {active === points.length - 1 ? <span className="bt-tag">最新</span> : null}
                  </div>
                  <div className={`bt-row${metric === 'tokens' ? ' hot' : ''}`}>
                    <span>消耗 tokens</span>
                    <i>{formatTokens(tip.tokens)}</i>
                  </div>
                  {/* [v0.5.11] 按模型 token 切片（服务端排好序取前 5）——
                      回答「这个时段的 token 花在哪些模型上」。占比由本桶总额现算
                      （两个服务端原始值相除，不引入新口径）。 */}
                  {(tip.models ?? []).length > 0 ? (
                    <div className="bt-models">
                      {(tip.models ?? []).map((m) => (
                        <div className="bt-model" key={m.model}>
                          <span className="bt-model-name">{m.model}</span>
                          <i>
                            {formatTokens(m.tokens)}
                            <em>{` · ${tip.tokens > 0 ? Math.round((m.tokens / tip.tokens) * 100) : 0}%`}</em>
                          </i>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className={`bt-row${metric === 'requests' ? ' hot' : ''}`}>
                    <span>请求次数</span>
                    <i>{formatInt(tip.requests)}</i>
                  </div>
              {/* [2026-10-08] 失败数：只在真的有失败时出现这一行 ——
                  恒显示「失败 0 次」会让这一格永远占位，而绝大多数时段确实是 0。
                  失败率由**服务端原始的两个数**现算（errors / requests），不引入新口径。 */}
              {tip.errors > 0 ? (
                <div className="bt-row bt-err">
                  <span>失败</span>
                  <i>
                    {formatInt(tip.errors)}
                    <em>
                      {' '}
                      ({formatInt(tip.requests) === '--' || tip.requests === 0
                        ? '—'
                        : `${((tip.errors / tip.requests) * 100).toFixed(1)}%`})
                    </em>
                  </i>
                </div>
              ) : null}
              {delta !== null ? (
                <div className={`bt-delta${delta > 0 ? ' up' : delta < 0 ? ' down' : ' flat'}`}>
                  较{hourly ? '上一小时' : '昨日'}
                  {delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : ' — '}
                  {delta > 0 || delta < 0 ? formatInt(Math.abs(delta)) : '持平'}
                </div>
              ) : null}
                </div>
              );
            })()
          ) : null}
        </div>
      </div>
      <div className="axis">
        {points.map((p, i) => (
          <span key={p.bucket}>
            {i % axisStep === 0 || i === points.length - 1 ? formatBucket(p.bucket) : ''}
          </span>
        ))}
      </div>
    </>
  );
}
// @zbiti-ai:f:191:fd17a2fb
