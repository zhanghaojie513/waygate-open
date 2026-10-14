/**
 * upstreamFetch：长保活连接池的真实套接字行为（不 mock fetch）。
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { upstreamFetch } from './upstream-fetch';

let server: Server | null = null;
const sockets = new Set<Socket>();
afterEach(async () => {
  // 保活连接会让 server.close() 一直等下去：先销毁残留套接字
  for (const sock of sockets) sock.destroy();
  sockets.clear();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

/** 裸 TCP 写 HTTP 响应：**不带** Keep-Alive 头（模拟 nginx 默认行为），统计建连次数。 */
function rawServer(onRequest: (sock: Socket) => void): Promise<{ url: string; conns: () => number }> {
  let conns = 0;
  server = createServer((sock) => {
    conns += 1;
    sockets.add(sock);
    sock.on('data', () => onRequest(sock));
  });
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/v1/chat/completions`, conns: () => conns });
    }),
  );
}

const post = (url: string, signal?: AbortSignal) =>
  upstreamFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal });

describe('upstreamFetch', () => {
  it('上游未声明 Keep-Alive 时，空闲 4.5s 后仍复用同一条连接（内置 fetch 4s 即断开）', async () => {
    const s = await rawServer((sock) => sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
    expect(await (await post(s.url)).text()).toBe('ok');
    await new Promise((r) => setTimeout(r, 4_500));
    expect(await (await post(s.url)).text()).toBe('ok');
    expect(s.conns()).toBe(1);
  }, 20_000);

  it('流式响应体逐块可读（SSE 透传依赖的 Web ReadableStream）', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
      const frames = ['data: {"a":1}\n\n', 'data: [DONE]\n\n'];
      for (const f of frames) sock.write(`${Buffer.byteLength(f).toString(16)}\r\n${f}\r\n`);
      sock.write('0\r\n\r\n');
    });
    const res = await post(s.url);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });

  it('错误形状与内置 fetch 一致：中止 → AbortError；连不上 → TypeError(fetch failed)', async () => {
    const s = await rawServer(() => undefined); // 永不响应
    const ctrl = new AbortController();
    const pending = post(s.url, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // 端口 1：本机必然拒绝连接
    await expect(post('http://127.0.0.1:1/')).rejects.toMatchObject({ name: 'TypeError', message: 'fetch failed' });
  });
});
