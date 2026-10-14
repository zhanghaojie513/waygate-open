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

/* 内壳 5 片（锐）+ 外壳 4 片（虚一档）—— 9 片，参数照抄原型 */
const PLATES: Plate[] = [
  { tint: 'var(--iris)', a: '0deg', r: '430px', y: '-40px', w: '300px', h: '520px', z: '-18deg', x: '16deg', o: '.95', e: '.70', hot: '.26', dof: '0px', dur: '15s', delay: '0s' },
  { tint: 'var(--accent-cyan)', a: '72deg', r: '448px', y: '10px', w: '255px', h: '470px', z: '12deg', x: '-22deg', o: '.82', e: '.18', hot: '.05', dof: '0px', dur: '19s', delay: '3s' },
  { tint: 'var(--brand-500)', a: '144deg', r: '424px', y: '-60px', w: '325px', h: '560px', z: '-24deg', x: '19deg', o: '.90', e: '.52', hot: '.18', dof: '0px', dur: '17s', delay: '6.5s' },
  { tint: 'var(--brand-400)', a: '216deg', r: '456px', y: '20px', w: '270px', h: '490px', z: '16deg', x: '-14deg', o: '.76', e: '.14', hot: '.04', dof: '0px', dur: '21s', delay: '10s' },
  { tint: 'var(--accent-blue)', a: '288deg', r: '436px', y: '-30px', w: '310px', h: '535px', z: '-14deg', x: '24deg', o: '.88', e: '.30', hot: '.12', dof: '0px', dur: '18s', delay: '13.5s' },
  { tint: 'var(--brand-500)', a: '36deg', r: '860px', y: '40px', w: '400px', h: '560px', z: '-22deg', x: '26deg', o: '.62', e: '.20', hot: '.06', dof: '2.6px', dur: '26s', delay: '2s', soft: true },
  { tint: 'var(--accent-cyan)', a: '126deg', r: '900px', y: '-20px', w: '360px', h: '520px', z: '18deg', x: '-28deg', o: '.52', e: '.10', hot: '.03', dof: '2.6px', dur: '30s', delay: '9s', soft: true },
  { tint: 'var(--iris)', a: '216deg', r: '840px', y: '60px', w: '440px', h: '620px', z: '-28deg', x: '20deg', o: '.58', e: '.30', hot: '.09', dof: '2.6px', dur: '24s', delay: '15s', soft: true },
  { tint: 'var(--brand-400)', a: '306deg', r: '890px', y: '-10px', w: '380px', h: '540px', z: '14deg', x: '-24deg', o: '.48', e: '.08', hot: '.03', dof: '2.6px', dur: '33s', delay: '19s', soft: true },
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
