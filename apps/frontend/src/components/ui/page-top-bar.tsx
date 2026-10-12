import * as React from "react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * The 48px bar at the top of every page's panel (GET-594, interface refresh).
 * Breadcrumb on the left — the last crumb is the current page, the ones before it are
 * links — and the page's actions on the right (Priorities and Ask Nous live here once the
 * shell lands, GET-598). It replaces the hand-rolled h1 each page drew for itself.
 */
export interface Crumb {
  label: React.ReactNode;
  href?: string;
}

export interface PageTopBarProps extends React.HTMLAttributes<HTMLElement> {
  icon?: React.ReactNode;
  crumbs: Crumb[];
  /** Sits right after the last crumb — e.g. the "1 of 128" record navigator. */
  after?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageTopBar({ icon, crumbs, after, actions, className, ...props }: PageTopBarProps) {
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b border-hairline pl-4 pr-3 text-[13px]",
        className,
      )}
      {...props}
    >
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex shrink-0 text-muted-foreground/60 [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">{icon}</span>}
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && <span aria-hidden className="text-muted-foreground/30">/</span>}
              {last || !c.href ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn("truncate", last ? "text-foreground" : "text-muted-foreground/70")}
                >
                  {c.label}
                </span>
              ) : (
                <Link to={c.href} className="truncate text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
                  {c.label}
                </Link>
              )}
            </React.Fragment>
          );
        })}
      </nav>
      {after}
      <div className="flex-1" />
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** The row under the top bar that holds a page's tabs, search and filters. Wraps on narrow screens. */
export function PageToolbar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5", className)}
      {...props}
    />
  );
}
