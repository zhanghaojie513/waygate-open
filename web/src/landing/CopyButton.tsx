import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 复制按钮。原型里这两个按钮（接入地址的「复制」、工具条的「复制」）没有接线。
 * 这里补上真实行为 —— 一个点了没反应的按钮比没有按钮更糟。
 *
 * 只用 navigator.clipboard（生产是 https / localhost，均在安全上下文内）；
 * 不可用时静默失败，不改 DOM、不弹错。反馈只在按钮文字上做短暂切换，
 * **不新增任何视觉元素**，因此不破坏与原型的像素一致性。
 */
export function CopyButton({
  text,
  className,
  label,
  idle = '复制',
  done = '已复制',
}: {
  text: string;
  className: string;
  label?: string;
  idle?: string;
  done?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const onClick = useCallback(() => {
    const clip = navigator.clipboard;
    if (!clip || typeof clip.writeText !== 'function') return;
    void clip.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  }, [text]);

  return (
    <button className={className} type="button" aria-label={label} onClick={onClick}>
      {copied ? done : idle}
    </button>
  );
}
// @zbiti-ai:f:47:953d7815
