/**
 * 小文本文件（提供商凭证）的进程内缓存读取。
 *
 * 为什么需要：代理热路径每个请求都要取一次出站凭证（openai 的 .key、MiniMax 的 .access、
 * Qoder 的身份 JSON）。原先每次 readFileSync —— 同步 IO 直接占住事件循环，云盘/IO 抖动时
 * 会放大成所有 SSE 流的卡顿。
 *
 * 失效策略：每次只做一次 statSync（一个系统调用、不读内容），按 (mtimeMs, size, ino) 判断
 * 文件是否变过；变了才重读。这样控制台改凭证、MiniMax 轮换 refresh token、
 * `tools/qoder-import-credential.mjs` 外部导入（原子 rename 会换 ino）都无需显式通知、无需重启。
 */
import { readFileSync, statSync } from 'node:fs';

interface Entry {
  mtimeMs: number;
  size: number;
  ino: number;
  text: string;
}

const cache = new Map<string, Entry>();

/** 读取文本文件（utf8），内容未变时返回缓存。文件不存在/不可读时抛出与 readFileSync 相同的错误。 */
export function readTextFileCached(path: string): string {
  const st = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
    return hit.text;
  }
  const text = readFileSync(path, 'utf8');
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, text });
  return text;
}

/** 仅供测试：清空缓存。 */
export function clearTextFileCache(): void {
  cache.clear();
}
