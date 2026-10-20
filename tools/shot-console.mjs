/**
 * 重新生成 docs/img 下的控制台截图（README 用）。
 *
 * 数据来源：`npm run dev:mock`（纯前端 Mock，口令 relay-dev）—— 不碰生产、不需要
 * 管理员口令，且 Mock 数据就是为了让界面「看起来完整」而准备的（有请求、有多提供商、
 * 有趋势桶）。截的是**当前源码**，所以版本号、导航、面板构成都跟仓库一致。
 *
 * 为什么不用生产实例截图：需要管理员口令（生产口令不可知/不该为截图去重置），
 * 且生产数据含真实对话内容（日志、UA、模型用量），进公开 README 不合适。
 *
 * 用法：
 *   cd web && npm run dev:mock          # 另开终端，记下端口（默认 5174）
 *   node tools/shot-console.mjs http://localhost:5174
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] ?? 'http://localhost:5174').replace(/\/$/, '');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs', 'img');

/* 每页：控制台 hash 路由 → 输出文件名。顺序即 README 里的展示顺序。
   第三项是「进页后额外要做的动作」——用量页要切到 30 天窗口：默认「今日」在
   凌晨只有 1–2 个桶（桶数 = 当前小时 + 1，这是正确行为），截图会变成两根巨柱，
   既不好看也说明不了趋势。30 天是这一页设计上的默认展示口径。 */
const PAGES = [
  ['overview', 'console-overview.png'],
  ['usage', 'console-usage.png', [
    { type: 'click', sel: 'button[aria-haspopup=listbox]' },
    { type: 'wait', ms: 700 },
    { type: 'clickText', sel: '[role=option]', text: '最近 30 天' },
    { type: 'wait', ms: 2500 },
  ]],
  ['requests', 'console-requests.png'],
  ['clients', 'console-clients.png'],
  ['keys', 'console-keys.png'],
  ['settings', 'console-settings.png'],
];

const LOGIN = [
  { type: 'fill', sel: 'input[type=password]', value: 'relay-dev' },
  { type: 'wait', ms: 400 },
  { type: 'click', sel: 'button[type=submit]' },
  { type: 'wait', ms: 3500 },
];

function run(url, out, steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'tools', 'ui-shot.mjs'), url, out, JSON.stringify(steps)],
      {
        stdio: 'inherit',
        env: { ...process.env, UI_SHOT_W: '1440', UI_SHOT_H: '900', UI_SHOT_SCALE: '1', UI_SHOT_FULL: '1' },
      },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ui-shot 退出码 ${code}（${out}）`))));
  });
}

for (const [route, file, extra = []] of PAGES) {
  const out = join(OUT, file);
  process.stdout.write(`\n[${route}] → ${file}\n`);
  await run(`${BASE}/console#/${route}`, out, [...LOGIN, { type: 'wait', ms: 1200 }, ...extra]);
  await delay(500);
}

console.log('\n全部完成。检查完请把 docs/img/*.png 一起提交。');
