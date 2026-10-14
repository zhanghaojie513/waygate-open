/**
 * 本机凭证自动导入（v1.6.5）。
 *
 * ## 解决什么
 * MiniMax / Qoder 的凭证在**客户端登录态**里，用户拿不到、也不该手敲：
 *   · Qoder   `%APPDATA%/com.qodercn.app.stable/auth.v1.dat`（Chromium v10，本机 DPAPI 解）
 *   · MiniMax `~/.minimax/auth/prod/cn/mcode-public/auth.json`（明文 records）
 * 此前控制台只能给「导入指引 + 可复制命令」，用户还得自己去终端跑。本服务把它们
 * 变成**一个按钮**：服务端直接调用 `tools/` 下已有的导入脚本，读客户端登录态并落盘。
 *
 * ## 部署形态决定能否真·一键（重要）
 *   · **同机部署**（relay 与客户端同一台机器）→ 脚本能读到登录态，**真·一键**。
 *   · **分离部署**（relay 在服务器、客户端在本机 —— 生产就是这种）→ 服务端**读不到**
 *     用户的客户端文件。此时本服务**如实返回 `unavailable`**，由前端降级提示：
 *     在本机跑 `tools/import-credential-push.mjs`（一条命令读客户端并推送到 relay）。
 * 判定不做猜测：直接看客户端登录态文件在不在（`existsSync`），在就试、不在就如实说不可用。
 *
 * ## 安全边界
 *   · 只调用**仓库内固定脚本**，参数是受控的 providerId（白名单校验过），不做 shell 拼接。
 *   · 脚本输出只回传**脱敏摘要**（脚本本身即只打印掩码），不把令牌回给浏览器。
 */

import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 导入结果：ok=已导入；unavailable=本机读不到客户端登录态（分离部署）；error=试了但失败。 */
export interface LocalImportResult {
  ok: boolean;
  outcome: 'imported' | 'unavailable' | 'error';
  message: string;
  /** 供前端展示的**脱敏**脚本输出（令牌在脚本层已打码）。 */
  detail?: string;
}

@Injectable()
export class CredentialImportService {
  private readonly logger = new Logger(CredentialImportService.name);

  /** 仓库根（dist 在 server/dist/，向上两级即 server/）。 */
  private repoRoot(): string {
    return resolve(__dirname, '..', '..');
  }

  private toolsPath(script: string): string {
    return join(this.repoRoot(), 'tools', script);
  }

  /** Qoder 客户端登录态是否在本机（Chromium 存储目录 + auth.v1.dat）。 */
  private qoderClientPresent(): boolean {
    const appDir = process.env.QODER_APP_DIR
      ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable');
    return existsSync(join(appDir, 'auth.v1.dat'));
  }

  /** MiniMax 客户端登录态是否在本机。 */
  private minimaxClientPresent(): boolean {
    const p = process.env.MINIMAX_AUTH_FILE
      ?? join(homedir(), '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');
    return existsSync(p);
  }

  /**
   * 在服务端所在机器上跑导入脚本。
   * `providerId` 由调用方从 DB 取（已是受控值），这里再约束字符集，杜绝参数注入。
   */
  async importFromLocal(providerId: string, protocol: 'openai' | 'anthropic' | 'qoder'): Promise<LocalImportResult> {
    if (!/^p_[a-z0-9]+$/i.test(providerId)) {
      return { ok: false, outcome: 'error', message: '提供商 id 形状非法。' };
    }

    if (protocol === 'openai') {
      return { ok: false, outcome: 'unavailable', message: 'WorkBuddy 使用静态 API 密钥，无需本机导入（直接在「配置」里更换）。' };
    }
    if (protocol === 'anthropic') {
      if (!this.minimaxClientPresent()) {
        return {
          ok: false,
          outcome: 'unavailable',
          message: '本服务所在机器上找不到 MiniMax Code 客户端登录态（分离部署的正常情形）。'
            + '请在**装了客户端的那台机器**上跑：node tools/import-credential-push.mjs <relay地址> minimax',
        };
      }
      return this.run(this.toolsPath('minimax-import-credential.mjs'), [providerId], providerId);
    }
    /* qoder */
    if (!this.qoderClientPresent()) {
      return {
        ok: false,
        outcome: 'unavailable',
        message: '本服务所在机器上找不到 Qoder CN 客户端登录态（分离部署的正常情形）。'
          + '请在**装了客户端的那台机器**上跑：node tools/import-credential-push.mjs <relay地址> qoder',
      };
    }
    return this.run(this.toolsPath('qoder-import-credential.mjs'), [providerId], providerId);
  }

  /**
   * 跑脚本并落盘。两个脚本都把凭证写进 `RELAY_DATA_DIR/providers/<id>.key`，
   * 故这里必须把数据目录显式传给子进程（否则它按 cwd 猜，写错地方）。
   */
  private async run(script: string, args: string[], providerId: string): Promise<LocalImportResult> {
    if (!existsSync(script)) {
      return { ok: false, outcome: 'error', message: `导入脚本不存在：${script}（部署未带 tools/ 目录？）` };
    }
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
        cwd: this.repoRoot(),
        env: { ...process.env, RELAY_DATA_DIR: process.env.RELAY_DATA_DIR ?? join(this.repoRoot(), '..', 'data') },
        timeout: 30_000,
        encoding: 'utf8',
      });
      this.logger.log(`本机凭证导入成功：${providerId}`);
      return { ok: true, outcome: 'imported', message: '已从本机客户端登录态导入凭证。', detail: tail(stdout) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = tail(`${e.stdout ?? ''}${e.stderr ?? ''}`) || e.message || '未知错误';
      this.logger.warn(`本机凭证导入失败：${providerId} —— ${detail}`);
      return { ok: false, outcome: 'error', message: '导入失败。', detail };
    }
  }
}

/** 只取输出末尾若干行（脚本回显的脱敏摘要），避免把整段日志塞进响应。 */
function tail(s: string, lines = 6): string {
  return s.trim().split('\n').slice(-lines).join('\n');
}
