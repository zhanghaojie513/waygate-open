/**
 * 抓取 MiniMax Code 客户端的真实出站请求头（一次性研究工具，v0.6.0）。
 *
 * 做法：本地起一个**转发代理**（不 MITM —— 客户端走 https，CONNECT 隧道无法读明文；
 *       所以改用「把客户端 base URL 指向本地 http 端点」的路子，见 README 说明）。
 *
 * 现实约束：客户端把上游地址写死在代码里，未必可改。因此本脚本提供两条路径：
 *   A. `--proxy`：以 HTTP 代理形式运行，记录 CONNECT 目标（看得见连了哪些域名，
 *      看不见 header —— 仅用于确认端点）；
 *   B. `--replay`：把本脚本当「假上游」——把 DNS/主机映射到本机后，客户端请求落到
 *      这里，我们完整记录 header 与 body（需要 hosts 或代理转发配合）。
 *
 * 用法：
 *   node tools/mavis-capture.mjs --listen 8899
 *   （再用系统 hosts / 环境变量把 agent.minimax.cn 指过来；只在本机研究用）
 */

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.argv[process.argv.indexOf('--listen') + 1] || 8899);
const OUT = 'mavis-capture.log';

writeFileSync(OUT, `# mavis capture @ ${new Date().toISOString()}\n`);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const rec = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyPreview: body.slice(0, 2000),
      bodyBytes: body.length,
    };
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`[capture] ${req.method} ${req.url} (${body.length}B) → ${OUT}`);
    /* 不转发：直接回一个明确的错误，客户端会失败但 header 已被我们拿到。 */
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'capture-only' }));
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mavis capture listening on http://127.0.0.1:${PORT}`);
  console.log(`把客户端的上游地址指到本机即可（hosts / 代理），请求头会写进 ${OUT}`);
});
