/**
 * 服务版本号的**代码侧单源**（v0.2.0 引入）。
 *
 * 为什么需要：healthz 此前用 `process.env.npm_package_version ?? '0.1.0'` ——
 * npm 脚本环境（本地 smoke:boot）里有这个变量，但 **systemd 生产环境没有**，
 * 版本号就一直停在回落值（实测 0.2.0 上线后 healthz 仍报 0.1.0）。
 *
 * 防漂移：`scripts/copy-assets.mjs` 在每次构建时校验本常量与 package.json 的
 * `version` 一致，不一致直接 fail build —— 两处版本永远不会悄悄分叉。
 * 升版本 = 同时改 package.json 与这里（构建会逼你对齐）。
 */
export const VERSION = '1.7.0';
