import { AlertTriangle, HardDrive, Landmark } from 'lucide-react';
import type { OverviewProvenance, QuotaState } from '../../types/api';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';

/** 服务端只会回这三个 reason（types/api.d.ts），写成穷尽映射，接口一变就编译不过。 */
const REASON_LABEL: Record<QuotaState['reason'], string> = {
  ok: '额度接口正常',
  quota_endpoint_not_configured: '未配置额度端点',
  quota_endpoint_error: '额度端点拉取失败',
};

/**
 * 配额数据来源卡 —— 本页的设计重点（Spec v4-console-usage §4 第 6 块）。
 *
 * 这一页上其实是**两套账**：官方额度接口给的"还剩多少"，和本机按请求累计出来的
 * "花了多少"。两者必然对不齐（取样时刻不同），所以必须把口径摊开写，而不是让用户
 * 自己怀疑哪边是错的。
 *
 * `provenance` 是接口的强制字段（api-contract §3.4），前端不得省略 —— 原样渲染。
 */
export function QuotaSourceCard({
  quota,
  provenance,
  windowLabel,
}: {
  quota: QuotaState;
  provenance: OverviewProvenance;
  /** [v0.4.8] 标题跟随所选时间窗（原写死「近 30 天趋势」） */
  windowLabel: string;
}) {
  const available = quota.available && quota.remain !== null;

  return (
    <Panel
      title="配额数据来源"
      aside={
        <Pill tone={quota.available ? 'live' : 'amber'} dot>
          {REASON_LABEL[quota.reason]}
        </Pill>
      }
    >
      <div className="src-grid">
        <div className="src-col">
          <div className="src-head">
            <Landmark size={13} aria-hidden />
            来自上游额度接口
            <span className="tag tag-live">官方口径</span>
          </div>
          <ul>
            <li>
              <b>剩余积分</b>
              <i>quota.remain</i>
            </li>
            <li>
              <b>总量</b>
              <i>quota.total</i>
            </li>
            <li>
              <b>重置时间</b>
              <i>quota.resetAt</i>
            </li>
          </ul>
          <div className="src-state">
            {available ? (
              quota.stale ? (
                <>
                  <AlertTriangle size={13} aria-hidden />
                  上次拉取失败，当前显示的是上一次成功值（不会清空）。
                </>
              ) : (
                '已接入，随配额端点轮询刷新。'
              )
            ) : (
              <>未接入 —— 上面三项显示 <i>--</i>。服务端不做估算，前端更不会替它编一个。</>
            )}
          </div>
        </div>

        <div className="src-col">
          <div className="src-head">
            <HardDrive size={13} aria-hidden />
            本机按请求累计
            <span className="tag tag-off">非官方口径</span>
          </div>
          <ul>
            <li>
              <b>已消耗积分</b>
              <i>仅统计经本服务转发的请求，按上游实扣累加（官方客户端直连不计入）</i>
            </li>
            <li>
              <b>{windowLabel}趋势</b>
              <i>本机日志按天聚合</i>
            </li>
            <li>
              <b>按模型 / 按提供商消耗</b>
              <i>同一次聚合的一体两面</i>
            </li>
          </ul>
          <div className="src-state">
            这些数即时产生，不等额度接口 —— 也正是它和「剩余积分」会对不齐的原因。
          </div>
        </div>
      </div>

      {quota.message ? <div className="footer-note">{quota.message}</div> : null}
      <div className="footer-note">{provenance.note}</div>
      <div className="footer-note">
        官方额度接口按 <span className="code-chip">quota.pollSeconds</span>（默认 <b>30 秒</b>）轮询，
        所以「剩余积分」最多滞后 30 秒；本机累计的消耗是即时的。
        两者最多相差 <b>30 秒内的消耗量</b> —— 这是取样时刻不同，不是账对不上。
        来源标记：已消耗积分 <span className="code-chip">{provenance.creditsUsed}</span>
        {' · '}
        剩余积分 <span className="code-chip">{provenance.quotaRemain}</span>。
      </div>
    </Panel>
  );
}
// @zbiti-ai:f:115:2fc2ad88
