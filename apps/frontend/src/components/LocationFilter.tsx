import { useEffect, useRef, useState } from "react";
import { MapPin, Check } from "lucide-react";

// The market a list is showing, as an icon beside the search box (GET-312).
//
// One control, used by Accounts and People, because they filter the same thing: a person is in the
// market their employer is in. It is an icon while nothing is filtered, and grows a label when a
// country is applied — a filter you cannot see is a filter that makes a list look broken.
//
// The chosen country is remembered by the page, per workspace, so a reload keeps it. `applied` is
// what the SERVER filtered by, not what the user last clicked: before anyone touches it the
// workspace's own focus is in force (a workspace can open on its home market), and the control has to say so.

export interface LocationOption { country: string; accounts: number }

export function LocationFilter({
  applied, options, onChange, className = "", quiet = false,
}: {
  applied: string | null;
  options: LocationOption[];
  onChange: (value: string) => void;
  className?: string;
  /** The interface refresh's quiet toolbar button ("Location", or the country once applied). */
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Click-away and Escape both close it; a menu you can only close by choosing something is a trap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!options.length) return null;

  return (
    <div ref={box} className={`relative flex-shrink-0 ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        title={applied ? `Showing ${applied} — click to change location` : "Filter by location"}
        aria-label="Filter by location"
        className={quiet
          ? `inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover ${open ? "bg-muted" : ""}`
          : `inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${
          applied
            ? "border-foreground/20 bg-foreground/[0.06] text-foreground"
            : "border-border/70 bg-muted/40 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60"
        }`}
      >
        {!quiet && <MapPin className="h-3.5 w-3.5" />}
        {quiet ? <span className="max-w-[140px] truncate">{applied ?? "Location"}</span>
          : applied && <span className="max-w-[120px] truncate">{applied}</span>}
      </button>

      {open && (
        <div className={quiet
          ? "absolute right-0 z-50 mt-1 w-60 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-pop"
          : "absolute right-0 z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-lg"}>
          {quiet
            ? <div className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">Location</div>
            : <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">Location</div>}
          <Row quiet={quiet} label="All locations" active={!applied} onClick={() => { onChange("all"); setOpen(false); }} />
          {options.map(o => (
            <Row
              quiet={quiet}
              key={o.country}
              label={o.country}
              count={o.accounts}
              active={applied === o.country}
              onClick={() => { onChange(o.country); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, count, active, onClick, quiet }: { label: string; count?: number; active: boolean; onClick: () => void; quiet?: boolean }) {
  return (
    <button onClick={onClick}
      className={quiet
        ? "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-fast hover:bg-hover"
        : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground/80 hover:bg-muted/50"}>
      <Check className={`h-3.5 w-3.5 flex-shrink-0 ${active ? "text-foreground" : "opacity-0"}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="flex-shrink-0 tabular-nums text-[12px] text-muted-foreground/60">{count.toLocaleString()}</span>}
    </button>
  );
}
