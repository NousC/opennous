// Everything that happened on the account, in one list: the activity feed, the account's pages
// (call summaries and documents, which used to sit in their own Pages tab), and the public signals
// on the company. Filter chips cut it by kind; a row can be two kinds at once (a call logged in
// HubSpot is a meeting AND a CRM row, a call summary is a meeting AND a document).
//
// Pages still open where they always opened (/pages/:id); this only changes where you find them.
import { useState } from "react";
import { toolLogo, toolOfRef } from "@/lib/toolLogo";
import { FileText, Phone, Zap } from "lucide-react";
import { ActivityRow, dedupeActivity } from "@/components/record/RecordParts";
import { EmptyState } from "@/components/ui/empty-state";
import { CardHead, EventRow, eventKind, type EventKind } from "@/components/record/OverviewParts";
import { ListCard, ListEmpty, ListMeta, ListText, ListTile } from "@/components/ui/list";
import { when } from "@/lib/format";

export const FEED_FILTERS = ["All", "Meetings", "Emails", "CRM", "Signals", "Documents"] as const;
export type FeedFilter = typeof FEED_FILTERS[number];

type Base = { key: string; at: string | null; kinds: FeedFilter[] };
export type FeedItem =
  | (Base & { type: "activity"; a: any })
  | (Base & { type: "page"; doc: any; call: boolean })
  | (Base & { type: "signal"; s: any });

const CRM_SOURCE = /hubspot|salesforce|pipedrive|attio|zoho/;
const isCrm = (a: any) => CRM_SOURCE.test(String(a?.source ?? "").toLowerCase());

function activityKinds(a: any): FeedFilter[] {
  const t = String(a?.activity_type ?? "").toLowerCase();
  const out: FeedFilter[] = [];
  if (/meeting|(^|_)call(_|$)/.test(t)) out.push("Meetings");
  if (t.includes("email")) out.push("Emails");
  if (isCrm(a) || /^(deal|note|task|crm|stage|lifecycle)/.test(t)) out.push("CRM");
  if (t.includes("linkedin") || /signal|job_post|hiring|funding|intent|visit|tech_stack|news/.test(t) || String(a?.source ?? "").toLowerCase() === "linkedin") out.push("Signals");
  return out;
}

// A document is dated by the window it covers, else by when it was written (packages/core
// documents.ts). `date` is what older payloads and the preview fixtures send.
const docDate = (d: any): string | null => d?.date ?? d?.period_end ?? d?.created_at ?? null;
const ts = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : -Infinity; };

export function buildAccountFeed({ acts, calls, documents, signals }: { acts: any[]; calls?: any[] | null; documents?: any[] | null; signals?: any[] | null }): FeedItem[] {
  const items: FeedItem[] = [];
  dedupeActivity(acts).forEach((a, i) => items.push({ key: `a:${a.id ?? i}`, at: a.occurred_at || a.created_at || null, kinds: activityKinds(a), type: "activity", a }));
  (calls ?? []).forEach((d, i) => items.push({ key: `c:${d.id ?? i}`, at: docDate(d), kinds: ["Meetings", "Documents"], type: "page", doc: d, call: true }));
  (documents ?? []).forEach((d, i) => items.push({ key: `d:${d.id ?? i}`, at: docDate(d), kinds: ["Documents"], type: "page", doc: d, call: false }));
  (signals ?? []).forEach((s, i) => items.push({ key: `s:${s.signal_class ?? i}`, at: s.updated_at ?? null, kinds: ["Signals"], type: "signal", s }));
  return items.sort((x, y) => ts(y.at) - ts(x.at));
}

const nameOfAddress = (addr?: string | null) => {
  const s = String(addr ?? "").trim();
  const m = /^\s*"?([^"<]+?)"?\s*<(.+)>\s*$/.exec(s);
  return (m ? m[1] : s.split("@")[0] || s).trim() || null;
};
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const signalName = (s: any) => sentence(String(s?.signal_class ?? "signal").replace(/[_.]/g, " "));

/** One line for an activity, the way the compact list reads it (also the API plan's account record). */
export function activityTitle(a: any): string {
  const raw = a.raw_data ?? {};
  const type = String(a.activity_type || "");
  if (type.startsWith("email")) {
    const other = a.contactName || (type === "email_sent" ? nameOfAddress((raw.to ?? [])[0]) : nameOfAddress(raw.from));
    const subject = raw.subject ? ` · ${raw.subject}` : "";
    return `${type === "email_sent" ? "Email sent to" : "Email from"} ${other ?? "someone"}${subject}`;
  }
  const title = a.subject ?? a.title ?? raw.title ?? null;
  const kind = sentence(type.replace(/_/g, " ")) || "Activity";
  return title ? `${kind} · ${title}` : kind;
}

/** The note-taker or tool a page came from, as its logo (GET-659). */
function docLogo(d: any): string | null {
  return toolLogo(d?.source ?? d?.provider ?? d?.source_system) ?? toolLogo(toolOfRef(d?.source_ref ?? d?.source_url ?? d?.url));
}

/** A page (call summary or document) as an Activity row; it opens where the Pages tab opened it. */
function PageRow({ d, call }: { d: any; call: boolean }) {
  const at = docDate(d);
  const logo = docLogo(d);
  return (
    <a href={`/pages/${d.id}`} className="block min-w-0 rounded-lg px-2 py-2 transition-colors duration-fast hover:bg-hover">
      <div className="flex min-w-0 items-center gap-2.5">
        <ListTile>
          {logo ? <img src={logo} alt="" className="h-3.5 w-3.5 object-contain" />
            : call ? <Phone className="h-[13px] w-[13px]" strokeWidth={1.75} /> : <FileText className="h-[13px] w-[13px]" strokeWidth={1.75} />}
        </ListTile>
        <ListText title={d.title || "Untitled"} sub={call ? "Call summary" : "Document"} />
        {at && <ListMeta>{when(at)}</ListMeta>}
      </div>
      {d.headline && <p className="mt-0.5 line-clamp-2 pl-[34px] text-[12.5px] leading-relaxed text-muted-foreground/80">{d.headline}</p>}
    </a>
  );
}

function SignalFeedRow({ s }: { s: any }) {
  return (
    <div className="min-w-0 rounded-lg px-2 py-2 transition-colors duration-fast hover:bg-hover">
      <div className="flex min-w-0 items-center gap-2.5">
        <ListTile><Zap className="h-[13px] w-[13px]" strokeWidth={1.75} /></ListTile>
        <ListText title={signalName(s)} sub="Signal" />
        {s.updated_at && <ListMeta>{when(s.updated_at)}</ListMeta>}
      </div>
      {(s.detected || s.implies) && (
        <div className="mt-0.5 pl-[34px]">
          {s.detected && <p className="text-[12.5px] leading-relaxed text-foreground/80">{s.detected}</p>}
          {s.implies && <p className="text-[12.5px] leading-relaxed text-muted-foreground/70">{s.implies}</p>}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 80;

export function AccountActivityTab({ items }: { items: FeedItem[] }) {
  // One list, newest first (GET-797): the Meetings / Emails / Documents chips went. The logo on
  // each row already says what it is.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = items;

  return (
    <div className="min-w-0">
      {rows.length === 0
        ? <EmptyState title="No activity yet" />
        : (
          // overflow-wrap is inherited: a pasted URL in an email body breaks inside the card instead
          // of widening the page.
          <ListCard className="min-w-0 [overflow-wrap:anywhere]">
            {rows.slice(0, limit).map(i => (
              <div key={i.key} className="min-w-0">
                {i.type === "activity" ? <ActivityRow a={i.a} /> : i.type === "page" ? <PageRow d={i.doc} call={i.call} /> : <SignalFeedRow s={i.s} />}
              </div>
            ))}
          </ListCard>
        )}
      {rows.length > limit && (
        <button onClick={() => setLimit(l => l + PAGE_SIZE)} className="mt-2 rounded-md px-2 py-1 text-[12px] text-muted-foreground/70 hover:bg-hover hover:text-foreground">
          Show more ({rows.length - limit} older)
        </button>
      )}
    </div>
  );
}

/** One feed item as an Overview row: what kind, what it was, a line of what was said, a link. */
export function feedEvent(i: FeedItem): { kind: EventKind; title: string; meta: string | null; sub: string | null; href?: string; logo: string | null } {
  if (i.type === "page") {
    return { kind: i.call ? "meeting" : "document", title: i.doc.title || "Untitled", meta: i.call ? "Call summary" : "Document", sub: i.doc.headline ?? null, href: `/pages/${i.doc.id}`, logo: docLogo(i.doc) };
  }
  if (i.type === "signal") return { kind: "signal", title: signalName(i.s), meta: null, sub: i.s.detected ?? i.s.implies ?? null, logo: null };
  const a = i.a;
  const raw = a.raw_data ?? {};
  const type = String(a.activity_type || "");
  const body = String(a.subtitle || raw.text || raw.body_text || "").replace(/\s+/g, " ").trim() || null;
  const src = String(a.source ?? "").toLowerCase();
  if (type.startsWith("email")) {
    const other = a.contactName || (type === "email_sent" ? nameOfAddress((raw.to ?? [])[0]) : nameOfAddress(raw.from));
    return { kind: "email", title: type === "email_sent" ? `Email to ${other ?? "someone"}` : `${other ?? "Someone"} emailed`, meta: raw.subject ?? null, sub: a.redacted || raw.redacted ? null : body, logo: toolLogo(src) ?? toolLogo("gmail") };
  }
  const named = a.subject ?? a.title ?? raw.title ?? null;
  const kind = eventKind(type, a.source);
  const what = sentence(type.replace(/_/g, " ")) || "Activity";
  const sent = /_sent$/.test(type);
  const title = named
    ?? (kind === "meeting" && a.contactName ? `Meeting with ${a.contactName}`
      : kind === "message" && a.contactName ? `LinkedIn message ${sent ? "to" : "from"} ${a.contactName}`
      : what);
  const meta = isCrm(a) ? `In ${sentence(src)}` : named && a.contactName ? a.contactName : null;
  return { kind, title, meta, sub: body, logo: toolLogo(src) ?? toolLogo(toolOfRef(a.source_url ?? raw.url)) };
}

/** The Overview's most recent rows (GET-609): icon, what happened, what was said, when. */
export function RecentActivity({ items, onAll, limit = 4 }: { items: FeedItem[]; onAll: () => void; limit?: number }) {
  // What already happened. A meeting booked for next week sorts to the top of the full list, but
  // "recent" is not where a rep looks for it.
  const now = Date.now();
  const rows = items.filter(i => ts(i.at) <= now).slice(0, limit);
  return (
    <ListCard className="min-w-0">
      <CardHead title="Recent activity" onAll={items.length ? onAll : undefined} />
      {rows.length === 0
        ? <ListEmpty>No activity yet</ListEmpty>
        : rows.map(i => {
          const e = feedEvent(i);
          return <EventRow key={i.key} kind={e.kind} title={e.title} meta={e.meta} sub={e.sub} when={when(i.at)} href={e.href} onClick={e.href ? undefined : onAll} logo={e.logo} />;
        })}
    </ListCard>
  );
}
