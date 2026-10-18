// The account's left pane (GET-608): who it is and whose it is, the open pipeline, then the
// record's properties as sections — Deals, Contacts, Qualification, Company details.
//
// The AE and the CS owner are two people and two CRM fields; they get two chips, never one
// "owner". Both health numbers stay: ours (Nous) and, on a customer, the CRM's own, marked as such.
import { useState } from "react";
import type { Note } from "@/components/record/RecordParts";
import { PaneItem, PaneSection, PropRow, TierMark } from "@/components/record/RecordLayout";
import { ClaimHoverTag } from "@/components/record/ClaimHoverTag";
import { MEANING } from "@/components/record/intelLook";
import { ListEmpty, ListMeta, ListText } from "@/components/ui/list";
import { RecordPreview } from "@/components/record/RecordPreview";
import { useAccountDeals } from "@/components/deals/AccountDeals";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { MemberAvatar } from "@/components/ui/member-avatar";
import { TIER_UI, type IcpTier } from "@/components/mind/shared";
import { money } from "@/lib/format";
import { AccountDealsSection, dealTotals } from "./AccountDealsTab";
import { CompanyDetailsSection } from "./AccountDetails";
import { AccountHealthTag, CHIP, CrmHealthBadge, TypeChip, type CustomerKind } from "@/components/account/parts";
import { cn } from "@/lib/utils";

/**
 * One decision role on the account (GET-800), from packages/core decisionMakers: a named person or
 * an unnamed role ("CEO", nobody met yet), with where it stands.
 */
export type DecisionMaker = {
  key: string; entity_id: string | null; name: string | null; title: string | null;
  role: "economic_buyer" | "decision_maker" | "champion" | "blocker" | string;
  status: "engaged" | "not_engaged" | "not_contacted" | "blocking";
  unnamed: boolean; tier?: string | null; evidence: string[]; quote?: string | null; said_at?: string | null;
};

export const DM_STATUS: Record<DecisionMaker["status"], { label: string; tone: string }> = {
  engaged: { label: "Engaged", tone: "text-positive" },
  not_engaged: { label: "Not engaged", tone: "text-warning" },
  not_contacted: { label: "Not contacted", tone: "text-muted-foreground/70" },
  blocking: { label: "Blocking", tone: "text-risk" },
};
const DM_ROLE: Record<string, string> = { economic_buyer: "Economic buyer", decision_maker: "Decision maker", champion: "Champion", blocker: "Blocker" };

export type PanePerson = { id: string; name: string; title: string | null; role?: string | null; last_activity_at?: string | null; signal_count?: number | null };

/** The buying-committee role as a word a rep says. Plain contacts get no pill. */
const ROLE_PILL: Record<string, string> = {
  decision_maker: "Decides", economic_buyer: "Budget", champion: "Champion", blocker: "Blocker", influencer: "Influencer",
};


/** A fact as a tag: its short label, else the named thing, else the first few words. */
const tagText = (n: Note): string => {
  const label = n.label?.trim();
  if (label) return label;
  const entity = String(n.metadata?.entity ?? "").trim();
  if (entity) return entity;
  const words = String(n.content ?? "").trim().split(/\s+/);
  return words.length > 5 ? `${words.slice(0, 5).join(" ")}…` : words.join(" ");
};

type QualTag = { key: string; text: string; full: string | null; note?: Note | null; who?: string | null };

/**
 * What a rep qualifies on, as tags (GET-792): each kind its few newest facts, the full sentence on
 * hover. A kind nobody spoke to is left out, not shown as a dash: six rows of "—" read as broken.
 * An open objection beats a resolved one; competitors are named once each.
 */
function qualification(intel: Note[], people: PanePerson[]): { label: string; kind: string; color: string; tags: QualTag[] }[] {
  const nameOf = new Map(people.map(p => [p.id, p.name]));
  const voicedBy = (n: Note) => {
    const id = n.metadata?.voiced_by_contact_id;
    return (typeof id === "string" && nameOf.get(id)) || (typeof n.metadata?.speaker === "string" ? n.metadata.speaker : null);
  };
  const of = (c: string) => intel.filter(n => (n.category || "").toLowerCase() === c)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const tags = (facts: Note[], max = 3): QualTag[] => {
    const seen = new Set<string>();
    const out: QualTag[] = [];
    for (const n of facts) {
      const text = tagText(n);
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push({ key: n.id, text, full: n.content ?? null, note: n, who: voicedBy(n) });
      if (out.length >= max) break;
    }
    return out;
  };
  const objections = of("objection");
  const openObj = objections.filter(n => String(n.metadata?.status ?? "open").toLowerCase() !== "resolved");
  return [
    { label: "Objections", kind: "Objection", color: MEANING.red, tags: tags(openObj.length ? openObj : objections) },
    { label: "Competitors", kind: "Competitor", color: MEANING.amber, tags: tags(of("competitor")) },
    { label: "Budget", kind: "Budget", color: MEANING.green, tags: tags(of("budget"), 2) },
    { label: "Timeline", kind: "Timeline", color: MEANING.blue, tags: tags(of("timeline"), 2) },
    { label: "Buying signals", kind: "Buying signal", color: MEANING.green, tags: tags(of("buying_signal")) },
  ].filter(q => q.tags.length > 0);
}

export function AccountPane({
  co, companyId, name, domain, tier, kind, owners, csOwner, nousScore, nousBand = null, nousTitle, crmScore, saving,
  people, intel, decisionMakers = [], onOpenPerson, getVal, onPatch,
}: {
  co: Record<string, unknown> & { name?: string; tech_stack?: unknown; enrichment_status?: string | null; last_activity_at?: string | null; employee_count?: number | null; industry?: string | null; location?: string | null; revenue_range?: string | null };
  companyId: string | null;
  name: string;
  domain: string | null;
  tier: IcpTier | null;
  kind: CustomerKind;
  owners: string[];
  csOwner: string | null;
  nousScore: number | null;
  /** The account health band (Healthy / Needs attention / At risk) the tag names (GET-804). */
  nousBand?: string | null;
  nousTitle?: string;
  crmScore: number | null;
  saving?: boolean;
  people: PanePerson[];
  intel: Note[];
  /** Every decision role, named or not, with its status (GET-800). */
  decisionMakers?: DecisionMaker[];
  onOpenPerson: (id: string) => void;
  getVal: (key: string, fallback: string | null | undefined) => string | null;
  onPatch: (key: string, value: string) => void;
}) {
  const dealsQ = useAccountDeals(companyId);
  const t = dealTotals(dealsQ.data?.deals ?? []);
  const [allPeople, setAllPeople] = useState(false);
  const shownPeople = allPeople ? people : people.slice(0, 3);
  const qual = qualification(intel, people);
  const noteById = new Map(intel.map(n => [n.id, n]));

  return (
    <>
      <div className="px-5 pb-4 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <AccountLogo name={name} domain={domain} size={36} />
          <div className="min-w-0 flex-1">
            {/* The account health tag beside the name (GET-807), tinted by state; it used to sit under the owners. */}
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-[18px] font-semibold tracking-[-0.015em] text-foreground">{name}</h1>
              <AccountHealthTag score={nousScore} band={nousBand} title={nousTitle} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground/70">
              {domain && <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="truncate hover:text-foreground">{domain}</a>}
              {domain && tier && <span aria-hidden className="text-border">·</span>}
              {tier && <TierMark tier={tier} label={TIER_UI[tier].label} />}
              {saving && <span className="text-[11px]">· saving…</span>}
            </div>
          </div>
        </div>

        <div className="mt-[18px] flex items-baseline gap-2">
          <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">{dealsQ.data ? money(t.pipeline) : "—"}</span>
          <span className="text-[12px] text-muted-foreground/70">open pipeline</span>
        </div>
        <div className="mt-0.5 text-[12px] tabular-nums text-muted-foreground/70">
          {t.open} open {t.open === 1 ? "deal" : "deals"}{t.wonCount > 0 ? ` · ${money(t.won)} won` : ""}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {owners.map(o => (
            <span key={o} title="Account owner" className={cn(CHIP, "pl-[3px]")}>
              <MemberAvatar name={o} size={18} />{o.split(" ")[0]}
            </span>
          ))}
          {csOwner && (
            <span title="CS owner" className={cn(CHIP, "pl-[3px]")}>
              <MemberAvatar name={csOwner} size={18} />{csOwner.split(" ")[0]}<span className="text-muted-foreground/70">CS</span>
            </span>
          )}
          <TypeChip kind={kind} />
          {kind !== "prospect" && <CrmHealthBadge score={crmScore} />}
        </div>
      </div>

      {companyId && <AccountDealsSection companyId={companyId} accountName={name} />}

      <PaneSection title="Contacts" count={people.length}>
        {people.length === 0
          ? <ListEmpty className="text-[12.5px]">No one on this account yet</ListEmpty>
          : shownPeople.map(p => (
            <PaneItem key={p.id} onClick={() => onOpenPerson(p.id)}>
              <PersonAvatar person={{ id: p.id, name: p.name }} size={24} />
              <ListText
                title={(
                  <RecordPreview kind="person" name={p.name} title={p.title} role={p.role} lastActivityAt={p.last_activity_at} signals={p.signal_count}>
                    <span>{p.name}</span>
                  </RecordPreview>
                )}
                sub={p.title ?? undefined}
                className="[&>span:first-child]:max-w-[72%] [&>span:first-child]:flex-shrink-0" />
              {p.role && ROLE_PILL[p.role] && <ListMeta className="text-[11.5px]">{ROLE_PILL[p.role]}</ListMeta>}
            </PaneItem>
          ))}
        {people.length > 3 && (
          <button type="button" onClick={() => setAllPeople(v => !v)} className="mt-0.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground">
            {allPeople ? "Show fewer" : `Show all ${people.length}`}
          </button>
        )}
      </PaneSection>

      <PaneSection title="Qualification">
        {qual.length ? qual.map(q => (
          <PropRow key={q.label} label={q.label}>
            <span className="flex flex-wrap gap-1">
              {q.tags.map(t => (
                // The claim behind the tag on hover (GET-799), in the group's colour.
                <ClaimHoverTag key={t.key} text={t.text} color={q.color} kind={q.kind} note={t.note} who={t.who}
                  extra={!t.note && t.full ? <p className="text-[13px] leading-snug text-foreground">{t.full}</p> : undefined} />
              ))}
            </span>
          </PropRow>
        )) : null}
        {decisionMakers.length > 0 && (
          // "Decision makers" (was "Who decides"): named AND unnamed roles, each with a status, so a
          // CEO nobody has met still shows up as a gap rather than vanishing (GET-800).
          <PropRow label="Decision makers">
            <span className="flex flex-col gap-1">
              {decisionMakers.map(d => {
                const st = DM_STATUS[d.status] ?? DM_STATUS.not_contacted;
                const text = d.name ?? d.title ?? "Unnamed";
                return (
                  <span key={d.key} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <ClaimHoverTag text={d.unnamed ? `${text} (not yet named)` : text} color={MEANING.violet} kind={DM_ROLE[d.role] ?? "Decision maker"}
                      note={d.evidence.map(id => noteById.get(id)).find(Boolean) ?? null}
                      extra={<p className="text-[13px] leading-snug text-foreground">{[d.name, d.title].filter(Boolean).join(", ")}{d.name || d.title ? " · " : ""}{DM_ROLE[d.role] ?? d.role} · {st.label}</p>} />
                    <span className={cn("text-[11.5px]", st.tone)}>{st.label}</span>
                  </span>
                );
              })}
            </span>
          </PropRow>
        )}
        {!qual.length && !decisionMakers.length && <p className="px-2 py-1 text-[12.5px] text-muted-foreground/60">Nothing raised yet</p>}
      </PaneSection>

      <CompanyDetailsSection co={co} domain={domain} getVal={getVal} onPatch={onPatch} />
    </>
  );
}
