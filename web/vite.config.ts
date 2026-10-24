import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
/* 版本号从 package.json 现读，**不手写**：手写的版本号必然在某次发版时漏改，
   而它恰恰是"这次是不是新版"的唯一快速判据。用具名 JSON 导入而不是 fs ——
   web 的 tsconfig 只引 `vite/client` 类型（无 @types/node），`node:fs` 过不了 typecheck；
   `resolveJsonModule` 已开启，JSON 导入是 Vite 原生支持的路径，零额外依赖。
   与 server/src/version.ts、web/src/landing/data.ts 的版本号同源（发版时一起 bump）。 */
import pkg from './package.json' with { type: 'json' };

// 后端 NestJS 服务（另一位工程师并行开发）。开发期由 Vite 代理，生产只托管 dist/ 静态文件，
// 由 Nginx 把 /api/* 反代到 127.0.0.1:8787 —— 本文件不含任何「在服务器上构建」的步骤。
const BACKEND = 'http://127.0.0.1:8787';

// ⚠️ changeOrigin 必须为 false。
//
// 实测（server/scripts 里的一次性探针）：changeOrigin:true 会把 Host 头改写成
// 代理目标 `127.0.0.1:8787`，而浏览器发出的 Origin 仍是 `http://localhost:5173`。
// 后端对写方法做 CSRF 同源校验（Origin 必须等于 Host），两者不一致 → **登录必然 403**。
//
// 设成 false 后 Host 保留浏览器原值，与 Origin 天然同源，开发期链路才通。
// 生产 Nginx 同样用 `proxy_set_header Host $host;` 保留原值（deploy-security.md），
// 因此开发与生产的 Host 语义一致，不会出现"本地好好的、上线就 403"。
const proxyOptions = { target: BACKEND, changeOrigin: false } as const;

export default defineConfig({
  plugins: [react()],
  base: './',
  /* 注入构建版本：控制台侧栏品牌区显示它（declare 见 src/vite-env.d.ts）。 */
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': proxyOptions,
      '/v1': proxyOptions,
      '/healthz': proxyOptions,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    /* [未发版] vendor 分包：node_modules（react/react-dom/lucide）整体进一个
       chunk。应用代码天天改、框架代码偶尔动 —— 分开后每次发版，回访用户只需
       重新下载业务 chunk，vendor 命中本地缓存（两者都带内容哈希 + 30d
       immutable）。函数形式只按"是否来自 node_modules"一刀切，不逐包列名：
       逐包列名会在每次加依赖时悄悄过期。 */
    /* modulePreload：默认会把**所有**静态 import 的 chunk 都写进 preload 列表。
       vchart 虽然用动态 import 引入，但 manualChunks 单独拆块后仍被 vite
       当成「首屏可能用到」而 preload —— 实测 dist/index.html 里出现了
       vchart-WXO9HGfo.js，意味着首屏就预取 2MB，动态导入等于白做。
       这里显式过滤掉它：只有渲染到图表时才由 import() 拉取。 */
    modulePreload: {
      resolveDependencies: (_filename: string, deps: string[]) =>
        deps.filter((d: string) => !d.includes('vchart')),
    },
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          /* VChart（VisActor）单独成块 —— 它实测约 580 KB gzip（12 个 @visactor 子包），
             比整个 vendor 还大。TokenTrend 用动态 import 引入，所以只要不把它
             并进 vendor，首屏就不会加载它：概览页渲染到图表那一行时才拉。
             全塞进 vendor 会把 232 KB 的首屏依赖撑到 2.5 倍。 */
          /* VChart 实测约 580 KB gzip。它用 import() 动态引入，**必须落到自动生成的
             动态 chunk** —— 显式命名成 'vchart' 反而让它被入口静态引用，
             实测 start=98ms 就发请求，lazy 完全失效。所以交回 vite 默认分割。 */
          if (id.includes('@visactor')) return undefined;
          /* [v8] motion（reactbits 动效）与 Arco 同理交回默认分割：
             motion 只被官网/登录（懒加载页）引用 → 随那个 chunk 走，
             不进 vendor 拖累控制台首屏；Arco 被 AppShell（首屏）与
             RequestsPage（懒加载）引用 → 共享部分自动提成公共 chunk。
             全归 vendor 实测 232KB → 625KB raw。 */
          if (id.includes('motion') || id.includes('@arco-design')) return undefined;
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
    /* 不清空 outDir，两个原因：
       ① 自托管字体是 109 个文件（可变字体去重前 430 个），每次构建都全量删除会拖慢构建（实测
          prepare-out-dir 占了 5.9s 里的 4.0s），且在这类环境里会撞上
          批量删除保护而直接构建失败；
       ② 产物名带内容哈希、index.html 每次重写，所以旧文件残留不会被引用。
       代价：长期构建会在 dist/ 留下历史哈希文件。需要干净产物时手动删一次 dist。 */
    emptyOutDir: false,
  },
});
// @zbiti-ai:f:43:8d3fcac1
