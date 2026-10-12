// Sources on the record pages (interface refresh, GET-612). Every AI statement on an account or a
// deal — the overview, an intel fact, a health reason — says where it came from, and a click opens
// the call or the email itself in the SourceDock beside the record, on the line that was quoted.
//
// Built on the chat's own pieces, not a copy of them: a fact becomes a CitationSource (its
// source_ref, quote, speaker, date) and useCitations groups them into one row per source document,
// the rule that numbers the chat's citations. SourceDock is the chat's raw viewer, unchanged.
//
// Only the record pages use this so far; other pages adopt it later.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useCitations, type CitationRow, type CitationSource } from "@/hooks/useCitations";
import { SourceDock, type SourceRef } from "@/components/SourceDock";
import { day } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Note } from "./RecordParts";

type Open = (source: SourceRef, quote?: string | null) => void;
const DockContext = createContext<Open | null>(null);

/** The record's source dock: children get `useOpenSource()`, the dock sits to their right. */
export function SourceDockHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ source: SourceRef; quote?: string | null } | null>(null);
  const openSource = useCallback<Open>((source, quote) => {
    setOpen(cur => (cur?.source.ref === source.ref && cur?.quote === quote ? null : { source, quote }));
  }, []);
  return (
    <DockContext.Provider value={openSource}>
      <div className="flex h-full min-w-0">
        <div className="min-w-0 flex-1">{children}</div>
        {open && (
          // Beside the record from md up; over it, full width, on a phone.
          <div className="fixed inset-0 z-50 flex justify-end bg-black/20 md:static md:z-auto md:bg-transparent [&>aside]:max-w-full">
            <SourceDock source={open.source} quote={open.quote} onClose={() => setOpen(null)} />
          </div>
        )}
      </div>
    </DockContext.Provider>
  );
}

export const useOpenSource = () => useContext(DockContext);

const SYSTEM: Record<string, string> = {
  fireflies: "Fireflies", fellow: "Fellow", fathom: "Fathom", granola: "Granola", gong: "Gong", zoom: "Zoom",
  gmail: "Gmail", outlook: "Outlook", hubspot: "HubSpot", linkedin: "LinkedIn", slack: "Slack", agent: "Nous",
};

/** Which tool a source ref points into: "source://fireflies/…" → Fireflies, a URL → its host. */
export function systemOf(ref: string): string {
  const m = /^source:\/\/([^/]+)\//.exec(ref);
  if (m) return SYSTEM[m[1]] ?? m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const host = /^https?:\/\/(?:www\.)?([^/]+)/.exec(ref)?.[1];
  return host ?? "Source";
}

/** A fact as a citation source: its source ref, the line it rests on, who said it, when. */
export function factSource(n: Note): CitationSource | null {
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  const ref = typeof m.source_ref === "string" ? m.source_ref : typeof m.source_url === "string" ? m.source_url : null;
  if (!ref) return null;
  const t = String(m.signal_type ?? "");
  const kind = /meeting|call/.test(t) ? "Call" : /email/.test(t) ? "Email" : /linkedin/.test(t) ? "LinkedIn message" : null;
  return {
    system: systemOf(ref),
    detail: (typeof m.title === "string" && m.title) || [kind, n.created_at ? day(n.created_at) : null].filter(Boolean).join(" · ") || undefined,
    when: n.created_at ?? null,
    ref,
    quote: typeof m.quote === "string" ? m.quote : undefined,
    speaker: typeof m.speaker === "string" ? m.speaker : undefined,
  };
}

/** The distinct source documents behind a set of facts, one row each, in useCitations' order. */
export function useFactCitations(notes: Note[]) {
  const sources = useMemo(() => notes.map(factSource).filter((s): s is CitationSource => !!s), [notes]);
  const { rows } = useCitations("", sources);
  // The line to open each source on: the first quote any fact took from it.
  const quoteOf = useCallback((ref: string | null) => (ref ? sources.find(s => s.ref === ref && s.quote)?.quote ?? null : null), [sources]);
  return { rows, quoteOf };
}

/**
 * One source as a small chip: the tool and what it was ("Fireflies · Call · 15 Sep"), or just a
 * number when `index` is given. Opens the source in the dock, on the quoted line.
 */
export function CitationChip({ row, quote, index, num, className }: { row: CitationRow; quote?: string | null; index?: number; num?: number; className?: string }) {
  const open = useOpenSource();
  const label = row.title ? `${row.system} · ${row.title}` : row.system;
  const can = !!open && !!row.ref;
  return (
    <button type="button" disabled={!can} title={can ? `Open ${label}` : label}
      aria-label={index != null ? `Source ${index}: ${label}` : `Open ${label}`}
      onClick={e => { e.stopPropagation(); if (can) open!({ ref: row.ref!, title: row.title ?? row.system, system: row.system }, quote ?? null); }}
      className={cn("inline-flex h-[18px] max-w-full flex-shrink-0 items-center rounded-[5px] px-1.5 align-[1px] text-[11px] tabular-nums text-muted-foreground/80 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)] transition-colors duration-fast",
        can && "hover:bg-hover hover:text-foreground", index != null && "min-w-[18px] justify-center px-1", className)}>
      {num != null && <span className="mr-1 text-muted-foreground/50">{num}</span>}
      <span className="truncate">{index != null ? index : label}</span>
    </button>
  );
}

/** "Sources" and a chip per source document behind `notes`; nothing when none is known. */
export function SourceLine({ notes, max = 3, label = "Sources", numbered = false, className }: { notes: Note[]; max?: number; label?: string; numbered?: boolean; className?: string }) {
  const { rows, quoteOf } = useFactCitations(notes);
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, max);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground/60", className)}>
      <span>{label}</span>
      {shown.map(r => <CitationChip key={r.key} row={r} quote={quoteOf(r.ref)} num={numbered ? r.index + 1 : undefined} />)}
      {rows.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="tabular-nums transition-colors duration-fast hover:text-foreground">+{rows.length - shown.length}</button>
      )}
    </div>
  );
}

/** One fact's own source as a numbered chip, numbered against `rows` (a statement's citations). */
export function FactCite({ note, rows }: { note: Note; rows: CitationRow[] }) {
  const s = factSource(note);
  if (!s) return null;
  const row = rows.find(r => r.ref === s.ref);
  if (!row) return null;
  return <CitationChip row={row} quote={s.quote ?? null} index={row.index + 1} className="ml-1" />;
}

/** One fact's source as a "Open the call" style link, for the Intel tab's "What was said". */
export function FactSourceLink({ note }: { note: Note }) {
  const open = useOpenSource();
  const s = factSource(note);
  if (!s || !open) return null;
  const what = /^Call/.test(s.detail ?? "") ? "Open the call" : /^Email/.test(s.detail ?? "") ? "Open the email" : `Open in ${s.system}`;
  return (
    <button type="button" onClick={e => { e.stopPropagation(); open({ ref: s.ref!, title: s.detail ?? s.system, system: s.system }, s.quote ?? null); }}
      className="text-muted-foreground/80 underline decoration-border underline-offset-2 transition-colors duration-fast hover:text-foreground">
      {what}
    </button>
  );
}
