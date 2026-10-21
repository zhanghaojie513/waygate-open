import type { RequestDetail } from '../../types/api';
import { formatDuration } from '../../lib/format';

/**
 * 「时间去哪了」分解（v1.7.2）。
 *
 * 四段，全部由后端的分段计时列算出，**前端不做任何推算**：
 *   · 客户端上行 = ingressMs（进门 → body 就绪）——**不是**我方开销
 *   · 我方开销   = authMs + prepMs（鉴权 + 路由/目录/凭证/组包）
 *   · 上游等待   = upstreamWaitMs（首次发往上游 → 首字节）
 *   · 流式输出   = 总耗时 − 上面几段
 *
 * 为什么上行要单列（发版当天生产实证）：agent 的 body 常有几十 MB（长会话 + 图片
 * base64），那段时间是**客户端在上传**。第一版把它算进「我方开销」，导致 `auth_ms`
 * 出现 9.6 秒的假值 —— 归因完全反了。
 *
 * 口径纪律：任一段为 null 时显示 `--`（未知），**绝不显示 0**
 * —— 0 是「同毫秒完成」的真实测量值，与「没测到」是两件事。
 * 三段都缺（迁移前的老行）时整块不渲染，不占位置假装有信息。
 */
export function TimingBreakdown({ row }: { row: RequestDetail }) {
  const { authMs, prepMs, upstreamWaitMs, ingressMs } = row;
  /* 我方开销需要**两段都有**才算得出来：只知其一就把另一半当 0，会低估。 */
  const selfMs = authMs !== null && prepMs !== null ? authMs + prepMs : null;
  const known = authMs !== null || prepMs !== null || upstreamWaitMs !== null || ingressMs !== null;
  if (!known) return null;

  const streamMs =
    selfMs !== null && upstreamWaitMs !== null
      ? Math.max(0, row.ms - selfMs - upstreamWaitMs - (ingressMs ?? 0))
      : null;
  const total = row.ms || 1;
  const pct = (v: number | null) => (v === null ? 0 : Math.min(100, (v / total) * 100));

  /* 我方开销偏高时给一句提示：自用工具里 >50ms 就值得看一眼 ——
     尤其 prepMs 里藏着 WorkBuddy access token 到期时的 refresh 往返。 */
  const selfWarn = selfMs !== null && selfMs >= 50;
  /* 上行偏大（>1s）提示一句，避免用户以为网关慢。 */
  const ingressBig = ingressMs !== null && ingressMs >= 1000;

  return (
    <div className="detail-row timing-split">
      <span className="k">时间去哪了</span>
      <div className="v timing-rows">
        <div className="timing-bar" aria-hidden>
          <span className="timing-seg seg-ingress" style={{ width: `${pct(ingressMs)}%` }} />
          <span className="timing-seg seg-self" style={{ width: `${pct(selfMs)}%` }} />
          <span className="timing-seg seg-upstream" style={{ width: `${pct(upstreamWaitMs)}%` }} />
          <span className="timing-seg seg-stream" style={{ width: `${pct(streamMs)}%` }} />
        </div>
        <div className="timing-legend">
          <span className={ingressBig ? 'timing-item timing-hint-item' : 'timing-item'}>
            <i className="dot dot-ingress" />
            {`客户端上行 ${ingressMs === null ? '--' : formatDuration(ingressMs)}`}
            {ingressBig ? <em>· 大 body 上传，不计入我方</em> : null}
          </span>
          <span className={selfWarn ? 'timing-item timing-warn' : 'timing-item'}>
            <i className="dot dot-self" />
            {`我方 ${selfMs === null ? '--' : formatDuration(selfMs)}`}
            {authMs !== null && prepMs !== null ? (
              <em>{`（鉴权 ${formatDuration(authMs)} · 准备 ${formatDuration(prepMs)}）`}</em>
            ) : null}
            {selfWarn ? <em className="timing-hint">· 偏高（含凭证刷新时正常）</em> : null}
          </span>
          <span className="timing-item">
            <i className="dot dot-upstream" />
            {`上游等待 ${upstreamWaitMs === null ? '--' : formatDuration(upstreamWaitMs)}`}
          </span>
          <span className="timing-item">
            <i className="dot dot-stream" />
            {`流式输出 ${streamMs === null ? '--' : formatDuration(streamMs)}`}
          </span>
        </div>
      </div>
    </div>
  );
}
