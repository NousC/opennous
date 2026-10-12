import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One empty state for the whole app (standard 13, GET-594): an icon, what will fill this
 * space, and at most one action. Copy says what fills it ("Promises made on a call show up
 * here once it's transcribed."), never just "No data".
 */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  /** Dashed border box; off when the empty state sits inside a card that already has one. */
  bordered?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, body, action, bordered = true, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 px-6 py-7 text-center",
        bordered && "rounded-xl border border-dashed border-border",
        className,
      )}
    >
      {icon && (
        <span className="mb-1 flex size-8 items-center justify-center rounded-[10px] bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      )}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {body && <p className="max-w-sm text-xs text-muted-foreground">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
