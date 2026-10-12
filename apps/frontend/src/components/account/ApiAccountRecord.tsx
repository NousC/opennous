// The account record on the API plan (GET-634). Read-only: the agent writes through the API, so
// this page shows what Nous holds about the account — its facts with their confidence, freshness
// and source on the left, the people and the timeline on the right. No chat, tasks, insights or
// edit controls; those are Workspace surfaces.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { EntityAvatar } from "@/components/EntityAvatar";
import { ActivityIcon } from "@/components/mind/entities";
import { INTEL_ORDER, type Note } from "@/components/record/RecordParts";
import { catName } from "@/components/account/parts";
import { activityTitle, buildAccountFeed } from "@/components/account/AccountActivity";
import { useAccountDeals } from "@/components/deals/AccountDeals";
import { cn } from "@/lib/utils";
import { when } from "@/lib/format";
import { factGroups, providerName, tierOf, type ClaimIn, type Fact } from "./apiAccountModel";
import { TierBars } from "./TierBits";

type Stakeholder = {
  id: string; name: string; title: string | null; photo_url: string | null; email?: string | null;
  last_activity_at: string | null; role?: string | null;
};
/** The company row as /api/companies/:id/detail returns it; the record reads these fields. */
type CompanyRow = {
  id: string; name?: string | null; domain?: string | null; industry?: string | null;
  employee_count?: number | string | null; location?: string | null; icp_score?: number | null;
  [field: string]: unknown;
};
type FeedInput = Parameters<typeof buildAccountFeed>[0];
export type ApiAccountDetail = {
  company: CompanyRow;
  icp: { score: number } | null;
  stakeholders: Stakeholder[];
  activity: FeedInput["acts"];
  facts?: ClaimIn[];
  notes?: Note[];
  calls?: FeedInput["calls"];
  hubspot_url?: string | null;
};

const pill = "inline-flex h-[26px] items-center gap-[5px] whitespace-nowrap rounded-md bg-muted px-2.5 text-[12.5px] text-foreground";
const card = "rounded-xl border border-border bg-card";

function SourceMark({ source }: { source: string | null }) {
  if (!source) return <span aria-hidden className="inline-block h-4 w-4 flex-shrink-0" />;
  return (
    <span title={providerName(source)} aria-label={providerName(source)}
      className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden rounded">
      <ActivityIcon source={source} type="" />
    </span>
  );
}

// One fact. On a phone the label sits above the value and the epistemics below it; from `sm` up it
// is the board's single line: label, value, confidence, freshness, source.
function FactRow({ f }: { f: Fact }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-hairline py-2.5 text-[13px] sm:flex-nowrap">
      {f.label && <span className="w-full truncate text-[12.5px] text-muted-foreground sm:w-[132px] sm:flex-shrink-0" title={f.label}>{f.label}</span>}
      <span className="min-w-0 basis-full [overflow-wrap:anywhere] sm:flex-1 sm:basis-auto">{f.value}</span>
      <span className="inline-flex flex-shrink-0 items-center gap-[5px] pt-px text-[11.5px] text-ink-2 sm:w-[68px]">
        {f.confidence && <>
          <i className={cn("inline-block h-1.5 w-1.5 rounded-full", f.confidence === "High" ? "bg-foreground" : "bg-border")} />
          {f.confidence}
        </>}
      </span>
      <span className={cn("flex-shrink-0 pt-px text-[12px] sm:w-[76px] sm:text-right", f.stale ? "text-warning" : "text-muted-foreground")}
        title={f.stale ? "Past its freshness window" : undefined}>
        {f.at ? when(f.at) : ""}
      </span>
      <span className="ml-auto inline-flex flex-shrink-0 sm:ml-0"><SourceMark source={f.source} /></span>
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      toast.success("Account id copied");
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => toast.error("Could not copy"));
  };
  return (
    <button type="button" onClick={copy} title="Copy account id" aria-label="Copy account id"
      className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-muted pl-2 pr-1 font-geist-mono text-[11.5px] text-ink-2 transition-colors hover:text-foreground">
      {id.slice(0, 8)}
      <span className="inline-flex h-5 w-5 items-center justify-center rounded">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </span>
    </button>
  );
}

const ts = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : -Infinity; };

export default function ApiAccountRecord({ cd }: { cd: ApiAccountDetail }) {
  const co = cd.company ?? ({} as CompanyRow);
  const id: string = co.id;
  const deals = useAccountDeals(id);
  const [allPeople, setAllPeople] = useState(false);
  const [allTimeline, setAllTimeline] = useState(false);

  const score = cd.icp?.score ?? (typeof co.icp_score === "number" ? co.icp_score : null);
  const tier = tierOf(score);
  const openDeals = (deals.data?.deals ?? []).filter((d) => !d.implied && d.status === "open");
  const subtitle = [co.domain, co.industry, co.employee_count ? `${Number(co.employee_count).toLocaleString("en-US")} people` : null, co.location]
    .filter(Boolean).join(" · ");

  const people = useMemo(
    () => (cd.stakeholders ?? []).slice().sort((a, b) => ts(b.last_activity_at) - ts(a.last_activity_at)),
    [cd.stakeholders],
  );
  const nameOf = useMemo(() => {
    const m = new Map(people.map((p) => [p.id, p.name]));
    return (pid: string) => m.get(pid) ?? null;
  }, [people]);

  const groups = useMemo(() => factGroups({
    claims: cd.facts ?? [], company: co, notes: cd.notes ?? [], deals: deals.data?.deals ?? [],
    order: INTEL_ORDER, categoryName: catName, nameOf,
  }), [cd.facts, co, cd.notes, deals.data, nameOf]);

  // What already happened, newest first: the activity and the account's call summaries.
  const timeline = useMemo(() => {
    const now = Date.now();
    return buildAccountFeed({ acts: cd.activity ?? [], calls: cd.calls ?? [] })
      .filter((i) => i.type !== "signal" && ts(i.at) <= now);
  }, [cd.activity, cd.calls]);

  const shownPeople = allPeople ? people : people.slice(0, 5);
  const shownTimeline = allTimeline ? timeline : timeline.slice(0, 8);

  return (
    <div className="h-full overflow-auto bg-card">
      <div className="flex flex-wrap items-center gap-3.5 border-b border-hairline px-5 pb-[18px] pt-[22px] sm:px-7">
        <EntityAvatar kind="company" name={co.name} domain={co.domain}
          className="h-11 w-11 flex-shrink-0 rounded-[11px]" textClassName="text-[18px] font-semibold" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-foreground">{co.name ?? "Account"}</h1>
          {subtitle && <span className="truncate text-[12px] text-muted-foreground">{subtitle}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {score != null && <span className={pill}><span className="text-muted-foreground">ICP</span><span className="font-semibold tabular-nums">{Math.round(score)}</span></span>}
          {tier && <span className={pill}><TierBars tier={tier} />Tier {tier}</span>}
          {openDeals.length > 0 && <span className={pill}>{openDeals.length} open deal{openDeals.length === 1 ? "" : "s"}</span>}
          {id && <CopyId id={id} />}
          {cd.hubspot_url && (
            <a href={cd.hubspot_url} target="_blank" rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors hover:bg-hover">
              View in CRM <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-7 px-5 pb-7 pt-1.5 sm:px-7">
        <section className="min-w-0 flex-[999_1_520px]">
          {groups.map((g) => (
            <div key={g.title}>
              <h2 className="pb-2 pt-[18px] text-[12px] font-medium text-muted-foreground">{g.title}</h2>
              {g.facts.map((f) => <FactRow key={f.key} f={f} />)}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="pt-[18px] text-[13px] text-muted-foreground">Nothing recorded yet</p>
          )}
        </section>

        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4 pt-[18px]">
          <div className={card}>
            <div className="flex items-center px-4 pb-1.5 pt-3 text-[13px]">
              <span className="flex-1 font-medium">People</span>
              <span className="text-[12px] tabular-nums text-muted-foreground">{people.length}</span>
            </div>
            {shownPeople.map((p) => (
              <Link key={p.id} to={`/people/${p.id}`} className="flex items-center gap-2.5 px-4 py-2 text-[13px] transition-colors hover:bg-hover">
                <EntityAvatar kind="person" name={p.name} email={p.email} photoUrl={p.photo_url}
                  className="h-7 w-7 flex-shrink-0 rounded-full" textClassName="text-[10px] font-semibold text-ink-2" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{p.name}</span>
                  {(p.title || (p.role && p.role !== "contact")) && (
                    <span className="truncate text-[12px] text-muted-foreground">
                      {[p.title, p.role && p.role !== "contact" ? p.role.replace(/_/g, " ") : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                {p.last_activity_at && <span className="flex-shrink-0 text-[12px] text-muted-foreground">{when(p.last_activity_at)}</span>}
              </Link>
            ))}
            {people.length === 0 && <div className="px-4 pb-3 pt-1 text-[13px] text-muted-foreground">No people yet</div>}
            {people.length > 5 && (
              <div className="px-4 pb-3 pt-1.5">
                <button onClick={() => setAllPeople((v) => !v)} className="text-[12px] font-medium text-muted-foreground hover:text-foreground">
                  {allPeople ? "Show fewer" : `Show all ${people.length}`}
                </button>
              </div>
            )}
            {people.length > 0 && people.length <= 5 && <div className="h-2" />}
          </div>

          <div className={card}>
            <div className="flex items-center px-4 pb-1 pt-3 text-[13px]">
              <span className="flex-1 font-medium">Timeline</span>
            </div>
            {shownTimeline.map((i) => {
              const title = i.type === "activity" ? activityTitle(i.a)
                : i.type === "page" ? (i.doc.title || "Call summary") : "";
              const src = i.type === "activity" ? String(i.a.source ?? "").toLowerCase() : "";
              const who = i.type === "activity" && i.a.contactName && !title.includes(i.a.contactName) ? i.a.contactName : null;
              const sub = i.type === "page" ? "Call summary"
                : [who, src && !["manual", "agent", "system"].includes(src) ? providerName(src.replace(/-/g, "_")) : null].filter(Boolean).join(" · ");
              return (
                <div key={i.key} className="flex gap-3 px-4 py-2.5 text-[13px]">
                  <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[7px] bg-muted text-ink-2">
                    {i.type === "activity" ? <ActivityIcon source={i.a.source} type={i.a.activity_type || ""} /> : <FileText className="h-3.5 w-3.5" />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col leading-snug">
                    <span className="truncate">{title}</span>
                    {sub && <span className="truncate text-[12px] text-muted-foreground">{sub}</span>}
                  </span>
                  <span className="flex-shrink-0 text-[12px] text-muted-foreground">{i.at ? when(i.at) : ""}</span>
                </div>
              );
            })}
            {timeline.length === 0 && <div className="px-4 pb-3 pt-1 text-[13px] text-muted-foreground">No activity yet</div>}
            {timeline.length > 8 ? (
              <div className="px-4 pb-3 pt-1.5">
                <button onClick={() => setAllTimeline((v) => !v)} className="text-[12px] font-medium text-muted-foreground hover:text-foreground">
                  {allTimeline ? "Show fewer" : `Show all ${timeline.length}`}
                </button>
              </div>
            ) : <div className="h-2" />}
          </div>
        </aside>
      </div>
    </div>
  );
}
