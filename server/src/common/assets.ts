import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 定位随代码一起发布的静态资源（schema.sql / model-catalog.json）。
 *
 * ## 为什么不能只看 process.cwd()
 * 早期实现按 `process.cwd()` 探测 `dist/` 与 `src/` —— 那要求**进程必须在 server/
 * 目录下启动**（`npm start` 与 systemd 的 WorkingDirectory 都满足）。
 * 但作为 **npm 全局包**安装后（`npm i -g waygate-open`），cwd 是用户随便哪个目录，
 * 那几个候选全部落空 → 启动即 `Error: 资源文件缺失：store/schema.sql`。
 *
 * ## 现在的顺序
 *   ① **本文件所在目录的上一层/上两层** —— 安装态与源码态都成立，是唯一不依赖
 *      "用户在哪敲命令"的锚点（`dist/common/assets.js` → `dist/`；
 *      `src/common/assets.ts` → `src/`）；
 *   ② cwd 下的 dist/ 与 src/ —— 保留老路径，兼容既有 systemd / 本地脚本；
 *   ③ cwd 本身。
 *
 * `__dirname` 在本仓两种运行形态下都可用的（**实测过**，不是推断）：
 * tsconfig 是 `module: commonjs`，构建产物是 CJS；vitest 也按 CJS 语义加载
 * （探针 spec 打印出 `__dirname = .../server/src/common`）。早期注释里
 * "vitest 下不可用"的前提是错的。
 */
export function resolveAsset(relativeFromSrc: string): string {
  // assets.js 在 dist/common/ 或 src/common/ 下 → 上两层即 dist/ 或 src/
  const moduleRoot = join(__dirname, '..', '..');
  const cwd = process.cwd();
  const candidates = [
    join(moduleRoot, relativeFromSrc), // 安装态 / 构建产物：dist/store/schema.sql
    join(cwd, 'dist', relativeFromSrc), // 老路径：在 server/ 下启动
    join(cwd, 'src', relativeFromSrc), // 源码态（vitest 从 server/ 跑）
    join(cwd, relativeFromSrc),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `资源文件缺失：${relativeFromSrc}。已按顺序查找：${candidates.join(' | ')}。` +
      `（正常安装不应出现：请重装本包，或用 npm run build 重新生成 dist/。）`,
  );
}

export function readAsset(relativeFromSrc: string): string {
  return readFileSync(resolveAsset(relativeFromSrc), 'utf8');
}

/**
 * 定位前端产物目录（含 index.html）。
 *
 * 两种布局共用**同一条**相对路径（这是把前端放 `web/dist` 而不另拷一份的原因）：
 *   · **npm 包**：`<pkg>/server/dist/common/assets.js` → `<pkg>/web/dist/`
 *   · **源码仓**：`<pkg>/server/src/common/assets.ts` → `<pkg>/web/dist/`
 * 两者都是「上溯两级再进 web/dist」：
 *   `server/dist/../../web/dist` === `server/src/../../web/dist` === `<pkg>/web/dist`。
 *
 * 找不到返回 `null` —— 此时进程只提供 API（/v1、/api、/healthz），控制台不可用。
 * 这是**刻意的降级**：不因缺少前端而拒绝启动（与"密钥没配也照起"同一条纪律）。
 */
export function resolveWebDist(): string | null {
  const moduleRoot = join(__dirname, '..', '..'); // = <pkg>/server（dist/common 与 src/common 都是）
  const cwd = process.cwd();
  const candidates = [
    join(moduleRoot, '..', 'web', 'dist'), // 包内与源码仓：<pkg>/web/dist
    join(moduleRoot, '..', 'web-dist'), // 兼容：单独放一份 web-dist/
    join(cwd, 'web', 'dist'), // 源码仓、从仓库根启动
    join(cwd, 'dist'), // 前端产物被直接摊在 cwd 下
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
