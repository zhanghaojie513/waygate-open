import type { CSSProperties } from 'react';

/**
 * 场景层 —— 折面棱镜（固定视口，随滚动运镜；由 scene.ts 驱动）。
 *
 * [禁止] 这里刻意是个「哑」组件：只渲染 DOM，不做任何逻辑。
 *    星尘与运镜都由命令式的 scene.ts 在 useEffect 里接管。
 *
 * 结构与原型 index.html 的 `.scene` 块一一对应，参数（--a/--r/--w/…）逐片照抄。
 * 颜色只引用令牌（--tint 用 var(--…)），无硬编码色值。
 *
 * [禁止] `.rig` 上不得出现 opacity / filter / mix-blend-mode / mask / clip-path / overflow
 *    —— 任一都会把 preserve-3d 压平（见 scene.css 说明）。调暗由 `.dimmer` 承担。
 */

/** 自定义属性不在 CSSProperties 里，用这个别名把「照抄的设计参数」写进去 */
type Vars = CSSProperties & Record<string, string | number>;

const c = (o: Record<string, string | number>): Vars => o as Vars;

interface Plate {
  tint: string;
  a: string;
  r: string;
  y: string;
  w: string;
  h: string;
  z: string;
  x: string;
  o: string;
  e: string;
  hot: string;
  dof: string;
  dur: string;
  delay: string;
  soft?: boolean;
}

/* 内壳 5 片（锐）+ 外壳 4 片（虚一档）—— 9 片。
 *
 * [v5] 两处根本变化：
 *   ① tint 改用光谱七色循环 —— 装置本身就是「白光被拆成七色」那件事。
 *      此前只用 4 个品牌色循环，九片玻璃全挤在紫青两族里，
 *      读不出"色散"，只读得出"一堆紫色玻璃"。
 *   ② 尺寸按局部盒子重算（半径缩到原 1/3、片缩到 2/5）——
 *      装置从全屏背景变成 Hero 右栏的一个盒子，绝对像素值必须跟着缩，
 *      否则玻璃会溢出盒子。
 *
 * --e / --hot 在生产版保留（原型没有）：它们让每片的棱边亮度与顶面高光
 * 能逐片微调，九片才不会读成"复制粘贴"。
 */
const PLATES: Plate[] = [
  { tint: 'var(--spectrum-1)', a: '0deg',   r: '128px', y: '-14px', w: '96px',  h: '196px', z: '-16deg', x: '15deg',  o: '.94', e: '.70', hot: '.26', dof: '0px', dur: '16s', delay: '0s' },
  { tint: 'var(--spectrum-2)', a: '72deg',  r: '138px', y: '6px',   w: '86px',  h: '178px', z: '11deg',  x: '-20deg', o: '.82', e: '.18', hot: '.05', dof: '0px', dur: '21s', delay: '3s' },
  { tint: 'var(--spectrum-3)', a: '144deg', r: '124px', y: '-20px', w: '104px', h: '210px', z: '-22deg', x: '18deg',  o: '.90', e: '.52', hot: '.18', dof: '0px', dur: '18s', delay: '6.5s' },
  { tint: 'var(--spectrum-4)', a: '216deg', r: '142px', y: '8px',   w: '90px',  h: '186px', z: '14deg',  x: '-14deg', o: '.78', e: '.14', hot: '.04', dof: '0px', dur: '23s', delay: '10s' },
  { tint: 'var(--spectrum-5)', a: '288deg', r: '132px', y: '-12px', w: '100px', h: '200px', z: '-13deg', x: '22deg',  o: '.88', e: '.30', hot: '.12', dof: '0px', dur: '20s', delay: '13.5s' },
  { tint: 'var(--spectrum-6)', a: '36deg',  r: '218px', y: '14px',  w: '132px', h: '200px', z: '-20deg', x: '25deg',  o: '.58', e: '.20', hot: '.06', dof: '2.1px', dur: '28s', delay: '2s', soft: true },
  { tint: 'var(--spectrum-7)', a: '126deg', r: '228px', y: '-11px', w: '120px', h: '186px', z: '16deg',  x: '-26deg', o: '.50', e: '.10', hot: '.03', dof: '2.1px', dur: '32s', delay: '9s', soft: true },
  { tint: 'var(--spectrum-1)', a: '216deg', r: '222px', y: '18px',  w: '146px', h: '216px', z: '-26deg', x: '20deg',  o: '.56', e: '.30', hot: '.09', dof: '2.1px', dur: '26s', delay: '15s', soft: true },
  { tint: 'var(--spectrum-4)', a: '306deg', r: '224px', y: '-6px',  w: '126px', h: '192px', z: '13deg',  x: '-22deg', o: '.46', e: '.08', hot: '.03', dof: '2.1px', dur: '35s', delay: '19s', soft: true },
];

export function SceneLayer() {
  return (
    <div className="scene" aria-hidden="true">
      <div className="rig">
        <div className="tilt">
          <div className="stage">
            {PLATES.map((p, i) => (
              <i
                key={i}
                className={p.soft ? 'pl soft' : 'pl'}
                style={c({
                  '--tint': p.tint,
                  '--a': p.a,
                  '--r': p.r,
                  '--y': p.y,
                  '--w': p.w,
                  '--h': p.h,
                  '--z': p.z,
                  '--x': p.x,
                  '--o': p.o,
                  '--e': p.e,
                  '--hot': p.hot,
                  '--dof': p.dof,
                  '--sheen-dur': p.dur,
                  '--sheen-delay': p.delay,
                })}
              />
            ))}
          </div>
        </div>
        {/* 尘埃：只在空气里悬浮，位置由固定种子生成（scene.ts），刷新不变 */}
        <div className="dust d3" />
        <div className="dust d2" />
        <div className="dust d1" />
      </div>

      {/* 以下都在相机机架之外：它们做 screen 叠加，进 preserve-3d 会把装配体压平 */}
      <div className="core" />
      <div className="nucleus" />
      <div className="beam b1" />
      <div className="beam b2" />
      <div className="fog" />
      {/* 调暗层：代替「给 .rig 降透明度」（后者会把 3D 链压平） */}
      <div className="dimmer" />
      <div className="vignette" />
      <div className="noise" />
    </div>
  );
}
// @zbiti-ai:f:100:11941c92
