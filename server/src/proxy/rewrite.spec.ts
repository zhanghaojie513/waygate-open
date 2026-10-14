import { describe, expect, it } from 'vitest';
import { MIN_MAX_TOKENS, rewriteRequestBody } from './rewrite';
import type { ChatRequestBody } from './types';

describe('rewriteRequestBody —— ADR-004 第 3~6 步', () => {
  it('① 首条非 system 时插入一条 system，且插在**最前面**', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: '你好' }],
    });

    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages).toHaveLength(2);
    expect(notes).toContain('system_injected');
  });

  it('② 首条已是 system 时不重复插入，也不改动内容', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'deepseek-v3',
      messages: [
        { role: 'system', content: '我的自定义人设' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('我的自定义人设');
    expect(notes).not.toContain('system_injected');
  });

  it('③ 空 messages 数组也被补 system（上游 11128 不只是"首条不对"，是"根本没有"）', () => {
    const { body } = rewriteRequestBody({ model: 'deepseek-v3', messages: [] });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('system');
  });

  it('④ stream 恒为 true，无论客户端传 false 还是不传（上游 11101）', () => {
    expect(rewriteRequestBody({ model: 'a', messages: [], stream: false }).body.stream).toBe(true);
    expect(rewriteRequestBody({ model: 'a', messages: [], stream: true }).body.stream).toBe(true);
    expect(rewriteRequestBody({ model: 'a', messages: [] }).body.stream).toBe(true);
  });

  it('⑤ stream_options 被删除（上游不认这个字段），且记 note', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [],
      stream_options: { include_usage: true },
    } as ChatRequestBody);

    expect('stream_options' in body).toBe(false);
    expect(notes).toContain('stream_options_stripped');
  });

  it('⑥ max_tokens 过小被提升（上游 11133）；未提供时不擅自补', () => {
    const tooSmall = rewriteRequestBody({ model: 'a', messages: [], max_tokens: 8 });
    expect(tooSmall.body.max_tokens).toBe(MIN_MAX_TOKENS);
    expect(tooSmall.notes.some((n) => n.startsWith('max_tokens_raised'))).toBe(true);

    const absent = rewriteRequestBody({ model: 'a', messages: [] });
    expect('max_tokens' in absent.body).toBe(false);

    const fine = rewriteRequestBody({ model: 'a', messages: [], max_tokens: 4096 });
    expect(fine.body.max_tokens).toBe(4096);
  });

  it('⑦ ★ 不改动传入对象（纯函数），调用方持有的原始 body 不被污染', () => {
    const original: ChatRequestBody = {
      model: 'a',
      messages: [{ role: 'user', content: '原始' }],
      stream: false,
      stream_options: { include_usage: true },
    };
    const snapshot = JSON.stringify(original);

    rewriteRequestBody(original);

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(original.messages[0].role).toBe('user');
    expect(original.stream).toBe(false);
  });

  it('⑧ 其余字段原样保留（temperature / top_p / tools 等不能被吃掉）', () => {
    const { body } = rewriteRequestBody({
      model: 'a',
      messages: [],
      temperature: 0.3,
      top_p: 0.9,
      tools: [{ type: 'function' }],
      custom: 'keep-me',
    });

    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.tools).toEqual([{ type: 'function' }]);
    expect(body.custom).toBe('keep-me');
    expect(body.model).toBe('a');
  });
});

/**
 * [task#77] `developer` → `system` 角色规范化。
 *
 * 生产根因（实测）：上游**只拒精确小写 `developer`**，放在 messages 任意位置都回 400 + 11128；
 * 其余自定义 role（`Developer`/`foo`/`knowledge`）反被容忍。修复是在转发前**就地、保序、保内容**地
 * 把 developer 改成 system（`developer` 本就是 `system` 的继任者，语义无损）。
 */
describe('rewriteRequestBody —— developer 角色规范化（task#77）', () => {
  it('★ 首条 developer 就地转成 system：不再多插一条，也不丢消息', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'developer', content: '你是助手' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('你是助手');
    expect(body.messages[1].role).toBe('user');
    // 首条已被规范成 system → 不该再插 system
    expect(notes).not.toContain('system_injected');
    expect(notes).toContain('developer_role_normalized');
  });

  it('★ 大小写不敏感：Developer / DEVELOPER / DeVeLoPeR 一律规范化', () => {
    for (const role of ['Developer', 'DEVELOPER', 'DeVeLoPeR']) {
      const { body, notes } = rewriteRequestBody({
        model: 'a',
        messages: [{ role, content: 'x' }, { role: 'user', content: 'hi' }],
      });
      expect(body.messages[0].role).toBe('system');
      expect(notes).toContain('developer_role_normalized');
    }
  });

  it('中间位置的 developer 也转（system 已在首位 → 结果 [system, system, user]）', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toBe('B');
    expect(notes).not.toContain('system_injected');
    expect(notes).toContain('developer_role_normalized');
  });

  it('多个 developer：全部转换，一条都不丢，顺序不变', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'developer', content: 'C' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['system', 'system', 'system', 'user']);
    expect(body.messages).toHaveLength(4);
    expect(body.messages.map((m) => m.content)).toEqual(['A', 'B', 'C', 'hi']);
    expect(notes).toContain('developer_role_normalized');
  });

  it('developer 在首位之外、且无 system：转完再补 system（note 两条都在）', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'B' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    expect(body.messages).toHaveLength(3);
    expect(notes).toContain('developer_role_normalized');
    expect(notes).toContain('system_injected');
  });

  it('★ 无 developer 时零改动：不记 note、不加插、内容逐字不变', () => {
    const input = {
      model: 'a',
      messages: [
        { role: 'system', content: '人设' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ],
    };
    const { body, notes } = rewriteRequestBody(input);

    expect(notes).not.toContain('developer_role_normalized');
    expect(notes).not.toContain('system_injected');
    expect(body.messages).toEqual([
      { role: 'system', content: '人设' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
    // 其它自定义 role 不能被误伤
    expect(rewriteRequestBody({ model: 'a', messages: [{ role: 'foo', content: 'x' }, { role: 'user', content: 'hi' }] }).notes).not.toContain('developer_role_normalized');
    expect(rewriteRequestBody({ model: 'a', messages: [{ role: 'knowledge', content: 'x' }, { role: 'user', content: 'hi' }] }).notes).not.toContain('developer_role_normalized');
  });

  it('规范化保持其它字段（如 name / 额外属性）与纯函数性：原对象不被污染', () => {
    const original = {
      model: 'a',
      messages: [
        { role: 'developer', content: 'x', name: 'preamble' },
        { role: 'user', content: 'hi' },
      ],
    };

    const { body } = rewriteRequestBody(original);

    expect(body.messages[0]).toEqual({ role: 'system', content: 'x', name: 'preamble' });
    // 原数组与原元素对象都没被改
    expect(original.messages[0].role).toBe('developer');
  });
});

/**
 * [2026-10-07] role 白名单（方案 D）。#77 只堵了 `developer` 一个值；上游对自定义 role 的
 * 容忍度是黑盒，下一个 SDK 换个新角色名就会再打死整条请求。白名单外的 role 一律降级为
 * `user`（保留内容）——失效模式是"少一次语义"而不是"整条挂掉"。
 */
describe('rewriteRequestBody —— role 白名单（方案 D）', () => {
  it('★ 白名单外 role（如 knowledge）降级为 user，内容保留，note 记原始 role', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'knowledge', content: 'K' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(body.messages[1].content).toBe('K');
    expect(notes).toContain('role_normalized_knowledge');
  });

  it('同种非标 role 多条只记一条 note；role 名做净化（note 是逗号分隔列表，不能被 role 破坏）', () => {
    const { notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'foo bar,baz', content: 'x' },
        { role: 'foo bar,baz', content: 'y' },
      ],
    });

    expect(notes).toContain('role_normalized_foo_bar_baz');
    expect(notes.filter((n) => n.startsWith('role_normalized_'))).toHaveLength(1);
    // 净化后不含逗号 → 不会把 note 列表拆出幽灵条目
    for (const n of notes) expect(n).not.toContain(',');
  });

  it('白名单内 role 原样保留（含大小写变体，不擅自改写合法值）', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'User', content: 'u' },
        { role: 'ASSISTANT', content: 'a' },
        { role: 'tool', content: 't' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['system', 'User', 'ASSISTANT', 'tool']);
    expect(notes.filter((n) => n.startsWith('role_normalized_'))).toHaveLength(0);
  });

  it('developer 仍走保义转换（→ system），不落入白名单的 user 降级', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'developer', content: 'D' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.messages[0].role).toBe('system');
    expect(notes).toContain('developer_role_normalized');
    expect(notes).not.toContain('role_normalized_developer');
  });
});

/**
 * [2026-10-07] ⑥ system 提示模板改写。根因（probe/05-11128-fix-plan.md）：上游对 system 正文
 * 做 ≥47 连续字符的长 n-gram 模板指纹匹配（Claude Code 血统的 git 环境模板行），命中即
 * 400/11128。修复 = 模板行**语义等价改写**（T2 实验真 key 验证 200；社区 buddy-proxy /
 * workbuddy2api-ui 独立同结论）。零宽脱敏与身份词中性化均已被 D0 实验证伪，不做。
 */
describe('rewriteRequestBody —— ⑥ system 提示改写（template / neutral / off）', () => {
  // 真 ZCode system 提示的病灶区缩影（git 环境块 + Claude Code 身份句）
  const GIT_BLOCK =
    'You are Claude Code, an interactive coding agent\n\n' +
    'Here is useful information about the environment you are running in:\n' +
    'Current branch: master\n' +
    'Main branch (you will usually use this for PRs): master\n' +
    'Git user: someone\n\nStatus:\n(clean)\n\nRecent commits:\nabc123 init';

  it('★ template 档：模板行全部被语义等价改写，指纹原文不再连续出现，note 计数', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: GIT_BLOCK },
        { role: 'user', content: 'hi' },
      ],
    });

    const out = body.messages[0].content as string;
    expect(out).toContain('You are an interactive coding agent, an interactive coding agent');
    expect(out).toContain('Environment:');
    expect(out).toContain('Active branch: master');
    expect(out).toContain('Default PR target: master');
    expect(out).toContain('Git author: someone');
    expect(out).toContain('Working tree:');
    expect(out).toContain('Recent history:');
    // ★ 指纹原文必须被破坏（这正是 11128 的触发器）
    expect(out).not.toContain('Main branch (you will usually use this for PRs)');
    expect(out).not.toContain('You are Claude Code');
    expect(notes).toContain('template_rewritten_7');
    // 反探测：产物不得含裸业务码（社区实测请求体出现它本身也会被拦）
    expect(out).not.toContain('11128');
  });

  it('template 档只动 system：user 消息里的同类模板行逐字保留（证据范围只有 system）', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        { role: 'system', content: 'plain' },
        { role: 'user', content: 'Current branch: master\nMain branch (you will usually use this for PRs): master' },
      ],
    });

    expect(body.messages[1].content).toBe('Current branch: master\nMain branch (you will usually use this for PRs): master');
    expect(notes.filter((n) => n.startsWith('template_rewritten_'))).toHaveLength(0);
  });

  it('template 档：parts 数组 system 的 text part 也改写，非 text part 结构不动', () => {
    const { body, notes } = rewriteRequestBody({
      model: 'a',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Git user: someone' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
          ],
        },
        { role: 'user', content: 'hi' },
      ] as ChatRequestBody['messages'],
    });

    const parts = body.messages[0].content as unknown as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toBe('Git author: someone');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } });
    expect(notes).toContain('template_rewritten_1');
  });

  it('neutral 档：所有 system 换成中性提示（可自定义），其它消息不动', () => {
    const { body, notes } = rewriteRequestBody(
      {
        model: 'a',
        messages: [
          { role: 'system', content: '长篇人设……' },
          { role: 'system', content: '第二段 system' },
          { role: 'user', content: 'hi' },
        ],
      },
      { promptRewrite: 'neutral', neutralPrompt: 'You are a helpful assistant.' },
    );

    expect(body.messages[0].content).toBe('You are a helpful assistant.');
    expect(body.messages[1].content).toBe('You are a helpful assistant.');
    expect(body.messages[2].content).toBe('hi');
    expect(notes).toContain('sysprompt_neutralized_2');
  });

  it('off 档：system 内容逐字不动（指纹命中即失败，留给上游判）', () => {
    const { body, notes } = rewriteRequestBody(
      { model: 'a', messages: [{ role: 'system', content: GIT_BLOCK }, { role: 'user', content: 'hi' }] },
      { promptRewrite: 'off' },
    );

    expect(body.messages[0].content).toBe(GIT_BLOCK);
    expect(notes.filter((n) => n.startsWith('template_rewritten_') || n.startsWith('sysprompt_neutralized_'))).toHaveLength(0);
  });

  it('★ 纯函数性在带 opts 时同样成立：原对象不被污染', () => {
    const original = {
      model: 'a',
      messages: [{ role: 'system', content: GIT_BLOCK }, { role: 'user', content: 'hi' }],
    };
    const snapshot = JSON.stringify(original);

    rewriteRequestBody(original, { promptRewrite: 'neutral' });

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
