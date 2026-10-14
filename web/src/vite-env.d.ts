/// <reference types="vite/client" />

/* vite.config.ts 的 define 注入的构建版本号（值来自 web/package.json 的 version）。
   声明在这里，TS 才知道 `__APP_VERSION__` 存在。 */
declare const __APP_VERSION__: string;
