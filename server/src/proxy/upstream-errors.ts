import { RelayHttpError } from '../common/errors';

/**
 * 上游错误码 -> 我们的 HTTP 状态 + error.code（api-contract §2.1.5）。
 *
 * 最关键的一条：**上游 401 必须映射成 502 + upstream_credential_invalid**，
 * 绝不能原样返回 401 —— 否则客户端会以为是自己手里的 sk-waygate- 密钥错了，
 * 排障方向从"上游凭证失效"跑到"我的密钥过期"，这是最典型的误导性错误。
 */

export interface MappedError {
  httpStatus: number;
  code: string;
  message: string;
  /** 是否需要针对同一请求重试一次（口径见 ADR-004 第 7 点）。 */
  retryable: boolean;
  /** 把该模型在 model_catalog 标 verified=0（11102）。 */
  markModelUnavailable?: boolean;
  /** 提升 max_tokens 后重试（11133）。 */
  raiseMaxTokens?: boolean;
  /**
   * 是否把上游原文（`msg` / `error.message`）附到 message 后面。
   *
   * 手写文案已经把排障方向说清的码（11128 等）不附，避免噪音；
   * 文案空泛或上游原文本身带关键数字的码（11115 的 token 数）附上。
   */
  appendUpstreamDetail?: boolean;
}

const UPSTREAM_CODE_MAP: Record<number, MappedError> = {
  11101: {
    httpStatus: 502,
    code: 'upstream_11101',
    message: '上游拒绝了非流式请求，说明上游协议已变更（我们本该强制 stream:true）。',
    retryable: false,
  },
  11102: {
    httpStatus: 400,
    code: 'model_not_available',
    message: '该模型在当前账号下不可用（上游按账号配置模型，非全局）。',
    retryable: false,
    markModelUnavailable: true,
  },
  /* ★ 11115（2026-10-12 实测取证）：`prompt is too long: 1266460 tokens > 1048576 maximum`。
     这是**上下文超限**，不是体量、不是协议、更不是模型不可用 —— 上游在推理前先算 token 再拒。
     为什么必须单列一条：它此前落到「未预期状态码 400」的兜底，客户端只看到一句没方向的话，
     而真相是「把历史/工具结果裁短就能过」。附上游原文是为了带上真实 token 数与上限。 */
  11115: {
    httpStatus: 400,
    code: 'context_length_exceeded',
    message:
      '上下文超限：本次请求的 prompt 超过了该模型的上下文上限，上游在推理前即拒绝（未产生任何输出、未计费）。请精简对话历史或工具输出（工具结果占位/摘要）后重试；这是客户端侧可自行纠正的问题，重试同一请求必然同样被拒。',
    retryable: false,
    appendUpstreamDetail: true,
  },
  11128: {
    httpStatus: 502,
    code: 'upstream_11128',
    // 根因定案（2026-10-07，task#79/D0/二分/T2，见 probe/05-11128-fix-plan.md）：
    // 上游在推理前对 system 正文做**长 n-gram 模板指纹匹配**（最小触发窗口实测 47 连续
    // 字符，即 Claude Code 血统的 git 环境模板行），命中即以「unapproved channel」拒绝。
    // `developer` role（task#77）是另一个独立的已知触发点；UA/自定义头已被 35+ 次直连探针排除。
    // 本服务两层防护：rewrite.ts 第 ⑥ 步模板行改写（默认开）+ 本文件上游 11128 时
    // proxy.service 以 neutral 档降级重试一次。走到这条映射 = 两层都没救回来。
    message:
      '上游返回业务码 11128（上游原文「Illegal API invocation from an unapproved channel」）：本次请求的 system 提示命中了上游对第三方客户端模板的指纹校验。本服务已在转发前改写模板行，并在被拒时自动降级为中性提示重试一次，均未通过；请检查「设置 → 上游连接 → system 提示改写」是否被关闭，或把该请求的特征反馈给维护者。',
    // 不可重试：同一请求重试必然携带同一指纹，徒增延迟（ZCode 曾因 retryable=true 连重 10 次）。
    retryable: false,
  },
  11133: {
    httpStatus: 400,
    code: 'invalid_max_tokens',
    message: 'max_tokens 过小，提升后仍被上游拒绝。',
    retryable: true,
    raiseMaxTokens: true,
  },
};

export function mapUpstreamBusinessCode(code: number): MappedError {
  return (
    UPSTREAM_CODE_MAP[code] ?? {
      httpStatus: 502,
      code: `upstream_${code}`,
      message: `上游返回未知业务码 ${code}。`,
      retryable: false,
      // 未知码正是最需要上游原文的时候：没有它，排障只能看到一串数字。
      appendUpstreamDetail: true,
    }
  );
}

export function mapUpstreamHttpStatus(status: number): MappedError {
  if (status === 401 || status === 403) {
    return {
      httpStatus: 502,
      code: 'upstream_credential_invalid',
      message:
        '上游访问密钥无效或已被吊销。请到「客户端与密钥 → 上游连接」更新从 WorkBuddy 控制台「访问密钥」页为 CodeBuddyCLI 生成的那把 ck_ 密钥。',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      httpStatus: 429,
      code: 'rate_limited',
      message: '上游限流。',
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      httpStatus: 502,
      code: 'upstream_error',
      message: `上游返回 ${status}。`,
      retryable: true,
      appendUpstreamDetail: true,
    };
  }
  return {
    httpStatus: 502,
    code: 'upstream_error',
    message: `上游返回未预期状态码 ${status}。`,
    retryable: false,
    /* ★ 2026-10-12：这条兜底以前**完全丢弃上游响应体**，生产上表现为
       「未预期状态码 400」而 body 里写着 `{"code":11115,"msg":"prompt is too long: …"}`。
       现在把上游原文附上；万一将来出现新业务码，日志里能直接看到码，而不是只剩数字 400。 */
    appendUpstreamDetail: true,
  };
}

/** 上游原文在 message 里的统一前缀，便于前端/人眼一眼分辨「我们的文案」与「上游原话」。 */
const UPSTREAM_DETAIL_PREFIX = '上游原文：';

/**
 * 把上游原文拼到 message 末尾（已折叠空白 + 截断，见 `parseUpstreamFailure`）。
 * ⚠️ 只拼 `msg` / `error.message` 这类**错误消息字段**，绝不回传整个响应体。
 */
export function withUpstreamDetail(m: MappedError, detail: string | null): string {
  if (!m.appendUpstreamDetail || !detail) return m.message;
  return `${m.message}（${UPSTREAM_DETAIL_PREFIX}${detail}）`;
}

export function toRelayError(
  m: MappedError,
  upstreamCode?: number | null,
  upstreamDetail?: string | null,
): RelayHttpError {
  return new RelayHttpError({
    httpStatus: m.httpStatus,
    code: m.code,
    message: withUpstreamDetail(m, upstreamDetail ?? null),
    apiCode: m.httpStatus === 429 ? 40290 : undefined,
    upstreamCode: upstreamCode ?? null,
  });
}
