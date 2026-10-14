import { useEffect } from 'react';

/**
 * 把 prototype/assets/console-fx.js 的两件事搬到 React：
 * ① 卡片光标聚光（写 --mx/--my）  ② 图表柱体阶梯入场（写 --i + is-in）
 * prefers-reduced-motion 下由 CSS 兜底，这里只跳过监听。
 */
export function useFx(rootKey: string): void {
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timers: number[] = [];

    document.querySelectorAll<HTMLElement>('.js-stagger').forEach((group) => {
      Array.from(group.children).forEach((child, i) => {
        (child as HTMLElement).style.setProperty('--i', String(i % 14));
      });
    });

    if (reduce) {
      document.querySelectorAll<HTMLElement>('.js-grow').forEach((g) => g.classList.add('is-in'));
      return;
    }

    const spots = Array.from(document.querySelectorAll<HTMLElement>('.js-spot'));
    const onMove = (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
    };
    spots.forEach((el) => el.addEventListener('pointermove', onMove));

    const raf = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('.js-grow').forEach((g) => g.classList.add('is-in'));
    });

    return () => {
      cancelAnimationFrame(raf);
      spots.forEach((el) => el.removeEventListener('pointermove', onMove));
      timers.forEach((t) => clearTimeout(t));
    };
  }, [rootKey]);
}
