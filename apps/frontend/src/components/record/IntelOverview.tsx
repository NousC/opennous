// The Intel tab (GET-805), one for the account, the person and the deal.
//
// CURRENT STATE on top: for each category that decides a deal, the newest claim as one line, its
// date, and what it replaced when it replaced something ("was two to three months · 4 weeks ago").
// Below, a BOARD in three columns by meaning: Headwinds (blockers, objections, risks, competitors,
// pains), Tailwinds (buying signals, budget, timeline, goals, stakeholders) and About (tech stack,
// status quo and the rest). Each category is a small label over its claims, newest first, each claim
// a tag in the category's colour; hover a tag for the claim (fact, quote, who, source).
//
// It reads FACTS, not the topic grouping: a topic takes one kind, so 29 tech-stack facts on one
// account were swallowed into topics of other kinds and the category vanished. A fact heard twice
// (the same short label in one category) shows once, the newest.
import { useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { ListCard } from "@/components/ui/list";
import { day, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fallbackLabel } from "@/components/mind/ClaimTag";
import type { Note } from "./RecordParts";
import { ClaimHoverTag } from "./ClaimHoverTag";
import { INTEL_CAT, INTEL_CATS, intelCatOf, type IntelColumn } from "./intelLook";
import { useIntelStory } from "./IntelStory";

const ts = (iso?: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };
const titleOf = (n: Note) => (n.label?.trim()
  || (String(n.category ?? "").toLowerCase() === "competitor" && typeof n.metadata?.entity === "string" ? n.metadata.entity : null)
  || fallbackLabel(n.content || "", n.category));

/** How many claims the view shows: one per short label in each category (the Intel tab's count). */
export function intelCountOf(facts: Note[]): number {
  return new Set(facts.map(n => `${intelCatOf(n.category)}|${titleOf(n).toLowerCase()}`)).size;
}

/** The categories Current state shows, in its order: the ones a deal turns on. */
const STATE_ORDER = ["timeline", "buying", "blockers", "objections", "budget", "competitors", "people", "stack"];
const COLUMNS: { key: IntelColumn; title: string }[] = [
  { key: "headwinds", title: "Headwinds" },
  { key: "tailwinds", title: "Tailwinds" },
  { key: "context", title: "About" },
];
const SHOWN = 4;

export function IntelOverview({ facts, nameOf, companyId, empty, scope }: {
  facts: Note[];
  /** A contact id → their name, for "who said it". */
  nameOf: (id: string) => string | null;
  /** The account, for what a replaced claim used to say (its timeline keeps retired facts). */
  companyId?: string | null;
  empty?: string;
  /** This deal / Whole account, on a deal. */
  scope?: ReactNode;
}) {
  const [all, setAll] = useState<Set<string>>(new Set());
  const story = useIntelStory(companyId, "all");
  const retired = useMemo(() => new Map((story.data?.facts ?? []).map(f => [f.id, f])), [story.data]);

  // Facts by category, newest first, one per short label.
  const byCat = useMemo(() => {
    const m = new Map<string, Note[]>();
    const sorted = [...facts].sort((a, b) => ts(b.created_at) - ts(a.created_at));
    const seen = new Set<string>();
    for (const n of sorted) {
      const cat = intelCatOf(n.category);
      const key = `${cat}|${titleOf(n).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat)!.push(n);
    }
    return m;
  }, [facts]);

  const who = (n: Note) => {
    const id = n.metadata?.voiced_by_contact_id;
    return (typeof id === "string" && nameOf(id)) || (typeof n.metadata?.speaker === "string" ? n.metadata.speaker : null);
  };
  const wasOf = (n: Note) => {
    const prev = n.metadata?.supersedes;
    const f = typeof prev === "string" ? retired.get(prev) : undefined;
    return f ? { text: f.label?.trim() || fallbackLabel(f.content, f.category), at: f.said_at } : null;
  };

  const state = STATE_ORDER.map(k => {
    const list = byCat.get(k);
    if (!list?.length) return null;
    const n = list[0];
    const title = k === "stack" ? list.slice(0, 4).map(titleOf).join(" · ") : titleOf(n);
    return { cat: INTEL_CAT[k], n, title, tags: k === "stack" ? list.slice(0, 4) : [n], was: k === "stack" ? null : wasOf(n) };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  // With nothing to show, the deal's scope switch still has to be reachable.
  if (!facts.length) return (
    <div className="min-w-0 space-y-3">
      {scope && <div className="flex justify-end">{scope}</div>}
      <EmptyState title={empty ?? "No intel yet"} />
    </div>
  );

  return (
    <div className="min-w-0 space-y-4">
      {/* Current state: the Deal health card's language, one cell per deciding category. */}
      {state.length > 0 && (
        <ListCard className="min-w-0">
          <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 pb-1 pt-0.5">
            <span className="text-[13px] font-medium text-foreground">Current state</span>
            <span className="flex-1" />
            {scope}
          </div>
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2 xl:grid-cols-4">
            {state.map(s => (
              <div key={s.cat.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2.5">
                {/* The board's language (GET-806): the category in plain words, the claim as its tag. */}
                <span className="text-[12px] font-medium text-muted-foreground">{s.cat.one}</span>
                <span className="flex flex-wrap gap-1.5">
                  {s.tags.map(t => <ClaimHoverTag key={t.id} text={titleOf(t)} color={s.cat.color} kind={s.cat.one} note={t} who={who(t)} />)}
                </span>
                <span className="text-[11.5px] text-muted-foreground/60">{when(s.n.created_at)}</span>
                {s.was && (
                  <span className="text-[11.5px] leading-snug text-muted-foreground/60">
                    was <span className="line-through">{s.was.text}</span> · {day(s.was.at)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </ListCard>
      )}

      {/* The board: three columns by meaning, each category a quiet label over its claim tags. */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {COLUMNS.map(col => {
          const cats = INTEL_CATS.filter(c => c.column === col.key && byCat.get(c.key)?.length);
          if (!cats.length) return null;
          const total = cats.reduce((n, c) => n + (byCat.get(c.key)?.length ?? 0), 0);
          return (
            <ListCard key={col.key} className="min-w-0">
              <div className="flex items-baseline gap-2 px-2 pb-2 pt-0.5">
                <span className="text-[13px] font-medium text-foreground">{col.title}</span>
                <span className="text-[12px] tabular-nums text-muted-foreground/50">{total}</span>
              </div>
              <div className="space-y-3.5 px-2 pb-1.5">
                {cats.map(c => {
                  const list = byCat.get(c.key)!;
                  const open = all.has(c.key);
                  const shown = open ? list : list.slice(0, SHOWN);
                  return (
                    <div key={c.key} className="min-w-0">
                      <div className="mb-1.5 flex items-baseline gap-1.5">
                        <span className="text-[12px] font-medium text-muted-foreground">{c.label}</span>
                        <span className="text-[11.5px] tabular-nums text-muted-foreground/45">{list.length}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {shown.map(n => (
                          <ClaimHoverTag key={n.id} text={titleOf(n)} color={c.color} kind={c.one} note={n} who={who(n)} />
                        ))}
                        {list.length > SHOWN && (
                          <button type="button" onClick={() => setAll(s => { const x = new Set(s); if (open) x.delete(c.key); else x.add(c.key); return x; })}
                            className={cn("inline-flex h-6 items-center px-1 text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground")}>
                            {open ? "Show less" : `+${list.length - SHOWN} more`}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ListCard>
          );
        })}
      </div>
    </div>
  );
}
