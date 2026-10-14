/**
 * 接入地址的**唯一事实来源**。
 *
 * 控制台与 API 同源（共用一个监听端口），所以客户端该填的 base_url
 * **就是**当前页面的 origin 拼上 `/v1`：
 *     浏览器停在  https://relay.example.com:8443/console
 *     → 客户端填  https://relay.example.com:8443/v1
 *
 * [注意] 绝不硬编码 IP / 端口：地址会随换机、换端口、走隧道而变，硬编码必然过期
 *    （本项目刚吃过「硬编码 UPSTREAM_BASE 导致设置不生效」的亏）。
 *    一律从 `location.origin` 现算；官网与控制台共用本函数，保证**一处计算**。
 *
 * `origin` 可注入，便于单测（默认取当前页面）。
 */
export function accessBaseUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/v1`;
}
// @zbiti-ai:f:17:000d9ea3
