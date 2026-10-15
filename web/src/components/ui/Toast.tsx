import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 项目级消息提示（Toast）—— 浮在页面**顶部居中**、几秒后自动消失。
 *
 * ## 与 Banner 的分工（两者不可互相替代）
 * - `Banner`：**页内**常驻提示，属于某个区块的上下文（登录失败、保存结果）——
 *   它会一直在，直到该区块重渲染；用户看得见「这条属于我刚做的那个动作」。
 * - `Toast`：**跨区块**的瞬时反馈，属于「我刚点的那一下」而不属于任何容器 ——
 *   表格行里的按钮点完，在那一行下面塞提示会撑乱表格；而用户又需要立刻知道
 *   「成了没有」。所以浮层 + 自动消失是这类动作的正确形态。
 *
 * ## 为什么自建而不是引库
 * 需求只有「顶部、队列、自动消失、四种 tone、可手动关」，引一个 toast 库
 * 带来的主题适配（本项目全部走 CSS 令牌 + 明暗双主题）与打包体积都不划算。
 *
 * ## 无障碍
 * - 容器 `aria-live="polite"`：读屏在空闲时播报，不打断当前朗读。
 * - error/warn 的任务额外带 `role="alert"`（交给 Banner 的既有语义）；
 *   自动消失的时长对 error 放宽（8s vs 5s）—— 失败信息值得多看一眼。
 * - 悬停/聚焦时**暂停倒计时**：用户正在读，不该被抽走。
 * - `prefers-reduced-motion` 下不做入场动画（tokens.css 已把时长令牌归零）。
 *
 * ## 纪律
 * 调用方只传「发生了什么」，不传样式；tone 与 Banner 同一套词汇
 * （error / success / info / warn），全站语义一致。
 */
export type ToastTone = 'error' | 'success' | 'info' | 'warn';

export interface ToastInput {
  tone: ToastTone;
  /** 一句话说明结果。过长会换行，但不该超过两行 —— 细节交给页内内容承载。 */
  message: string;
  /** 毫秒；不传按 tone 取默认（success/info 5s，warn/error 8s）。 */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  /** 弹一条提示。返回 id（一般不需要）。 */
  push: (t: ToastInput) => number;
  /** 手动关掉一条。 */
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_META: Record<ToastTone, { icon: LucideIcon; defaultMs: number }> = {
  error: { icon: AlertTriangle, defaultMs: 8000 },
  warn: { icon: AlertTriangle, defaultMs: 8000 },
  success: { icon: CheckCircle2, defaultMs: 5000 },
  info: { icon: Info, defaultMs: 5000 },
};

/** 同时最多显示几条 —— 超出时淘汰最旧的（避免刷屏时铺满屏）。 */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((list) => [...list, { ...t, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            <div className="toast-stack" aria-live="polite" aria-atomic="false">
              {items.map((t) => (
                <ToastCard key={t.id} item={t} onDismiss={dismiss} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

/** 单条提示：自带倒计时，悬停/聚焦暂停。 */
function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { icon: Icon, defaultMs } = TONE_META[item.tone];
  const total = item.durationMs ?? defaultMs;
  const [paused, setPaused] = useState(false);
  const [left, setLeft] = useState(total);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const remain = total - (Date.now() - started);
      if (remain <= 0) {
        window.clearInterval(timer);
        onDismiss(item.id);
      } else {
        setLeft(remain);
      }
    }, 100);
    return () => window.clearInterval(timer);
    /* paused 变化时重新计时（暂停即丢弃已过时间 —— 简化且对用户更宽松） */
  }, [paused, total, item.id, onDismiss]);

  void left; // 进度条按 CSS 动画跑，这里只驱动到期判定

  return (
    <div
      className={`toast toast-${item.tone}`}
      role={item.tone === 'error' || item.tone === 'warn' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="toast-ico" size={15} aria-hidden="true" />
      <div className="toast-body">{item.message}</div>
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => onDismiss(item.id)}>
        ×
      </button>
      <span
        className={`toast-progress${paused ? ' paused' : ''}`}
        style={{ animationDuration: `${total}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * 取 Toast API。必须在 `ToastProvider` 内使用 —— 在 Provider 外调用时
 * 静默降级为 no-op（不抛错）：提示属于「锦上添花」，不该因为少挂一个 Provider
 * 就让整个页面崩掉。
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return api ?? { push: () => 0, dismiss: () => {} };
}
