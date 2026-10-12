// ONE derivation of "the sources behind this answer", read by everything that needs it.
//
// ⚠️ THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE. Over one day, the same mistake shipped four
// times: two places computing the source list independently and drifting apart.
//
//   · the agent numbered its citations while the panel numbered its rows — [1] on a sentence
//     about Sam's call opened "Meeting notes — Theo X Avery"
//   · the marker-count check counted every source while the panel grouped them, so 21 markers
//     survived over 3 rows
//   · the tooltip index built from all sources while the panel drew the filtered set, so a
//     marker rendered as "4" over a two-row panel and scrolled to nothing
//   · three note-taker handlers each wrote a different document key, so the one that was
//     forgotten left 32 transcripts unreachable
//
// None of those were hard bugs. Each was two correct functions that had to agree and had
// nothing forcing them to. So there is now exactly one place that decides what a source is,
// which rows exist, and in what order — and every consumer reads from it rather than
// recomputing. The grouping rule below is the only copy of that rule in the client.

import { useMemo } from "react";
import { citeKey } from "@/lib/citeKey";

export type CitationSource = {
  system: string;
  detail?: string;
  when?: string | null;
  ref?: string;
  quote?: string;
  speaker?: string;
  derived?: boolean;
};

export type CitationRow = {
  /** Identity of the underlying thing — the ref, or the closest stand-in when it has none. */
  key: string;
  ref: string | null;
  system: string;
  /** What the source is, from the tool that produced it — the fallback name before the
   *  detail endpoint has answered, and the only one for a source it cannot describe. */
  title: string | null;
  when: string | null;
  /** 1-based position, which is the number the reader sees and the marker resolves to. */
  index: number;
};

export type Citations = {
  rows: CitationRow[];
  /** Did the ANSWER point at anything? No markers, no panel. */
  cited: boolean;
  /** A cite token → its row number. What connects a marker to the row it opens. */
  indexOf: (token: string) => number | undefined;
  /** A row number → the source's system, for the marker's tooltip. */
  systemAt: (n: number) => string | undefined;
};

/**
 * @param content  the answer's text — where the cite tokens are.
 * @param sources  every source the turn's tool calls produced, in call order.
 */
export function useCitations(content: string, sources: CitationSource[]): Citations {
  return useMemo(() => {
    const tokens = new Set<string>();
    for (const m of (content ?? "").matchAll(/\[(c[a-z0-9]{4})\](?!\()/g)) tokens.add(m[1]);

    // One row per SOURCE DOCUMENT. Six facts from one call are one citation, because they are
    // one place to go and check. Keyed on the ref — the identity of the underlying thing —
    // falling back to system-plus-day, which is the closest a source without a pointer has.
    const seen = new Set<string>();
    const all: CitationRow[] = [];
    for (const s of sources) {
      const day = s.when ? String(s.when).slice(0, 10) : "undated";
      const key = s.ref ?? `${s.system}|${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ key, ref: s.ref ?? null, system: s.system, title: s.detail?.trim() || null, when: s.when ?? null, index: 0 });
    }

    // What the answer USED, not what the agent read on the way there. Two fallbacks keep it
    // honest rather than empty: a turn that cited nothing shows its working, and a turn whose
    // markers all failed to resolve does the same — claiming the answer rested on nothing
    // would be a different lie.
    const used = tokens.size
      ? all.filter(r => { const t = citeKey(r.ref); return t ? tokens.has(t) : false; })
      : [];
    const rows = (used.length ? used : all).map((r, i) => ({ ...r, index: i }));

    const byToken = new Map<string, number>();
    rows.forEach(r => { const t = citeKey(r.ref); if (t) byToken.set(t, r.index + 1); });

    return {
      rows,
      cited: tokens.size > 0 && rows.length > 0,
      indexOf: (token: string) => byToken.get(token),
      systemAt: (n: number) => rows[n - 1]?.system,
    };
  }, [content, sources]);
}
