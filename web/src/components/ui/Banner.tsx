import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';

/**
 * 统一提示条 —— 收口全站三套并存的提示词汇（`.login-error` / `.up-result` / `.note`）。
 *
 * ## 为什么必须统一（finesse 反廉价黑名单 · product §9）
 * 「Inconsistent component vocabulary（同一动作/同一语义，不同外观）」是 product 级
 * 反模式：错误提示在登录页是一种样式、在提供商页是另一种、保存成功又是第三种，
 * 用户学不会「看到这个样式 = 出了什么事」。
 *
 * ## 四种 tone 与语义
 * - `error`   破坏性失败 / 请求被拒（role="alert"，读屏立即播报）
 * - `success` 操作成功（role="status"）
 * - `info`    中性提示 / 进行中状态（role="status"）
 * - `warn`    警告：没坏但需要看一眼（role="alert" —— 阈值告警属于此类）
 *
 * 迁移纪律：旧类名 `.login-error` / `.up-result` / `.note` 的 CSS 先保留
 * （app.css），等最后一个消费点迁完再删——两套并存期「新组件 + 旧样式」不会同时
 * 挂在同一节点上。
 */
const TONE_META: Record<BannerTone, { icon: LucideIcon }> = {
  error: { icon: AlertTriangle },
  success: { icon: CheckCircle2 },
  info: { icon: Info },
  warn: { icon: AlertTriangle },
};

export type BannerTone = 'error' | 'success' | 'info' | 'warn';

export function Banner({
  tone,
  children,
  actions,
}: {
  tone: BannerTone;
  children: ReactNode;
  /** 右侧重操作（重试 / 关闭取证等）；不放次要链接。 */
  actions?: ReactNode;
}) {
  const Icon = TONE_META[tone].icon;
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' || tone === 'warn' ? 'alert' : 'status'}>
      <Icon className="banner-ico" size={15} aria-hidden="true" />
      <div className="banner-body">{children}</div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}
