import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The settings page kit (GET-625): groups of bordered cards of
// rows — label on the left, control on the right. Every section in Settings is built from these
// three so the pages read as one product.

/** A section: a centered ~680px column of groups. `wide` for embedded app pages. The settings top
 *  bar names the section, so the page draws no title or grey line of its own (polish pass,
 *  GET-657); both props stay so callers need not change, and the title labels the region. */
export function SettingsPage({ title, children, wide }: {
  title?: string; description?: string; children: ReactNode; wide?: boolean;
}) {
  return (
    <section aria-label={title} className={cn("mx-auto w-full px-4 py-8 sm:px-6 sm:py-10", wide ? "max-w-[960px]" : "max-w-[680px]")}>
      {children}
    </section>
  );
}

/** A labelled card of rows. `flush` drops the row wrapper for tables / free-form bodies.
 *  The ⌘K palette's card (GET-658, round 2; ui/list ListCard): hairline border, 16px radius, no
 *  shadow, the title inside the card like Home's "Coming up", rows inset with no lines between. */
export function SettingsGroup({ title, action, children, className, bodyClassName }: {
  title?: string; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn("mb-5 last:mb-0", className)}>
      <div className={cn("relative overflow-hidden rounded-2xl border border-border/70 bg-card p-2", bodyClassName)}>
        {(title || action) && (
          <div className="flex min-h-8 items-center justify-between gap-3 px-2 pb-0.5 pt-0.5">
            {title && <h2 className="section-title">{title}</h2>}
            {action}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/** One row: label (+ grey hint) left, control right. Wraps under the label on a phone. */
export function SettingsRow({ label, hint, htmlFor, leading, children, className }: {
  label: ReactNode; hint?: ReactNode; htmlFor?: string; leading?: ReactNode; children?: ReactNode; className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-2 py-2", className)}>
      {leading}
      <Label {...(htmlFor ? { htmlFor } : {})} className="flex min-w-[140px] flex-1 flex-col gap-px">
        <span className="text-[13px] text-foreground">{label}</span>
        {hint && <span className="text-[11.5px] text-muted-foreground/70">{hint}</span>}
      </Label>
      {children !== undefined && <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** The 32px field the rows use. */
export const fieldCls =
  "h-8 w-full min-w-0 rounded-lg border border-border/70 bg-card px-2.5 text-[13px] text-foreground outline-none " +
  "transition-colors duration-fast placeholder:text-muted-foreground/45 focus:border-foreground/25 disabled:opacity-60 sm:w-[260px]";

/** The small 28×16 switch of the boards, on the shared Switch primitive. */
export const smallSwitchCls =
  "h-4 w-7 border-0 px-0.5 [&>span]:h-3 [&>span]:w-3 [&>span]:shadow-none [&>span]:data-[state=checked]:translate-x-3";
