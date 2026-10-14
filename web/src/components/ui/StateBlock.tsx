import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import type { ApiError } from '../../services/http';

/** 空 / 错误 / 首次加载三态的统一渲染。每个资源型区块都必须覆盖这三态。 */
export function StateBlock({
  kind,
  title,
  detail,
  onRetry,
  children,
}: {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  detail?: ReactNode;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  if (kind === 'loading') {
    return (
      <div className="state-block" role="status" aria-live="polite" aria-busy="true">
        <Loader2 size={22} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
        <div className="t">{title ?? '加载中…'}</div>
      </div>
    );
  }
  if (kind === 'empty') {
    return (
      <div className="state-block" role="status" aria-live="polite">
        <Inbox size={26} />
        <div className="t">{title ?? '暂无数据'}</div>
        {detail ? <div className="d">{detail}</div> : null}
        {children}
      </div>
    );
  }
  return (
    <div className="state-block" role="alert" aria-live="assertive">
      <AlertTriangle size={26} />
      <div className="t">{title ?? '加载失败'}</div>
      {detail ? <div className="d">{detail}</div> : null}
      {onRetry ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
          <RefreshCw size={14} />
          重试
        </button>
      ) : null}
    </div>
  );
}

/** 把 ApiError 翻译成「人话 + 下一步动作」，禁止裸露 Internal server error。 */
export function errorDetail(err: ApiError | null): string {
  if (!err) return '';
  const map: Record<number, string> = {
    40001: '有字段没通过校验，回退一步检查刚填的内容。',
    40002: '确认文字不匹配 —— 这是刻意设计的门槛。',
    40101: '管理口令不正确，注意区分大小写。',
    40102: '会话已过期，登录后继续。',
    40290: `登录失败次数过多，请 ${err.retryAfterSeconds ? Math.ceil(err.retryAfterSeconds / 60) : 10} 分钟后重试。`,
    40301: '请求来源校验失败（CSRF 防护），刷新页面重试。',
    40401: '这条记录已不存在，可能刚被删掉了。',
    40901: '同名密钥已存在，换一个名字。',
    50001: '服务端未分类异常，可稍后重试或查看服务日志。',
    50301: '数据库暂时不可用，确认后端进程是否在运行。',
  };
  /* [task#54 C] 40001 / 50001 是**兜底桶**：后端 `api.filter` 把所有 400 / 未分类 500 都归到这两个码，
     所以它们下面的 `message` 往往就是**具体原因**（例：`未配置上游访问密钥（RELAY_UPSTREAM_KEY），
     无法实测模型…`）。以前无条件返回上面那句通用文案，等于把具体原因换成一句猜的 ——
     用户在「获取模型」失败时读到「有字段没通过校验」，方向完全错了。
     现在：服务端给了**自撰的中文原因**就用它；只有服务端没给（框架默认英文，如 `Bad Request Exception`）
     时才回落到本地文案。中文字符判据用于区分「服务端自撰」与「框架兜底」，不是语言偏好。 */
  if ((err.code === 40001 || err.code === 50001) && /[\u4e00-\u9fa5]/.test(err.message)) return err.message;
  if (map[err.code]) return map[err.code];
  if (err.status === 0) return err.message;
  return err.message || `请求失败（HTTP ${err.status}）`;
}
// @zbiti-ai:f:77:aab08a9e
