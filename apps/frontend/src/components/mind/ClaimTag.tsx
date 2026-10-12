// ClaimTag — one extracted claim rendered as a compact chip whose label names the
// substance ("Pearl Lantern", "Stale Apollo data"), and which opens the FULL claim on
// click: the whole sentence plus its provenance (when it was heard, on which channel,
// who voiced it, how confident we are).
//
// Shared by the company record (objection/competitor/pain/goal chips) and the person
// Intel tab, so a claim reads and expands identically everywhere. The popover is
// position:fixed and anchored to the chip so it never gets clipped by a scrolling panel.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ClaimNote = {
  id: string;
  label?: string | null;
  category?: string | null;
  content?: string | null;
  source?: string | null;
  confidence?: number | null;
  created_at?: string | null;
  metadata?: Record<string, any> | null;
};

// Per-category chip color. Muted by default; the popover header uses the same hue.
const CAT_COLOR: Record<string, { bg: string; text: string; dot: string }> = {
  objection:     { bg: "bg-red-500/10",     text: "text-red-600 dark:text-red-400",       dot: "#ef4444" },
  competitor:    { bg: "bg-violet-500/10",  text: "text-violet-600 dark:text-violet-400", dot: "#8b5cf6" },
  pain:          { bg: "bg-orange-500/10",  text: "text-orange-600 dark:text-orange-400", dot: "#f97316" },
  goal:          { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", dot: "#10b981" },
  budget:        { bg: "bg-sky-500/10",     text: "text-sky-600 dark:text-sky-400",       dot: "#0ea5e9" },
  timeline:      { bg: "bg-amber-500/10",   text: "text-amber-600 dark:text-amber-400",   dot: "#f59e0b" },
  buying_signal: { bg: "bg-green-500/10",   text: "text-green-600 dark:text-green-400",   dot: "#22c55e" },
  authority:     { bg: "bg-indigo-500/10",  text: "text-indigo-600 dark:text-indigo-400", dot: "#6366f1" },
  preference:    { bg: "bg-teal-500/10",    text: "text-teal-600 dark:text-teal-400",     dot: "#14b8a6" },
  relationship:  { bg: "bg-pink-500/10",    text: "text-pink-600 dark:text-pink-400",     dot: "#ec4899" },
  status_quo:    { bg: "bg-slate-500/10",   text: "text-slate-600 dark:text-slate-400",   dot: "#64748b" },
  discovery:     { bg: "bg-cyan-500/10",    text: "text-cyan-600 dark:text-cyan-400",     dot: "#06b6d4" },
  // The four promoted in GET-327 never got colours and have rendered grey ever since; the last two
  // came with GET-372/373. A category the eye cannot separate on a card is one a rep never learns.
  adoption:      { bg: "bg-lime-500/10",    text: "text-lime-600 dark:text-lime-400",     dot: "#84cc16" },
  proficiency:   { bg: "bg-fuchsia-500/10", text: "text-fuchsia-600 dark:text-fuchsia-400", dot: "#d946ef" },
  seasonality:   { bg: "bg-yellow-500/10",  text: "text-yellow-600 dark:text-yellow-400", dot: "#eab308" },
  staff_change:  { bg: "bg-rose-500/10",    text: "text-rose-600 dark:text-rose-400",     dot: "#f43f5e" },
  firmographic:  { bg: "bg-stone-500/10",   text: "text-stone-600 dark:text-stone-400",   dot: "#78716c" },
  performance:   { bg: "bg-blue-500/10",    text: "text-blue-600 dark:text-blue-400",     dot: "#3b82f6" },
  // The two CS categories (GET-401). Expansion sits next to buying_signal's green on purpose —
  // same shape of good news, different account; risk is the red that objection is not (an
  // objection is a prospect's reason not to start, a risk is a customer's reason to stop).
  expansion_signal: { bg: "bg-green-500/10", text: "text-green-700 dark:text-green-300", dot: "#16a34a" },
  risk_signal:      { bg: "bg-red-500/10",   text: "text-red-700 dark:text-red-300",     dot: "#dc2626" },
  // GET-776.
  blocker:          { bg: "bg-orange-600/10", text: "text-orange-700 dark:text-orange-300", dot: "#c2410c" },
  requirement:      { bg: "bg-indigo-600/10", text: "text-indigo-700 dark:text-indigo-300", dot: "#4338ca" },
  tech_stack:       { bg: "bg-cyan-600/10",   text: "text-cyan-700 dark:text-cyan-300",     dot: "#0e7490" },
};
const DEFAULT_COLOR = { bg: "bg-muted", text: "text-foreground/80", dot: "#9ca3af" };
const catColor = (c?: string | null) => CAT_COLOR[(c || "").toLowerCase()] ?? DEFAULT_COLOR;

const CAT_LABEL: Record<string, string> = {
  objection: "Objection", competitor: "Competitor", pain: "Pain", goal: "Goal",
  budget: "Budget", timeline: "Timeline", buying_signal: "Buying signal",
  authority: "Authority", preference: "Preference", relationship: "Connection",
  status_quo: "Status quo", discovery: "Discovery", general: "Note",
  adoption: "Adoption", proficiency: "Proficiency", seasonality: "Seasonality",
  staff_change: "Staff change", firmographic: "Business profile", performance: "Performance",
  expansion_signal: "Expansion signal", risk_signal: "Risk signal",
  blocker: "Blocker", requirement: "Requirement", tech_stack: "Tech stack",
};
const catLabel = (c?: string | null) =>
  CAT_LABEL[(c || "").toLowerCase()] ?? (c ? c.replace(/_/g, " ") : "Note");

// Which channel the claim came from — for the "heard on a call / over email" line.
const CHANNEL: Record<string, string> = {
  meeting_held: "on a call", meeting: "on a call",
  email_received: "over email", email_sent: "over email", email: "over email",
  linkedin_message: "over LinkedIn", linkedin: "over LinkedIn",
};

// Fallback label when the claim has no stored one (old rows). Category-aware: pull a
// brand for competitors, else the first few meaningful words — better than nothing, and
// every new claim ships with a real label so this only bites the backlog.
export function fallbackLabel(content: string, category?: string | null): string {
  // Drop a leading "First Last " so a claim that opens with the speaker's name doesn't
  // turn the tag INTO their name — the substance is what follows.
  const body = (content || "").trim().replace(/^[A-Z][a-z]+\s+[A-Z][a-z'’-]+\s+/, "");
  if ((category || "").toLowerCase() === "competitor") {
    // A capitalized brand from the body (after the leading name is stripped).
    const m = body.match(/(?:with|against|versus|vs\.?|using|like|competitor|alternative(?: to)?|from)\s+([A-Z][A-Za-z0-9.&-]{2,}(?:\s+[A-Z][A-Za-z0-9.&-]{2,})?)/);
    if (m) return m[1].slice(0, 24);
    const caps = body.match(/\b[A-Z][A-Za-z0-9.&-]{2,}(?:\s+[A-Z][A-Za-z0-9.&-]{2,})?/g);
    if (caps && caps[0]) return caps[0].slice(0, 24);
  }
  const stop = new Set(["the","a","an","to","of","for","and","is","are","was","were","with","that","their","they","he","she","it","has","have","will","about","emphasized","cited","stated","mentioned","noted","flagged","identified","specified","wants","plans"]);
  const words = body.split(/\s+/).filter(w => w && !stop.has(w.toLowerCase()));
  const out = words.slice(0, 3).join(" ");
  return (out || body.split(/\s+/).slice(0, 3).join(" ") || "—").slice(0, 28);
}

function whenPhrase(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ClaimTag({ note, voicedBy }: { note: ClaimNote; voicedBy?: string | null }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // A DECLINED expansion is not an opening (GET-417). The taxonomy files "they said no to more
  // product" under expansion_signal with stance "declined" on purpose — it suppresses that product
  // for a year and never raises standing — but the chip was the same green as an ask, so the
  // Intel tab read "Customer declined Lumen ID" as good news. Stance decides the colour and the
  // label prefix; the category stays what the model said.
  const stance = String((note.metadata as { stance?: string } | undefined)?.stance ?? "").toLowerCase();
  const declined = (note.category || "").toLowerCase() === "expansion_signal" && stance === "declined";
  const considering = (note.category || "").toLowerCase() === "expansion_signal" && stance === "considering";
  const color = declined
    ? { bg: "bg-zinc-500/10", text: "text-zinc-600 dark:text-zinc-400", dot: "#71717a" }
    : considering ? { bg: "bg-amber-500/10", text: "text-amber-700 dark:text-amber-300", dot: "#d97706" }
    : catColor(note.category);
  const baseLabel = (note.label && note.label.trim()) || fallbackLabel(note.content || "", note.category);
  const label = declined ? `Declined · ${baseLabel}` : baseLabel;
  const headline = declined ? "Declined expansion" : considering ? "Considering expansion" : catLabel(note.category);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 340) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  const channel = CHANNEL[(note.metadata?.signal_type as string) || ""] || null;
  const when = whenPhrase(note.created_at);
  const conf = typeof note.confidence === "number" && note.confidence < 1
    ? `${Math.round(note.confidence * 100)}% confidence` : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        title="Click to see the full claim"
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-medium max-w-[190px] transition-colors hover:brightness-95 ${color.bg} ${color.text}`}
      >
        <span className="truncate">{label}</span>
      </button>

      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[71] w-[320px] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl p-3.5"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <span className="h-2 w-2 rounded-full" style={{ background: color.dot }} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{headline}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-foreground">{note.content || "—"}</p>
            {(when || channel || voicedBy || conf) && (
              <div className="mt-2.5 pt-2.5 border-t border-border/60 flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground/70">
                {voicedBy && <span>Voiced by {voicedBy}</span>}
                {(when || channel) && <span>{[channel, when].filter(Boolean).join(" · ")}</span>}
                {conf && <span>· {conf}</span>}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// A topic: every fact on the record about one subject ("Data Residency"), as ONE chip. The popover says
// where the topic stands now, then lists each distinct fact once — a fact heard on three calls is
// one line marked ×3, not three chips. Same chip and popover as a single claim, so the tab reads
// the way it always did, with less on it.
export type IntelTopicChip = { label: string; kind: string; summary: string | null; facts: ClaimNote[][] };

export function TopicTag({ topic, voicedBy }: { topic: IntelTopicChip; voicedBy?: (id?: string | null) => string | null }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const color = catColor(topic.kind);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 380), left: Math.min(r.left, window.innerWidth - 380) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  const count = topic.facts.length;
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-medium max-w-[240px] transition-colors hover:brightness-95 ${color.bg} ${color.text}`}
      >
        <span className="truncate">{topic.label}</span>
        {count > 1 && <span className="tabular-nums opacity-60">{count}</span>}
      </button>

      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[71] w-[360px] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl p-3.5"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <span className="h-2 w-2 rounded-full" style={{ background: color.dot }} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{catLabel(topic.kind)}</span>
            </div>
            <p className="text-[13.5px] font-medium leading-snug text-foreground">{topic.label}</p>
            {topic.summary && <p className="mt-1 text-[13px] leading-relaxed text-foreground/80">{topic.summary}</p>}
            <ul className="mt-3 max-h-[260px] space-y-2.5 overflow-y-auto border-t border-border/60 pt-3">
              {topic.facts.map(group => {
                const f = group[0];
                const who = voicedBy?.(f.metadata?.voiced_by_contact_id);
                const channel = CHANNEL[(f.metadata?.signal_type as string) || ""] || null;
                const meta = [
                  group.length > 1 ? `Heard ${group.length}×` : null,
                  who ? `Voiced by ${who}` : null,
                  [channel, whenPhrase(group[0].created_at)].filter(Boolean).join(" · ") || null,
                ].filter(Boolean).join(" · ");
                return (
                  <li key={f.id}>
                    <p className="text-[12.5px] leading-relaxed text-foreground">{f.content || "—"}</p>
                    {meta && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{meta}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
