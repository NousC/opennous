// Hover previews for records (interface refresh, GET-611). Hovering an account's or a deal's name
// or logo opens a small card after 300ms: where it stands, what it is worth, whose it is, when it
// was last touched, and the one signal most worth knowing. The data is read when the card opens
// and cached per id by react-query, so the second hover is instant and the deal's preview shares
// the deal page's cache.
//
// Used on the record pages for now (the account's deals and contacts, the deal's account link).
// Other pages adopt it later.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useAccountDeal, useAccountDeals, dealStageText, countsAsDeal } from "@/components/deals/AccountDeals";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { usePipelineStages } from "@/components/pipeline/usePipelineData";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { useAuth } from "@/contexts/AuthContext";
import { stageLabel } from "@/config/pipeline";
import { money, when } from "@/lib/format";
import type { DealSignal } from "./RecordParts";
import { stageGroup } from "./stageGroup";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
export const PREVIEW_DELAY = 300;

type Target =
  | { kind: "deal"; companyId: string; dealId: string }
  | { kind: "account"; companyId: string }
  | { kind: "person"; name: string; title?: string | null; role?: string | null; lastActivityAt?: string | null; signals?: number | null };

/** The signal a rep most needs: the worst smart signal, as "Blocker severity: Critical". */
export function topSignal(smart: DealSignal[] | null | undefined): { text: string; tone: string } | null {
  const s = (smart ?? []).find(x => x.tone === "bad") ?? (smart ?? []).find(x => x.tone === "warn") ?? null;
  if (!s) return null;
  const label = s.label.charAt(0) + s.label.slice(1).toLowerCase();
  return { text: `${label}: ${s.level ?? s.value ?? ""}`.trim(), tone: s.tone };
}

/** Wraps a name or logo. The child is the hover target and must accept a ref (a plain element). */
export function RecordPreview({ children, ...target }: Target & { children: ReactNode }) {
  return (
    <HoverCard openDelay={PREVIEW_DELAY} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* The palette's popover: 16px radius, hairline, the modal shadow, 8px inset. */}
      <HoverCardContent onClick={e => e.stopPropagation()} className="w-[280px] rounded-2xl p-2 shadow-modal">
        {target.kind === "deal" ? <DealCard {...target} />
          : target.kind === "account" ? <AccountCard {...target} />
          : <PersonCard {...target} />}
      </HoverCardContent>
    </HoverCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[88px_minmax(0,1fr)] items-center gap-2 px-2 text-[12.5px]">
      <span className="text-[12px] text-muted-foreground/70">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function Signal({ s }: { s: { text: string; tone: string } | null }) {
  if (!s) return null;
  return (
    <div className="mx-0.5 mt-1.5 rounded-lg bg-hover px-2 py-1.5 text-[12px] leading-snug">
      <span className={s.tone === "bad" ? "text-risk" : "text-warning"}>{s.text}</span>
    </div>
  );
}

const Loading = () => <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground/70">Loading…</p>;

/** The card's head, a palette row: the 24px lead, the name at 13px, what it is in the quiet tone. */
function Head({ lead, title, sub }: { lead: ReactNode; title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2.5 px-2 pb-1 pt-1.5">
      {lead}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-foreground">{title}</div>
        {sub && <div className="truncate text-[11.5px] text-muted-foreground/70">{sub}</div>}
      </div>
    </div>
  );
}

function DealCard({ companyId, dealId }: { companyId: string; dealId: string }) {
  const { data, isPending, isError } = useAccountDeal(companyId, dealId);
  const ladder = usePipelineStages(data?.deal.pipeline_id ?? "all").data;
  if (isPending) return <Loading />;
  if (isError || !data) return <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground/70">This deal could not be loaded.</p>;
  const d = data.deal;
  const g = stageGroup(d.status, d.stage, ladder);
  const last = data.activity.map((a: { occurred_at?: string; created_at?: string }) => a.occurred_at || a.created_at || "")
    .filter(t => t && Date.parse(t) <= Date.now()).sort().pop() ?? null;
  const owner = d.owners?.[0]?.name ?? d.owner_name ?? null;
  const reason = (data.health as { reason?: string | null }).reason ?? null;
  return (
    <div className="min-w-0">
      <Head lead={<AccountLogo name={data.account.name ?? null} domain={data.account.domain} size={24} className="rounded-md" />}
        title={d.name} sub={data.account.name} />
      <div>
        <Row label="Stage">
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: g.color }} />{dealStageText(d) ?? g.label}</span>
        </Row>
        <Row label="Amount"><span className="tabular-nums">{d.value != null ? money(d.value) : "—"}</span></Row>
        <Row label="Owner">{owner ?? "—"}</Row>
        <Row label="Last activity">{last ? when(last) : "—"}</Row>
      </div>
      <Signal s={reason ? { text: reason, tone: (data.health.score ?? 100) < 40 ? "bad" : "warn" } : topSignal(data.health.smart)} />
    </div>
  );
}

type AccountBrief = { company: { name?: string; domain?: string | null; pipeline_stage?: string | null; owner_name?: string | null; owners?: { name?: string | null }[]; last_activity_at?: string | null }; deal_health?: { smart?: DealSignal[] } | null };

function AccountCard({ companyId }: { companyId: string }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const q = useQuery<AccountBrief>({
    queryKey: ["record-preview", "account", wsId, companyId],
    enabled: !!token && !!wsId,
    staleTime: 300_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/companies/${companyId}/detail?workspaceId=${wsId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`detail ${r.status}`);
      return r.json();
    },
  });
  const deals = useAccountDeals(companyId).data?.deals ?? [];
  if (q.isPending) return <Loading />;
  if (q.isError || !q.data) return <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground/70">This account could not be loaded.</p>;
  const co = q.data.company;
  const open = deals.filter(d => d.status === "open" && countsAsDeal(d));
  const owner = co.owners?.[0]?.name ?? co.owner_name ?? null;
  return (
    <div className="min-w-0">
      <Head lead={<AccountLogo name={co.name ?? null} domain={co.domain ?? null} size={24} className="rounded-md" />} title={co.name} sub={co.domain} />
      <div>
        <Row label="Stage">{co.pipeline_stage ? stageLabel(co.pipeline_stage) : "—"}</Row>
        <Row label="Open pipeline"><span className="tabular-nums">{money(open.reduce((s, d) => s + (d.value ?? 0), 0))}{open.length ? ` · ${open.length} ${open.length === 1 ? "deal" : "deals"}` : ""}</span></Row>
        <Row label="Owner">{owner ?? "—"}</Row>
        <Row label="Last activity">{co.last_activity_at ? when(co.last_activity_at) : "—"}</Row>
      </div>
      <Signal s={topSignal(q.data.deal_health?.smart)} />
    </div>
  );
}

const ROLE: Record<string, string> = { decision_maker: "Decides", economic_buyer: "Budget", champion: "Champion", blocker: "Blocker", influencer: "Influencer" };

/** A contact: what the page already knows, no fetch. */
function PersonCard({ name, title, role, lastActivityAt, signals }: Extract<Target, { kind: "person" }>) {
  return (
    <div className="min-w-0">
      <Head lead={<PersonAvatar person={{ id: name, name }} size={24} />} title={name} sub={title} />
      <div className="pb-1">
        <Row label="Role">{role && ROLE[role] ? ROLE[role] : "Contact"}</Row>
        <Row label="Last activity">{lastActivityAt ? when(lastActivityAt) : "—"}</Row>
        {signals != null && <Row label="Signals"><span className="tabular-nums">{signals}</span></Row>}
      </div>
    </div>
  );
}
