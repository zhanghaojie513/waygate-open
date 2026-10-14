/**
 * UA 关键词表（`identify/ua-table.ts`）的单测。
 *
 * 这张表是**纯数据 + 一个 includes 循环**，所以测试要钉的不是"逻辑多复杂"，
 * 而是三件会静默出错的事：
 *   ① 顺序 —— 表是「先匹配到就胜出」，笼统关键词排到具体关键词前面会误判，
 *      而误判的表现只是"工具名不对"，不报错、不崩溃；
 *   ② 认不出来时**必须**返回 null —— 编一个「未知工具」会让"真识别出某个工具"
 *      与"没认出来"在界面上长得一样；
 *   ③ 增补不撞车 —— 同一个关键词写两遍时，后一条永远不会生效（死数据）。
 */
import { describe, expect, it } from 'vitest';
import { detectTool, shortenUa, uaTableKeywords } from './ua-table';

describe('detectTool · 能认出来的', () => {
  it('Claude Code 的真实 UA', () => {
    // 实测形态（server/src/proxy/proxy-wiring.spec.ts 用的是同一个前缀）
    expect(detectTool('claude-cli/1.0.60 (external, cli)')?.tool).toBe('Claude Code');
  });

  it('大小写不敏感', () => {
    expect(detectTool('Cursor/0.42.3')?.tool).toBe('Cursor');
    expect(detectTool('CURSOR/0.42.3')?.tool).toBe('Cursor');
  });

  it('Python 脚本（未识别桶里最常见的来源）', () => {
    expect(detectTool('python-requests/2.32.3')?.tool).toBe('Python requests');
  });

  it('回显命中的关键词，便于解释判定依据', () => {
    // 注意断言的是**实际命中的那个变体**（空格写法），不是工具名的任意一种拼法。
    // 这条同时钉住"回显的是真依据"：若哪天有人把关键词换成不含它的写法，这里会红。
    const m = detectTool('Cherry Studio/1.2.0');
    expect(m).toEqual({ tool: 'Cherry Studio', keyword: 'cherry studio' });
  });

  it('同一工具的三种常见写法都认得（连字符 / 无分隔 / 空格）', () => {
    for (const ua of ['cherry-studio/1.2', 'CherryStudio/1.2', 'Cherry Studio/1.2']) {
      expect(detectTool(ua)?.tool).toBe('Cherry Studio');
    }
  });
});

describe('detectTool · 顺序（更具体的必须先匹配）', () => {
  it('带 anthropic-sdk 的 UA 不会被更笼统的 node 抢走', () => {
    // 真实情形：SDK 的 UA 里同时含 'anthropic-sdk' 与 'node'
    const ua = 'anthropic-sdk-typescript/0.30.0 node/20.11.0';
    expect(detectTool(ua)?.tool).toBe('Anthropic SDK');
  });

  it('openai-node 判为运行时 Node.js（v0.4.24：语言优先于 SDK 名）', () => {
    /* [v0.4.24 语义变更] 此前判「OpenAI Node SDK」，现在判「Node.js」——
       语言/运行时才是排障时有用的维度（Python 慢、Node 快、版本对不上），
       也是请求流 UA 列第二行展示的内容。SDK 名降为兜底（语言认不出时才用）。 */
    expect(detectTool('openai-node/4.20.0 node/18')?.tool).toBe('Node.js');
  });

  it('OpenAI/Python 判为 Python（不是 OpenAI SDK）', () => {
    /* 用户实际用例：hermes agent 用 OpenAI Python SDK 发请求，UA 是
       `OpenAI/Python 2.24.0` —— 应展示「Python」而不是「OpenAI SDK」。 */
    expect(detectTool('OpenAI/Python 2.24.0')?.tool).toBe('Python');
  });

  it('带 axios 的 claude-cli 仍判为 Claude Code（具体优先于运行时）', () => {
    // 若把 axios 排在前面，这一条会误判成 Node axios —— 这就是顺序敏感的意义
    expect(detectTool('claude-cli/1.0 axios/1.6')?.tool).toBe('Claude Code');
  });
});

describe('detectTool · 认不出来时必须返回 null', () => {
  it('空 / 缺失 / 纯空白', () => {
    expect(detectTool('')).toBeNull();
    expect(detectTool('   ')).toBeNull();
    expect(detectTool(null)).toBeNull();
    expect(detectTool(undefined)).toBeNull();
  });

  it('表里没有的 UA 不编造工具名', () => {
    expect(detectTool('WeirdClient/9.9 (unknown-build)')).toBeNull();
  });
});

describe('关键词表自身', () => {
  it('没有重复关键词（重复的那条永远不生效 = 死数据）', () => {
    const kws = uaTableKeywords();
    expect(new Set(kws).size).toBe(kws.length);
  });

  it('关键词一律小写（匹配前会把 UA 转小写，大写关键词永远匹配不上）', () => {
    for (const k of uaTableKeywords()) expect(k).toBe(k.toLowerCase());
  });
});

describe('shortenUa · 展示截断', () => {
  it('短 UA 原样返回', () => {
    expect(shortenUa('claude-cli/1.0')).toBe('claude-cli/1.0');
  });

  it('长 UA 截断并带省略号，长度受控', () => {
    const long = `claude-cli/1.0.60 (external, cli; ${'x'.repeat(200)})`;
    const out = shortenUa(long)!;
    expect(out.length).toBe(49); // 48 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('空 / 缺失返回 null（不显示空行）', () => {
    expect(shortenUa('')).toBeNull();
    expect(shortenUa(null)).toBeNull();
  });
});
