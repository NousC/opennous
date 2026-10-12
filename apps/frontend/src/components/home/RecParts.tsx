// The pieces of one recommendation's page (/home/:id, GET-478), shared with the Priorities inbox
// (GET-678), which shows the same item in its right-hand pane: the detail's shape, the property
// rows, a handoff brief read in place, and how a source and an amount are said.
import { format } from "date-fns";
import type { Recommendation } from "@/components/home/types";

export type RecDetailFull = Recommendation & {
  status: string; decided_at: string | null; why_now: string | null; person_name: string | null;
  impact: { deal: string | null; value: number | string | null; stage: string | null; close_date: string | null } | null;
  sources: { kind: string; when: string; system: string | null; title: string | null; ref: string | null }[];
  move: string | null; ready: "draft_email" | "brief" | "document" | null; auto_draft?: boolean;
  /** A handoff's account brief, as the automation wrote it. */
  brief?: { document_id: string; written_at: string; sections: { label: string; body: string }[] } | null;
};
export const SOURCE_LABEL: Record<string, string> = {
  meeting_held: "Meeting", meeting_scheduled: "Meeting scheduled", email_received: "Email received", email_sent: "Email sent",
  email_reply: "Email reply", linkedin_message_received: "LinkedIn message", linkedin_message_sent: "LinkedIn message sent", call: "Call",
};
export const money = (v: number | string | null) => { const n = Number(v); return v == null || !isFinite(n) || !n ? null : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }); };

/** What is at stake, in one line: "$48,000 · Evaluation · closes Oct 22". Empty with no open deal. */
export function impactLine(impact: RecDetailFull["impact"]): string {
  if (!impact) return "";
  return [money(impact.value), impact.stage, impact.close_date ? `closes ${format(new Date(impact.close_date), "MMM d")}` : null].filter(Boolean).join(" · ");
}

/** A meeting brief is prepared in chat: the hand-off the chat page takes. */
export const prepBriefHref = (rec: Pick<RecDetailFull, "person_name" | "account">) =>
  `/?ask=${encodeURIComponent(`Prep me for my meeting with ${rec.person_name || rec.account.name || "them"}`)}&autosend=1`;

/** A handoff brief, read in place: each section a quiet heading over plain text and bullets.
 *  The citation tokens are for the document view, where they open a source; here they are noise. */
export function Brief({ sections }: { sections: { label: string; body: string }[] }) {
  const clean = (t: string) => t.replace(/\s*\[c[0-9a-z]{4}\]/g, "").replace(/\*\*/g, "").trim();
  return (
    <div className="space-y-5 border-t border-border/60 pt-5">
      {sections.map((s, i) => {
        const lines = s.body.split("\n").map((l) => l.trim()).filter(Boolean);
        const blocks: { list: boolean; items: string[] }[] = [];
        for (const l of lines) {
          const m = /^(?:[-·*]|\d+[.)])\s+(.*)$/.exec(l);
          const list = Boolean(m);
          const text = clean(m ? m[1] : l);
          if (!text) continue;
          const last = blocks[blocks.length - 1];
          if (last && last.list === list && list) last.items.push(text);
          else blocks.push({ list, items: [text] });
        }
        return (
          <section key={i}>
            {s.label && <h2 className="section-title mb-1.5">{s.label}</h2>}
            <div className="space-y-2">
              {blocks.map((b, j) => b.list ? (
                <ul key={j} className="list-disc space-y-1 pl-4 marker:text-muted-foreground/40">
                  {b.items.map((t, k) => <li key={k} className="text-[13.5px] leading-relaxed text-foreground/85">{t}</li>)}
                </ul>
              ) : (
                <p key={j} className="text-[13.5px] leading-relaxed text-foreground/85">{b.items[0]}</p>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}
