// The Overview's building blocks (interface refresh, GET-609), shared by the account and the
// deal: the highlight tile, a card with its 13.5px heading, and one row of "what happened". Since
// GET-658 they speak the search palette's language (ui/list): hairline cards, inset rows, quiet greys.
import type { ReactNode } from "react";
import { ArrowRight, FileText, Mail, MessageSquare, Video, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListMeta, ListText, ListTile, listRowClass } from "@/components/ui/list";

// The search palette's card (GET-658): hairline border, 16px radius, no shadow. The same look as
// ui/list's ListCard, so a record's cards and Home's read as one product.
export const CARD = "rounded-2xl border border-border/70 bg-card";

/** A card or section title: 13.5px medium, never bold. */
export function H3({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("section-title", className)}>{children}</h3>;
}

/** One highlight: a quiet label, the value at 13px, a quiet line under it. Inset like a palette row. */
export function Tile({ label, value, sub, subTone, onClick, title, empty }: {
  label: string; value: ReactNode; sub?: ReactNode; subTone?: "risk" | "warning"; onClick?: () => void;
  /** A tooltip for the whole tile, e.g. where its number comes from. */
  title?: string;
  /** The value is a "—": drawn quieter. */
  empty?: boolean;
}) {
  const body = (
    <>
      <span className="truncate text-[11.5px] text-muted-foreground/70">{label}</span>
      <span className={cn("max-w-full truncate text-[13px] tabular-nums", empty ? "text-muted-foreground/50" : "text-foreground")}>{value}</span>
      {sub != null && <span className={cn("max-w-full truncate text-[12px] tabular-nums", subTone === "risk" ? "text-risk" : subTone === "warning" ? "text-warning" : "text-muted-foreground/70")}>{sub}</span>}
    </>
  );
  const cls = "flex min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left";
  return onClick
    ? <button type="button" title={title} onClick={onClick} className={cn(cls, "transition-colors duration-fast hover:bg-hover")}>{body}</button>
    : <div title={title} className={cls}>{body}</div>;
}

/** The highlight tiles in ONE card, no lines between them (the palette's way), `cols` across from sm up. */
export function TileStrip({ children, cols = 3, className }: { children: ReactNode; cols?: 2 | 3; className?: string }) {
  return (
    <section className={cn(CARD, "grid grid-cols-1 gap-0.5 p-1.5", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>
      {children}
    </section>
  );
}

/** A card's heading row, the palette's ListHeader: the title, a quiet count, "View all" on the right. */
export function CardHead({ title, count, right, onAll, allLabel = "View all", className }: {
  title: ReactNode; count?: number; right?: ReactNode; onAll?: () => void; allLabel?: string; className?: string;
}) {
  return (
    <div className={cn("flex min-h-8 min-w-0 items-center gap-2 px-2", className)}>
      <H3 className="truncate">{title}</H3>
      {count != null && <span className="text-[12px] tabular-nums text-muted-foreground/60">{count}</span>}
      <span className="flex-1" />
      {right}
      {onAll && <button type="button" onClick={onAll} className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground">{allLabel}</button>}
    </div>
  );
}

export type EventKind = "meeting" | "email" | "message" | "crm" | "document" | "signal";

const EVENT_ICON: Record<EventKind, typeof Video> = { meeting: Video, email: Mail, message: MessageSquare, crm: ArrowRight, document: FileText, signal: Zap };

/** What kind of thing an activity row is, for its icon. */
export function eventKind(type: string | null | undefined, source?: string | null): EventKind {
  const t = String(type ?? "").toLowerCase();
  const s = String(source ?? "").toLowerCase();
  if (/meeting|(^|_)call(_|$)/.test(t)) return "meeting";
  if (t.includes("email")) return "email";
  if (t.includes("linkedin") || t.includes("message") || s === "linkedin") return "message";
  if (/^(deal|stage|lifecycle|crm|note|task)/.test(t) || /hubspot|salesforce|pipedrive|attio|zoho/.test(s)) return "crm";
  return "signal";
}

/**
 * One thing that happened, as a palette row: the tool's logo in a 24px tile (a quiet kind icon when
 * no tool is known), what it was at 13px with what was said beside it in the quiet tone, when.
 */
export function EventRow({ kind, title, meta, sub, when, href, onClick, logo }: {
  kind: EventKind; title: ReactNode; meta?: ReactNode; sub?: ReactNode; when?: string; href?: string; onClick?: () => void;
  /** The tool it came from (GET-659); drawn instead of the kind icon. */
  logo?: string | null;
}) {
  const Icon = EVENT_ICON[kind];
  const context = [meta, sub].filter(Boolean);
  const inner = (
    <>
      <ListTile>
        {logo ? <img src={logo} alt="" className="h-3.5 w-3.5 object-contain" /> : <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />}
      </ListTile>
      <ListText title={title} sub={context.length ? context.map((c, i) => <span key={i}>{i > 0 && " · "}{c}</span>) : undefined} />
      {when && <ListMeta>{when}</ListMeta>}
    </>
  );
  if (href) return <a href={href} className={listRowClass}>{inner}</a>;
  if (onClick) return <button type="button" onClick={onClick} className={listRowClass}>{inner}</button>;
  return <div className={listRowClass}>{inner}</div>;
}
