// The sources behind a generated page, at the foot of it.
//
// A [7] in the prose is a promise that there is something to go and read. The document has
// carried its sources since citations shipped — useDocCitations numbers them, the markers
// render — but nothing drew the list, so every marker was a number that led nowhere.
//
// Deliberately the same shape as the agent's chat: a count you can collapse, then one
// numbered row per source saying what it is and when it happened. A reader who has seen one
// should not have to learn the other.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { SystemMark } from "@/components/SystemMark";
import { cn } from "@/lib/utils";
import type { DocSource } from "./api";

/** "2026-09-23" → "Sep 23, 2026". Undated sources simply say nothing. */
function when(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * What this source IS, in the fewest words that still tell two apart.
 *
 * The detail is the first line of whatever we ingested, which for a CRM note is often a
 * greeting — three rows reading "Hello All," are three rows nobody can tell apart. Where the
 * text carries nothing, the system name and the date do the work instead.
 */
function label(s: DocSource): string {
  const detail = (s.detail ?? "").replace(/\s+/g, " ").trim();
  const useless = !detail || detail.length < 12 || /^(hi|hello|hey|good morning|good afternoon)\b/i.test(detail);
  if (useless) {
    const kind = s.evidence_kind || s.system || "source";
    return detail ? `${kind} — ${detail}` : kind;
  }
  return detail.length > 110 ? `${detail.slice(0, 110)}…` : detail;
}

export function DocSources({ cited }: { cited: DocSource[] }) {
  // Open by default. The list is the evidence; hiding it behind a click by default treats
  // checking the work as the unusual thing to want.
  const [open, setOpen] = useState(true);
  const dated = cited.map(s => when(s.occurred_at)).filter(Boolean) as string[];

  return (
    <section className="mt-12 border-t border-border/60 pt-6">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <span>
          {cited.length} {cited.length === 1 ? "source" : "sources"}
          {dated.length ? ` · ${dated[0]}` : ""}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
      </button>

      {open && (
        <ol className="mt-3 divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
          {cited.map((s, i) => {
            const at = when(s.occurred_at);
            return (
              <li
                key={s.ref + i}
                id={`doc-source-${i + 1}`}
                className="flex items-center gap-2.5 px-3 py-2.5 target:bg-foreground/[0.06] scroll-mt-24">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[10.5px] font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <SystemMark system={s.system} className="h-4 w-4 shrink-0" />
                <span
                  className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85"
                  title={s.quote ?? label(s)}>
                  {label(s)}
                </span>
                {at && <span className="shrink-0 text-[11.5px] text-muted-foreground/70">{at}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
