/**
 * prependFirstChunk 单测（v0.6.3）—— Qoder「零内容断流重试」的关键拼图。
 *
 * 为什么值得单独测：doCallQoder 先把首块读出来判「零内容」，那一块**必须不丢**
 * —— 这是首帧内容（role/reasoning 的第一段）。回归点：拼接顺序、原流剩余部分接力、
 * 空块、取消传播。
 */
import { describe, expect, it } from 'vitest';
import { prependFirstChunk } from './proxy.service';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 造一个把给定分片依次吐出的流（已「读掉」第一块的情形由调用方模拟）。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

/** 读干一个流。 */
async function drain(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('prependFirstChunk · 首块回填', () => {
  it('★ 首块在前、剩余在后，顺序与总量都不变（内容不丢是硬要求）', async () => {
    const body = streamOf(['world', '!']);
    const out = await drain(prependFirstChunk(body, enc.encode('hello ')));
    expect(out).toBe('hello world!');
  });

  it('原流只剩一块：拼接完整', async () => {
    const body = streamOf(['B']);
    expect(await drain(prependFirstChunk(body, enc.encode('A')))).toBe('AB');
  });

  it('原流已空（首块是唯一内容）：仍吐出首块后正常结束', async () => {
    const body = streamOf([]);
    expect(await drain(prependFirstChunk(body, enc.encode('only')))).toBe('only');
  });

  it('二进制定界：多字节 UTF-8 被切断时按字节拼接（不按字符解码）', async () => {
    const full = enc.encode('中文');
    // 人为把第一个汉字的三字节切成 2+1：首块取前 2 字节，剩余流给后 1 + 第二个汉字
    const first = full.slice(0, 2);
    const rest = full.slice(2);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(rest);
        c.close();
      },
    });
    const merged = new Uint8Array(await new Response(prependFirstChunk(body, first)).arrayBuffer());
    expect([...merged]).toEqual([...full]);
    expect(dec.decode(merged)).toBe('中文');
  });

  it('原流出错 → 错误传播到新流', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('ok'));
        c.error(new Error('upstream boom'));
      },
    });
    const out = prependFirstChunk(body, enc.encode('head'));
    const reader = out.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('head');
    await expect(reader.read()).rejects.toThrow('upstream boom');
  });
});
