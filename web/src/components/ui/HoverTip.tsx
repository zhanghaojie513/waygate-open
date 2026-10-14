import { isValidElement, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

/**
 * Compatibility wrapper for older imports. New consumers should use Tooltip
 * directly; the shared primitive owns portal positioning and accessibility.
 */
export function HoverTip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  if (!isValidElement(children)) return <>{children}</>;
  return (
    <Tooltip content={content} className={className}>
      {children}
    </Tooltip>
  );
}
