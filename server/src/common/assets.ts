import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 定位随源码一起发布的静态资源（schema.sql / model-catalog.json）。
 *
 * 不使用 `__dirname`：源码在 vitest 下以 ESM 加载、构建产物以 CJS 运行，
 * `__dirname` 在两者中不可同时成立。改为按进程工作目录探测 src/ 与 dist/。
 * 代价：进程必须在 server/ 目录下启动（npm start 与 systemd WorkingDirectory 均满足）。
 */
export function resolveAsset(relativeFromSrc: string): string {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'dist', relativeFromSrc),
    join(cwd, 'src', relativeFromSrc),
    join(cwd, relativeFromSrc),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `资源文件缺失：${relativeFromSrc}。已按顺序查找：${candidates.join(' | ')}。请在 server/ 目录下启动进程。`,
  );
}

export function readAsset(relativeFromSrc: string): string {
  return readFileSync(resolveAsset(relativeFromSrc), 'utf8');
}
