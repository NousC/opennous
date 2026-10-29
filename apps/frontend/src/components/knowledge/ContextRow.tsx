// One row of Settings > Context (2026-10-29): the file's title, a quiet meta line on the right
// (kind, who sees it, when it changed), then its controls. No leading icon, pill or chevron: the
// list reads as a list of documents. The whole row opens the file; controls on the right (a switch,
// a button) work on their own.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function ContextRow({ title, meta, hint, error, onOpen, children }: {
  title: ReactNode;
  /** Kind, sharing, date, joined with " · ". Hidden on a phone. */
  meta?: (string | null | undefined | false)[];
  /** What the file is, on hover over its title. */
  hint?: string;
  /** A failed run or sync, under the title. */
  error?: string | null;
  onOpen?: () => void;
  /** Controls on the right. */
  children?: ReactNode;
}) {
  const line = (meta ?? []).filter(Boolean).join(' · ');
  const body = <>
    <span className="min-w-0 flex-1" title={hint}>
      <span className="block truncate text-[13.5px] text-foreground">{title}</span>
      {error && <span className="mt-0.5 block text-[12px] text-risk">{error}</span>}
    </span>
    {line && <span className="hidden shrink-0 text-[12px] tabular-nums text-muted-foreground sm:inline">{line}</span>}
  </>;
  return <div className={cn('flex min-h-11 items-center gap-3 rounded-lg px-2', onOpen && 'transition-colors duration-fast hover:bg-hover')}>
    {onOpen
      ? <button type="button" aria-haspopup="dialog" onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg text-left">{body}</button>
      : <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>}
    {children}
  </div>;
}
