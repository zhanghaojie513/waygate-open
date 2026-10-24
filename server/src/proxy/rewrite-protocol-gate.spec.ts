/**
 * v1.7.4：prompt 改写**只对 openai（WorkBuddy）生效**。
 *
 * 为什么需要这条：`rewriteRequestBody` 名字像"只改写提示"，实际做了 5 件事，
 * 其中只有「system 模板改写」是 WorkBuddy 的指纹对抗手段。此前它在路由分支之前
 * 无条件执行，于是 Qoder / MiniMax 的用户 system 提示也被篡改 ——
 * 生产实证：Qoder 47 次成功请求里 46 次带 `template_rewritten_5`。
 *
 * 这条 spec 钉的是**边界**：
 *   · 非 openai：不出现 template_rewritten_* / sysprompt_neutralized_*
 *   · 非 openai：**仍然**剥 stream_options、规范化 role、补最小 system
 *     （这些是协议补全，不是指纹对抗 —— 漏掉会真出问题）
 *   · openai：改写照旧生效（不能被这次修改误伤）
 */
import { describe, expect, it } from 'vitest';
import { rewriteRequestBody } from './rewrite';
import type { ChatRequestBody } from './types';

/** 带一条 system、带 stream_options 的典型请求。 */
function body(): ChatRequestBody {
  return {
    model: 'm',
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { role: 'user', content: 'hi' },
    ],
  } as ChatRequestBody;
}

describe('promptRewrite · 协议门（v1.7.4）', () => {
  it("★ openai：改写生效（template 档命中就记 note）", () => {
    const r = rewriteRequestBody(body(), { promptRewrite: 'template' });
    expect(r.notes.some((n) => n.startsWith('template_rewritten_'))).toBe(true);
  });

  it("★ 非 openai（传 'off'）：**不改写**，也不记改写 note", () => {
    const r = rewriteRequestBody(body(), { promptRewrite: 'off' });
    expect(r.notes.some((n) => n.startsWith('template_rewritten_'))).toBe(false);
    expect(r.notes.some((n) => n.startsWith('sysprompt_neutralized_'))).toBe(false);
  });

  it('★ off 档仍然剥 stream_options（协议补全，不能不剥）', () => {
    const r = rewriteRequestBody(body(), { promptRewrite: 'off' });
    expect(r.notes).toContain('stream_options_stripped');
    expect((r.body as Record<string, unknown>).stream_options).toBeUndefined();
  });

  it('★ off 档仍然补最小 system（无 system 时）', () => {
    const b = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] } as ChatRequestBody;
    const r = rewriteRequestBody(b, { promptRewrite: 'off' });
    expect(r.notes).toContain('system_injected');
    expect(r.body.messages[0]?.role).toBe('system');
  });

  it('★ off 档仍然规范化 developer → system', () => {
    const b = {
      model: 'm', stream: true,
      messages: [{ role: 'developer', content: 'x' }, { role: 'user', content: 'hi' }],
    } as unknown as ChatRequestBody;
    const r = rewriteRequestBody(b, { promptRewrite: 'off' });
    expect(r.notes).toContain('developer_role_normalized');
  });

  it('★ off 档下 system 提示原文不被改动（用户语义保留）', () => {
    const b = body();
    const original = (b.messages[0] as { content: string }).content;
    const r = rewriteRequestBody(b, { promptRewrite: 'off' });
    expect((r.body.messages[0] as { content: string }).content).toBe(original);
  });
});
