/**
 * 应急：直接在服务器上把管理口令设为一个**已知**的新值。
 *
 * 使用场景：管理员忘记口令，控制台进不去，只能上服务器操作。
 * 这正是产品文档里写的「没有找回通道，只能上服务器重新引导」那条路径 ——
 * 本脚本就是那条路径的可执行版本，同时也用来把验证流程拉回可控状态。
 *
 * 口令从**环境变量（码点 JSON）**传入，不落盘、不进日志。
 *
 * ⛔ 护栏：本脚本**不经 HTTP、直接 upsert 生产库**（唯一绕过 SessionGuard / Origin / 审计的
 *    改密路径），故**必须显式确认目标库**：`RELAY_CONFIRM_FORCE_SET` 须**恰好等于** `DB_PATH`，
 *    否则打印用法并 `exit 2`。写入前还会打印目标库路径 + `user_version` + 行数（留痕）。
 *
 * 用法：
 *   RELAY_CONFIRM_FORCE_SET='/var/lib/relay/relay.db' \
 *     RELAY_NEW_PASSWORD_CODEPOINTS='[50,67,...]' node /root/force-set-password.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire('/opt/relay/server/');

/** 目标数据库（本项目唯一的生产库路径，同时用作「显式确认值」）。 */
const DB_PATH = '/var/lib/relay/relay.db';
const CONFIRM = 'RELAY_CONFIRM_FORCE_SET';

function usage(msg) {
  console.error(
    [
      '',
      msg,
      '',
      '--- 用法（⛔ 破坏性：直接写库、绕过 HTTP 层）---',
      '必须显式确认目标库，否则拒绝执行：',
      '',
      `  RELAY_CONFIRM_FORCE_SET='${DB_PATH}' RELAY_NEW_PASSWORD_CODEPOINTS='[50,67,...]' node ${process.argv[1] ?? '<script>'}`,
      '',
      `  ${CONFIRM} 必须**恰好等于实际 DB 路径**（${DB_PATH}）——`,
      '  目的是挡住「顺手复制粘贴」和「改错了库」，而不是走过场。',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

// ★ 护栏①：显式确认目标库。本脚本不经 HTTP，直接 upsert 生产库，
//   是唯一绕过 SessionGuard / Origin / 审计的改密路径 —— 必须"先说你改哪个库"。
if (process.env[CONFIRM] !== DB_PATH) {
  usage(`⛔ 缺少或不匹配 ${CONFIRM}（须等于 ${DB_PATH}），已拒绝执行。`);
}

const raw = process.env.RELAY_NEW_PASSWORD_CODEPOINTS;
if (!raw) {
  usage('缺少 RELAY_NEW_PASSWORD_CODEPOINTS（JSON 码点数组）。');
}
const password = String.fromCharCode(...JSON.parse(raw));

// 复用服务自己的 scrypt 实现，保证存储串格式与运行时**完全一致**
const { hashPassword } = require('/opt/relay/server/dist/api/auth/password.js');

const stored = hashPassword(password);
if (!/^scrypt\$16384\$8\$1\$/.test(stored)) {
  console.error('哈希格式异常，中止');
  process.exit(3);
}

// 走到这里说明确认已通过；这时才加载 DB 驱动。
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
const now = Date.now();

// ★ 醒目标靶 + 写前留痕：让每次改密都能在终端 / journal 看见「到底动了哪个库、什么状态」。
const uv = db.pragma('user_version', { simple: true });
const before = db.prepare('SELECT COUNT(*) AS n FROM admin_credential').get();
process.stdout.write(
  `\n${'='.repeat(68)}\n` +
    `目标数据库 ${DB_PATH}　【生产级：直接写库，绕过 HTTP 层】\n` +
    `user_version=${uv}　admin_credential 行数（改前）=${before.n}\n` +
    `${'='.repeat(68)}\n`,
);

db.prepare(
  `INSERT INTO admin_credential (id, hash, source, updated_at, rotated_at)
   VALUES (1, ?, 'console', ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     hash = excluded.hash, source = excluded.source,
     updated_at = excluded.updated_at, rotated_at = excluded.rotated_at`,
).run(stored, now, now);
const row = db.prepare('SELECT source, updated_at, rotated_at FROM admin_credential WHERE id=1').get();
db.close();

console.log(`已写入。source=${row.source} updated_at=${row.updated_at} rotated_at=${row.rotated_at}`);
console.log(`新口令长度=${password.length}（明文未在此输出）`);
