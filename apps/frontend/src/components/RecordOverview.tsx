// The Overview — the first thing you see on any account, wherever you opened it from.
//
// Every other tab is a CHANNEL: emails, LinkedIn, Slack, calls. Each answers "what
// happened over here". None answers the question you actually arrive with, which is "who
// is this, and is this account alive". So Overview goes first and answers exactly that:
//
//   left    the whole record, editable in place. Not a summary of the record with the
//           real one hiding in a rail — the record.
//   right   twelve months of activity as dots. A year of the relationship in one glance.
//           A score of 85 next to a wall of empty dots is a lead you have lost, and no
//           field on the left will ever tell you that.
//
// The old right-hand "Record Details" rail is gone. It was a third column holding the
// fields that Overview was already pretending to show, so the record lived in two places
// and neither was complete. Everything it had — every editable field, closed-lost — is
// here, in the one place a record belongs.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TIER_UI, tierFromScore, type IcpTier } from "@/components/mind/shared";
import { stageColor } from "@/components/mind/entities";
import { Linkedin, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { day, money } from "@/lib/format";
import { OwnerBadge } from "@/components/OwnerBadge";
import { ALL_PIPELINE_STAGES, normalizeStage, stageLabel } from "@/config/pipeline";

// The latest inbound reply's disposition, rendered as a chip next to Intent. This
// is a DIFFERENT axis from intent: intent = how ready-to-buy they are, reply = how
// they last answered. Staked as a reply_signal claim by the worker on every reply.
// Colour on the word only (GET-658): no filled chip, the search palette's quiet way.
const REPLY_UI: Record<string, { label: string; text: string }> = {
  positive:       { label: "Positive",       text: "text-positive" },
  objection:      { label: "Objection",      text: "text-warning" },
  neutral:        { label: "Neutral",        text: "text-muted-foreground" },
  negative:       { label: "Negative",       text: "text-risk" },
  unsubscribe:    { label: "Unsubscribed",   text: "text-risk" },
  do_not_contact: { label: "Do not contact", text: "text-risk" },
  auto_reply:     { label: "Out of office",  text: "text-muted-foreground" },
  bounce:         { label: "Bounced",        text: "text-muted-foreground" },
};

// ── The activity year ────────────────────────────────────────────────────────
// 53 weeks of dots, one column per week, one row per weekday — the shape everyone
// already knows how to read.
export function ActivityYear({ acts }: { acts: any[] }) {
  // Land on the RIGHT EDGE. A year of history that opens on last July is showing you the
  // least useful end of itself — what you want to know is whether this account is warm
  // NOW, and "now" is the last column.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollLeft = el.scrollWidth; }, [acts]);

  const { cells, months, max, total } = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const a of acts) {
      const t = a.occurred_at || a.created_at;
      if (!t) continue;
      const d = new Date(t);
      if (Number.isNaN(+d)) continue;
      const k = d.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (6 - end.getDay()));   // flush to this week's Saturday
    const WEEKS = 53;
    const cells: { k: string; n: number; d: Date }[][] = [];
    const months: { col: number; label: string }[] = [];
    let seen = -1, total = 0, max = 0;
    for (let w = 0; w < WEEKS; w++) {
      const col: { k: string; n: number; d: Date }[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(end);
        d.setDate(end.getDate() - ((WEEKS - 1 - w) * 7 + (6 - dow)));
        const k = d.toISOString().slice(0, 10);
        const n = byDay.get(k) || 0;
        total += n; if (n > max) max = n;
        col.push({ k, n, d });
      }
      const m = col[0].d.getMonth();
      if (m !== seen) { seen = m; months.push({ col: w, label: col[0].d.toLocaleString("en", { month: "short" }) }); }
      cells.push(col);
    }
    return { cells, months, max, total };
  }, [acts]);

  const step = (n: number) => (n === 0 ? 0 : max <= 1 ? 4 : Math.min(4, Math.ceil((n / max) * 4)));
  const TONE = [
    "bg-muted/60",
    "bg-emerald-200 dark:bg-emerald-900/70",
    "bg-emerald-300 dark:bg-emerald-800",
    "bg-emerald-400 dark:bg-emerald-600",
    "bg-emerald-500 dark:bg-emerald-500",
  ];

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="section-title">Activity</h3>
        <span className="text-[12px] text-muted-foreground/60 tabular-nums">
          {total} {total === 1 ? "touch" : "touches"} in 12 months
        </span>
      </div>
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div className="inline-block min-w-full">
          <div className="relative h-5 mb-1.5">
            {months.map((m, i) => (
              <span key={i} className="absolute text-[11px] text-muted-foreground/50" style={{ left: `${m.col * 17}px` }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="flex gap-[4px]">
            {cells.map((col, w) => (
              <div key={w} className="flex flex-col gap-[4px]">
                {col.map(c => (
                  <div key={c.k} title={`${c.k}${c.n ? ` · ${c.n}` : ""}`}
                       className={cn("h-[13px] w-[13px] rounded-[3px]", TONE[step(c.n)])} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {total === 0 && (
        <p className="text-[12.5px] text-muted-foreground/60 mt-3">
          Nothing has happened on this account in a year.
        </p>
      )}
    </div>
  );
}

type F = { label: string; key: string; val: string | null; type?: "select" | "number" | "textarea" | "link"; opts?: string[] };

export function RecordOverview({
  contact, company, prediction, activities, pipelineStages, onPatch, onMarkLost, lostState,
  onTogglePersonal, personalSaving, rightTop, recordOnly,
}: {
  contact: any; company: any; prediction: any; activities: any[];
  pipelineStages: string[];
  onPatch: (key: string, value: string) => void;
  onMarkLost?: () => void;
  lostState?: { marking: boolean; marked: boolean };
  onTogglePersonal?: (on: boolean) => void;
  personalSaving?: boolean;
  /** Optional content rendered in the right column, above the activity year. */
  rightTop?: ReactNode;
  /** Render ONLY the record card (for a persistent left column, Attio-style). */
  recordOnly?: boolean;
}) {
  const isPersonal = !!contact?.is_personal;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const c = contact ?? {};

  const score = prediction?.score ?? (c.icp_score != null ? Number(c.icp_score) : null);
  const tier: IcpTier | null = prediction?.tier ?? tierFromScore(score);

  const start = (k: string, v: string | null) => { setEditing(k); setDraft(v ?? ""); };
  const commit = (k: string) => { onPatch(k, draft); setEditing(null); };

  // The stage select is a WRITE path — whatever it lists is what gets saved onto
  // pipeline_stage — so its options come from the funnel, not from the caller.
  // A caller's list is kept only when EVERY entry is already a current stage;
  // one legacy or phantom name (the old `onboarding` column) and the whole list is
  // dropped for the real ladder, because offering it is how a stage no backend
  // recognises gets written in the first place. All-or-nothing rather than a
  // filter: filtering a stale list leaves a truncated ladder, missing aware /
  // evaluating / client and never gaining meeting_booked / discovery / demo.
  const callerStagesAreCurrent =
    pipelineStages.length > 0 && pipelineStages.every(s => normalizeStage(s) === s);
  const STAGE_OPTS: string[] = callerStagesAreCurrent ? pipelineStages : [...ALL_PIPELINE_STAGES];

  // Read side: the DB has not been migrated, so a row can still say `evaluating`.
  // Normalize it here or the tag shows a stage that no longer exists and the
  // select opens on a value none of its options match.
  const stageVal = normalizeStage(c.pipeline_stage) ?? c.pipeline_stage ?? null;

  // The whole record, in one column. The patch keys are the API's, not the column names.
  const FIELDS: F[] = [
    { label: "First name",  key: "firstName",      val: c.first_name ?? null },
    { label: "Last name",   key: "lastName",       val: c.last_name ?? null },
    { label: "Title",       key: "jobTitle",       val: c.job_title ?? null },
    { label: "Company",     key: "company",        val: company?.name ?? c.company ?? null },
    { label: "Email",       key: "email",          val: c.email ?? null },
    { label: "Phone",       key: "phone",          val: c.phone ?? null },
    { label: "LinkedIn",    key: "linkedinUrl",    val: c.linkedin_url ?? null, type: "link" },
    { label: "Stage",       key: "pipeline_stage", val: stageVal, type: "select", opts: STAGE_OPTS },
    { label: "Deal stage",  key: "dealStage",      val: c.deal_stage ?? null },
    { label: "Deal value",  key: "dealValue",      val: c.deal_value != null ? String(c.deal_value) : null, type: "number" },
    { label: "Source",      key: "lead_source",    val: c.lead_source ?? null },
    { label: "Industry",    key: "industry",       val: c.industry ?? null },
    { label: "Department",  key: "department",     val: c.department ?? null },
    { label: "Seniority",   key: "seniority",      val: c.seniority ?? null },
    { label: "City",        key: "city",           val: c.city ?? null },
    { label: "Country",     key: "country",        val: c.country ?? null },
    { label: "Notes",       key: "notes",          val: c.notes ?? null, type: "textarea" },
  ];

  const recordCard = (
      <div className={recordOnly ? "" : "rounded-2xl border border-border/70 bg-card p-5"}>
        {recordOnly ? (
          /* On the person record it's the left pane's section heading, not a toggle: the
             fields are always shown. */
          <div className="flex min-h-7 min-w-0 items-center gap-1.5 px-2 text-[11.5px] font-medium text-muted-foreground/60">
            <span>Details</span>
            {isPersonal && <span className="ml-auto font-normal">Personal, not a deal</span>}
          </div>
        ) : (
          <button onClick={() => setDetailsOpen(v => !v)} className="flex items-center gap-1.5 mb-2 w-full text-left">
            {detailsOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground/40" /> : <ChevronRight className="h-4 w-4 text-muted-foreground/40" />}
            <span className="text-[13.5px] font-medium text-foreground">Details</span>
            {isPersonal && (
              <span className="ml-1 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground/80">
                Personal · not a deal
              </span>
            )}
          </button>
        )}
        {(recordOnly || detailsOpen) && (<>
        {/* Who on the team owns this person — the same co-attendance ownership an
            account shows, so a person record answers "whose is this?" too. */}
        {c.owner_name && (
          <Row label="Owner">
            <OwnerBadge name={c.owner_name} avatar={c.owner_avatar} />
          </Row>
        )}
        {/* Read-only, because the model owns it. A score you can type over is not a score. */}
        <Row label="ICP">
          {score != null ? (
            <span className="inline-flex items-center gap-2">
              <span className="tabular-nums font-medium">{Math.round(score)}</span>
              {tier && <span className="text-[12px] text-muted-foreground/70">{TIER_UI[tier].label}</span>}
            </span>
          ) : <span className="text-muted-foreground/40">never scored</span>}
        </Row>
        <Row label="Intent">
          {c.intent_band && c.intent_band !== "Dormant"
            ? <span>{c.intent_band}{c.intent_score != null && <span className="text-muted-foreground/60 tabular-nums"> · {Math.round(Number(c.intent_score))}</span>}</span>
            : <span className="text-muted-foreground/40">—</span>}
        </Row>
        {c.reply_signal && (
          <Row label="Reply">
            <span className="inline-flex items-center gap-2">
              <span className={REPLY_UI[c.reply_signal]?.text ?? "text-muted-foreground"}>
                {REPLY_UI[c.reply_signal]?.label ?? c.reply_signal}
              </span>
              {c.reply_at && <span className="text-muted-foreground/70 text-[12px]">{day(c.reply_at)}</span>}
            </span>
          </Row>
        )}
        <Row label="First seen">
          {c.created_at ? day(c.created_at) : <span className="text-muted-foreground/60">—</span>}
        </Row>

        {FIELDS.map(f => (
          <Row key={f.key} label={f.label}>
            {editing === f.key ? (
              f.type === "select" ? (
                <select autoFocus value={draft}
                  onChange={e => { setDraft(e.target.value); onPatch(f.key, e.target.value); setEditing(null); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-foreground/40">
                  {/* value stays the stored stage; only the text is the display name */}
                  {f.opts?.map(o => <option key={o} value={o}>{f.key === "pipeline_stage" ? stageLabel(o) : o}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea autoFocus rows={3} value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={() => commit(f.key)}
                  onKeyDown={e => { if (e.key === "Escape") setEditing(null); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-foreground/40 resize-none leading-relaxed" />
              ) : (
                <input autoFocus type={f.type === "number" ? "number" : "text"} value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={() => commit(f.key)}
                  onKeyDown={e => { if (e.key === "Enter") commit(f.key); if (e.key === "Escape") setEditing(null); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-foreground/40" />
              )
            ) : f.type === "link" && f.val ? (
              // LinkedIn: the icon IS the link. A blue "in" reads faster than the word
              // "Profile" and it is the mark everyone already scans for.
              <a href={f.val} target="_blank" rel="noreferrer" title="Open LinkedIn profile"
                 className="inline-flex items-center text-[#0A66C2] hover:opacity-80 transition-opacity">
                <Linkedin className="h-[17px] w-[17px]" strokeWidth={1.9} />
              </a>
            ) : f.key === "pipeline_stage" && f.val ? (
              // Stage as a coloured tag — the same colours the People table uses, so a
              // stage reads the same way wherever you see it. Click to change.
              <button onClick={() => start(f.key, f.val)} title="Click to change"
                className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover">
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: stageColor(f.val) }} />
                {stageLabel(f.val)}
              </button>
            ) : (
              <span onClick={() => start(f.key, f.val)} title="Click to edit"
                className={cn(
                  "block cursor-text rounded-md -mx-1.5 px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover [overflow-wrap:anywhere]",
                  f.val ? "text-foreground" : "text-muted-foreground/40",
                )}>
                {f.val == null ? `Add ${f.label.toLowerCase()}` : f.key === "dealValue" && Number.isFinite(Number(f.val)) ? money(Number(f.val)) : f.val}
              </span>
            )}
          </Row>
        ))}

        <div className="mt-5 flex items-center gap-4">
          {onMarkLost && (
            <button
              onClick={onMarkLost}
              disabled={lostState?.marking || lostState?.marked}
              className="text-[12px] text-muted-foreground/50 hover:text-red-600 disabled:hover:text-muted-foreground/50 transition-colors"
            >
              {lostState?.marked ? "Marked closed-lost" : lostState?.marking ? "Marking…" : "Mark closed-lost"}
            </button>
          )}
          {onTogglePersonal && (
            // Not every contact is a deal. Marking a friend/connection personal keeps them
            // on the record but pulls them out of pipeline, scoring, and deal-risk.
            <button
              onClick={() => onTogglePersonal(!isPersonal)}
              disabled={personalSaving}
              className="text-[12px] text-muted-foreground/50 hover:text-foreground/70 disabled:opacity-50 transition-colors"
            >
              {personalSaving ? "Saving…" : isPersonal ? "Mark as a deal" : "Not a deal (personal)"}
            </button>
          )}
        </div>
        </>)}
      </div>
  );

  if (recordOnly) return recordCard;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,30%)_minmax(0,1fr)] gap-8">
      {recordCard}
      <div className="space-y-5 lg:sticky lg:top-6 lg:self-start">
        {rightTop}
        <div className="rounded-2xl border border-border/70 bg-card p-5">
          <ActivityYear acts={activities} />
        </div>
      </div>
    </div>
  );
}

// A label/value row, the record pane's PropRow: a 116px label in the quiet grey, no icon, no rule.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-8 items-baseline gap-2 px-2 py-[5px] text-[13px]" style={{ gridTemplateColumns: "116px minmax(0,1fr)" }}>
      <span className="truncate text-[12px] text-muted-foreground/70">{label}</span>
      <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
