/**
 * 提供商删除前的**留档**（v1.7.1）。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────────
 * `remove()` 会把这些东西一起抹掉，且**没有任何地方留副本**：
 *   · 行本身（name / base_url / protocol / chat_path / 全部签到状态）
 *   · 三个凭证文件：`.key`（anthropic 的 mmort_ refresh token / custom 的 API key /
 *     qoder 的身份 JSON）、`.oauth`（WorkBuddy 的 OAuth 授权）、`.access`（MiniMax 换来的 access）
 *   · 该家的模型目录分区 + 启停偏好
 *
 * 其中 WorkBuddy 的 `.oauth` 与 Qoder 的身份 JSON **无法从本机重建** —— 用户只能重新
 * 走一遍官方授权；MiniMax 的 refresh token 还是**一次性轮换**的，丢掉就得重新登录，
 * 而那个账号是单会话的（[[waygate-minimax-credential]]）。一次误点删除的代价是
 * 「重新登录一次客户端」，这对一个自用工具来说太重了。
 *
 * ── 形态 ────────────────────────────────────────────────────────────────
 * 一个 JSON 文件落到 `<数据目录>/backup/`：
 *   provider-<id>-<yyyyMMdd-HHmmss>.json
 * 内含行快照 + 目录分区 + 偏好 + **凭证文件原文**。所以它是**敏感文件**：
 * 写入用 0600（与凭证文件同级），目录 0700，且**不出现在任何 API 响应里**——
 * 只回「留档文件名」与「可恢复」这个事实。
 *
 * ── 为什么不复用 VACUUM INTO 那套 ────────────────────────────────────────
 * 那是**整库**备份（迁移前用），成本 O(库)。删一个提供商只需要它自己那几行 +
 * 几个小文件，整库快照会让「删个提供商」变成几十 MB 的磁盘动作。
 *
 * ── 保留期 ──────────────────────────────────────────────────────────────
 * 只保留最近 N 份（默认 20），按 mtime 从旧到新删 —— 不设自动过期日：
 * 一个从没清理过的备份目录，比一个悄悄清理掉用户唯一凭证副本的定时器安全。
 */

import { Injectable, Logger } from '@nestjs/common';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../store/db';
import type { ProviderRow } from '../store/repositories/providers.repo';

/** 保留份数：超过就从最旧的删。20 份 × 几 KB ≈ 可以忽略的占用。 */
const KEEP_LAST = 20;

/** 凭证文件的三种后缀（与 remove() 清理范围一致）。 */
const CREDENTIAL_SUFFIXES = ['.key', '.access', '.oauth'] as const;

export interface ProviderBackupFile {
  /** 版本号：将来格式变了，恢复端能认出来。 */
  format: 1;
  takenAt: string;
  provider: ProviderRow;
  /** 该家的模型目录分区（删除前快照）。 */
  models: unknown[];
  /** 启停偏好（provider_model_prefs）。 */
  prefs: unknown[];
  /** 凭证文件原文，键是后缀（'.key' / '.oauth' / '.access'）。**敏感**。 */
  credentials: Record<string, string>;
}

/** `yyyyMMdd-HHmmss`（本地时区，给文件名与列表排序用；排序只看字典序即可）。 */
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

@Injectable()
export class ProviderBackupService {
  private readonly logger = new Logger(ProviderBackupService.name);
  private dir = join(resolveDataDir(), 'backup');

  /** 仅供可测性（vitest 里不能 chdir）。 */
  setDirForTest(dir: string): void {
    this.dir = dir;
  }

  /**
   * 删除前留档。返回文件名（不含目录）供响应回显。
   * 写失败**不阻断删除** —— 让「留档失败」把「删除」也卡死，用户会陷入无法清理的死局。
   * 失败如实记 warn（该行此时已被删，属于事后追认）。
   */
  snapshot(input: {
    provider: ProviderRow;
    models: unknown[];
    prefs: unknown[];
    providersDir: string;
  }): string {
    const fileName = `provider-${input.provider.id}-${fileStamp(new Date())}.json`;

    const credentials: Record<string, string> = {};
    for (const suffix of CREDENTIAL_SUFFIXES) {
      const path = join(input.providersDir, `${input.provider.id}${suffix}`);
      try {
        if (existsSync(path)) credentials[suffix] = readFileSync(path, 'utf8');
      } catch {
        /* 读不到就不放进快照（不写空串冒充"文件存在但为空"）。 */
      }
    }

    const payload: ProviderBackupFile = {
      format: 1,
      takenAt: new Date().toISOString(),
      provider: input.provider,
      models: input.models,
      prefs: input.prefs,
      credentials,
    };

    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const target = join(this.dir, fileName);
      /* 0600：文件里有 refresh token / OAuth 授权 / API key，与凭证文件同级。 */
      const fd = openSync(target, 'w', 0o600);
      try {
        writeSync(fd, JSON.stringify(payload, null, 2));
      } finally {
        closeSync(fd);
      }
      this.prune();
      this.logger.log(`已留档提供商 ${input.provider.name}（${input.provider.id}）→ ${fileName}`);
      return fileName;
    } catch (err) {
      this.logger.warn(`留档失败（删除继续）：${(err as Error).message}`);
      return '';
    }
  }

  /** 列出留档（**不含凭证内容**，只给元数据 —— 这个列表可以安全地出现在 UI 里）。 */
  list(): Array<{ file: string; providerId: string; providerName: string; takenAt: string; hasCredential: boolean }> {
    if (!existsSync(this.dir)) return [];
    const out: Array<{ file: string; providerId: string; providerName: string; takenAt: string; hasCredential: boolean }> = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.startsWith('provider-') || !file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as Partial<ProviderBackupFile>;
        out.push({
          file,
          providerId: String(parsed.provider?.id ?? ''),
          providerName: String(parsed.provider?.name ?? ''),
          takenAt: String(parsed.takenAt ?? ''),
          hasCredential: Object.keys(parsed.credentials ?? {}).length > 0,
        });
      } catch {
        /* 坏文件跳过（不因为一个手改坏的文件让整个列表失败）。 */
      }
    }
    /* 新 → 旧。 */
    return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  /** 只留最近 KEEP_LAST 份。失败不抛（清理是尽力而为）。 */
  private prune(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.startsWith('provider-') && f.endsWith('.json'))
        .map((f) => ({ f, mtime: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const extra of files.slice(KEEP_LAST)) {
        unlinkSync(join(this.dir, extra.f));
        this.logger.log(`留档超出 ${KEEP_LAST} 份，清理最旧的 ${extra.f}`);
      }
    } catch {
      /* 尽力而为。 */
    }
  }
}
