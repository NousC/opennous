// The raw itself, open beside the conversation.
//
// The citation panel says WHERE something came from. This is the last rung: the call, in
// full, in the same place a document opens — so checking a line never means leaving the
// product for a fifty-minute recording and scrolling.
//
// A transcript is not a document and must not be rendered like one. It is hundreds of short
// turns with a speaker on each, and the reader arrives looking for ONE of them. So the
// speaker sits in a left rail the eye can run down, and the line you came for is lifted out
// of the page rather than highlighted in a colour — a marker pen over one line reads as
// somebody's annotation; this is the product saying "this is the bit that was cited".

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, Search } from "lucide-react";
import { format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { useDockWidth } from "@/hooks/useDockWidth";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type SourceRef = { ref: string; title: string; system: string };

type Loaded = {
  kind: string;
  title: string | null;
  system: string;
  date: string | null;
  who?: string | null;
  content: string;
};

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** `Speaker: line` → rows. A line with no speaker keeps the previous one, because a wrapped
 *  turn is still that person talking. */
function parseTranscript(content: string) {
  const rows: { who: string | null; text: string }[] = [];
  let last: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:]{2,60}):\s*(.*)$/.exec(line);
    if (m) { last = m[1].trim(); rows.push({ who: last, text: m[2].trim() }); }
    else rows.push({ who: last, text: line });
  }
  return rows;
}

export function SourceDock({ source, quote, onClose }: {
  source: SourceRef;
  /** The line that was cited, so the viewer opens ON it instead of at the top. */
  quote?: string | null;
  onClose: () => void;
}) {
  const { session, userData } = useAuth();
  // The same grab edge and bounds the report dock uses, so the two feel identical.
  const { width, gripProps } = useDockWidth();
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const hitRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const token = session?.access_token;
    const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;
    if (!token || !workspaceId) return;
    let alive = true;
    setDoc(null);
    setError(null);
    fetch(`${apiUrl}/api/evidence/source`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, ref: source.ref }),
    })
      .then(async r => (r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})))))
      .then(d => { if (alive) setDoc(d); })
      .catch(e => { if (alive) setError(e?.message ?? "This source could not be opened."); });
    return () => { alive = false; };
  }, [source.ref, session?.access_token, userData]);

  const rows = useMemo(() => (doc?.content ? parseTranscript(doc.content) : []), [doc]);

  // Which line was cited, and which match the reader's own search. Both are derived here so
  // the highlight and the scroll target can never disagree about the same row.
  const { citedAt, matches } = useMemo(() => {
    const q = quote ? norm(quote) : "";
    const f = norm(find);
    let cited = -1;
    const hits = new Set<number>();
    rows.forEach((r, i) => {
      const t = norm(r.text);
      if (cited < 0 && q.length >= 12 && (t.includes(q) || q.includes(t.slice(0, 80)))) cited = i;
      if (f.length >= 2 && t.includes(f)) hits.add(i);
    });
    return { citedAt: cited, matches: hits };
  }, [rows, quote, find]);

  // Open ON the cited line. Arriving at the top of a fifty-minute call and being told the
  // quote is "in there" is the trip out to Fireflies this viewer exists to replace.
  useEffect(() => {
    if (citedAt < 0 || !hitRef.current) return;
    hitRef.current.scrollIntoView({ block: "center" });
  }, [citedAt, doc]);

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-border/70 bg-background"
      style={{ width }}
    >
      <div {...gripProps} />
      <header className="flex items-start gap-2.5 px-4 pb-2 pt-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-medium text-foreground">{doc?.title ?? source.title}</h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground/70">
            {doc?.system ?? source.system}
            {doc?.date && ` · ${format(new Date(doc.date), "d MMM yyyy")}`}
            {rows.length > 0 && ` · ${rows.length} lines`}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-hover hover:text-foreground transition-colors">
          <X className="h-4 w-4" />
        </button>
      </header>

      {rows.length > 6 && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <input
            value={find}
            onChange={e => setFind(e.target.value)}
            placeholder="Find in this call"
            className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {find && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground/70">
              {matches.size} {matches.size === 1 ? "line" : "lines"}
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!doc && !error && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground/70">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading
          </div>
        )}
        {error && <p className="max-w-[52ch] text-[13px] leading-[1.55] text-muted-foreground">{error}</p>}

        {rows.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {rows.map((r, i) => (
              <div
                key={i}
                ref={i === citedAt ? hitRef : undefined}
                className={`flex gap-3 rounded-lg px-2 py-1.5 ${
                  i === citedAt
                    ? "bg-hover text-foreground"
                    : matches.has(i)
                      ? "bg-amber-500/10 text-foreground"
                      : "text-foreground/75"
                }`}>
                <span className="w-[96px] shrink-0 truncate text-[11.5px] leading-[1.6] text-muted-foreground/60">
                  {/* Only when the speaker CHANGES. Repeating a name down forty consecutive
                      lines is noise the eye has to filter out of every one of them. */}
                  {r.who && r.who !== rows[i - 1]?.who ? r.who : ""}
                </span>
                <span className="min-w-0 text-[13px] leading-[1.55]">{r.text}</span>
              </div>
            ))}
          </div>
        ) : doc?.content ? (
          // Not a transcript — an email body, a message. Rendered as what it is.
          <p className="whitespace-pre-wrap text-[13px] leading-[1.65] text-foreground/90">{doc.content}</p>
        ) : null}
      </div>
    </aside>
  );
}
