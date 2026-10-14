import {
  cloneElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Placement = 'auto' | 'above' | 'below';

type TooltipProps = {
  content: ReactNode;
  children: ReactElement;
  placement?: Placement;
  className?: string;
};

type TooltipPosition = {
  left: number;
  top: number;
  placement: 'above' | 'below';
  maxWidth: number;
  arrowLeft: number;
};

type RefLike<T> = ((value: T | null) => void) | { current: T | null } | null | undefined;

type TriggerProps = Record<string, unknown> & {
  className?: string;
  disabled?: boolean;
  ref?: RefLike<HTMLElement>;
  tabIndex?: number;
};

const VIEWPORT_PAD = 12;
const GAP = 8;
const MAX_WIDTH = 300;

function assignRef<T>(ref: RefLike<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/**
 * Shared non-interactive tooltip. Normal triggers are enhanced in place so
 * block and inline layout remain unchanged; disabled controls use a focusable
 * proxy because native disabled elements do not emit hover or focus events.
 */
export function Tooltip({ content, children, placement = 'auto', className }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const childProps = children.props as TriggerProps;
  const disabled = childProps.disabled === true;
  const existingRef = childProps.ref;
  const childDescribedBy = typeof childProps['aria-describedby'] === 'string'
    ? childProps['aria-describedby']
    : undefined;
  const describedBy = [childDescribedBy, open ? id : undefined].filter(Boolean).join(' ') || undefined;
  const childTabIndex = typeof childProps.tabIndex === 'number'
    ? childProps.tabIndex
    : disabled
      ? undefined
      : 0;

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;

    const anchor = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxWidth = Math.min(MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_PAD * 2));
    const width = Math.min(maxWidth, tip.offsetWidth || maxWidth);
    const height = tip.offsetHeight;

    if (anchor.bottom < VIEWPORT_PAD || anchor.top > viewportHeight - VIEWPORT_PAD) {
      setPosition(null);
      return;
    }

    const aboveSpace = anchor.top - VIEWPORT_PAD;
    const belowSpace = viewportHeight - anchor.bottom - VIEWPORT_PAD;
    const canAbove = aboveSpace >= height + GAP;
    const canBelow = belowSpace >= height + GAP;
    const actualPlacement = placement === 'above'
      ? (canAbove || !canBelow ? 'above' : 'below')
      : placement === 'below'
        ? (canBelow || !canAbove ? 'below' : 'above')
        : canAbove || !canBelow
          ? 'above'
          : 'below';

    const center = anchor.left + anchor.width / 2;
    const left = Math.max(
      VIEWPORT_PAD,
      Math.min(center - width / 2, viewportWidth - width - VIEWPORT_PAD),
    );
    const arrowLeft = Math.max(12, Math.min(center - left, width - 12));
    const top = actualPlacement === 'above'
      ? Math.max(VIEWPORT_PAD, anchor.top - height - GAP)
      : Math.max(VIEWPORT_PAD, Math.min(viewportHeight - height - VIEWPORT_PAD, anchor.bottom + GAP));

    setPosition({ left, top, placement: actualPlacement, maxWidth, arrowLeft });
  }, [placement]);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
  }, [content, measure, open]);

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => measure();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || tipRef.current?.contains(target))) return;
      hide();
    };

    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [hide, measure, open]);

  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    assignRef(existingRef, node);
  }, [existingRef]);

  const setChildRef = useCallback((node: HTMLElement | null) => {
    assignRef(existingRef, node);
  }, [existingRef]);

  const setProxyRef = useCallback((node: HTMLSpanElement | null) => {
    triggerRef.current = node;
  }, []);

  const originalOnBlur = childProps.onBlur as ((event: FocusEvent<HTMLElement>) => void) | undefined;
  const onBlur = (event: FocusEvent<HTMLElement>, callChildHandler: boolean) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    if (callChildHandler) originalOnBlur?.(event);
    hide();
  };

  const triggerClassName = typeof childProps.className === 'string' && className
    ? `${childProps.className} ${className}`
    : className ?? childProps.className;
  const trigger = cloneElement(children, {
    ...(triggerClassName ? { className: triggerClassName } : {}),
    ref: disabled ? setChildRef : setTriggerRef,
    'aria-describedby': disabled ? childDescribedBy : describedBy,
    'data-tooltip-trigger': disabled ? undefined : 'true',
    tabIndex: childTabIndex,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      (childProps.onMouseEnter as ((event: MouseEvent<HTMLElement>) => void) | undefined)?.(event);
      show();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      (childProps.onMouseLeave as ((event: MouseEvent<HTMLElement>) => void) | undefined)?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      (childProps.onFocus as ((event: FocusEvent<HTMLElement>) => void) | undefined)?.(event);
      show();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => onBlur(event, !disabled),
  } as Partial<typeof children.props>);

  const portal = open && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`tooltip-surface tooltip-${position?.placement ?? 'measuring'}`}
          style={position
            ? {
                left: position.left,
                top: position.top,
                maxWidth: position.maxWidth,
                '--tooltip-arrow-left': `${position.arrowLeft}px`,
              } as CSSProperties
            : {
                visibility: 'hidden',
                maxWidth: Math.min(MAX_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_PAD * 2)),
              }}
        >
          {content}
        </div>,
        document.body,
      )
    : null;

  if (!disabled) {
    return (
      <>
        {trigger}
        {portal}
      </>
    );
  }

  const proxyDescribedBy = [childDescribedBy, open ? id : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <span
        ref={setProxyRef}
        className={`tooltip-anchor${className ? ` ${className}` : ''}`}
        data-tooltip-trigger="true"
        tabIndex={0}
        aria-describedby={proxyDescribedBy}
        aria-disabled="true"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={(event) => onBlur(event, false)}
      >
        {trigger}
      </span>
      {portal}
    </>
  );
}
