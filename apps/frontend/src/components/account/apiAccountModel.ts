// The API plan's accounts list and record (GET-634), as data. Pure on purpose: no React, no
// aliases into the app, so the rules can be pinned by a plain `node --test`.

export type Tier = 1 | 2 | 3;

/** The ICP tier a score falls in. Same thresholds as tierFromScore in components/mind/shared.tsx. */
export function tierOf(score: number | null | undefined): Tier | null {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  if (s >= 85) return 1;
  if (s >= 70) return 2;
  if (s >= 50) return 3;
  return null;
}

export type TierTab = "all" | "t1" | "t2" | "t3";

/** How many of the loaded accounts sit in each tier. */
export function tierCounts(rows: { icpScore: number | null | undefined }[]): Record<TierTab, number> {
  const out: Record<TierTab, number> = { all: rows.length, t1: 0, t2: 0, t3: 0 };
  for (const r of rows) {
    const t = tierOf(r.icpScore);
    if (t) out[`t${t}` as TierTab]++;
  }
  return out;
}

/** The tier tabs only exist when some account is in a tier: a tab row of zeros says nothing. */
export const hasTiers = (c: Record<TierTab, number>) => c.t1 + c.t2 + c.t3 > 0;

export function inTab(score: number | null | undefined, tab: TierTab): boolean {
  if (tab === "all") return true;
  return tierOf(score) === Number(tab.slice(1));
}

export type Confidence = "High" | "Medium" | "Low";
export function confidenceOf(c: number | null | undefined): Confidence | null {
  if (c == null || Number.isNaN(Number(c))) return null;
  const n = Number(c);
  return n >= 0.8 ? "High" : n >= 0.5 ? "Medium" : "Low";
}

/** A claim value as one line. */
export function claimText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (Array.isArray(v)) return v.map(claimText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return claimText(o.value);
    return Object.values(o).map(claimText).filter(Boolean).join(", ");
  }
  return String(v).trim();
}

// The providers a fact or an activity can be traced to, as ActivityIcon names them. Anything
// else (signal_extraction, manual, agent) is how it was written, not where it came from.
const PROVIDERS = [
  "hubspot", "salesforce", "pipedrive", "attio", "gmail", "outlook", "google_calendar", "calendar",
  "linkedin", "fireflies", "fellow", "granola", "fathom", "gong", "ringcentral", "slack",
  "instantly", "smartlead", "lemlist", "heyreach", "emailbison", "stripe", "apollo", "posthog",
];
const PROVIDER_NAME: Record<string, string> = {
  hubspot: "HubSpot", gmail: "Gmail", google_calendar: "Calendar", calendar: "Calendar", linkedin: "LinkedIn",
  ringcentral: "RingCentral", heyreach: "HeyReach", emailbison: "EmailBison", posthog: "PostHog",
};
export const providerName = (p: string) => PROVIDER_NAME[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

/** Where a fact came from, when it says: the call tool, the inbox, the CRM. Null when unknown. */
export function sourceOf(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = String(c ?? "").toLowerCase().replace(/-/g, "_");
    if (!s) continue;
    const hit = PROVIDERS.find((p) => s === p || s.startsWith(`${p}:`) || s.startsWith(`${p}_`));
    if (hit) return hit;
  }
  return null;
}

export type Fact = {
  key: string;
  /** Short label on the left; empty when the fact carries none. */
  label: string;
  value: string;
  confidence: Confidence | null;
  /** When it was last observed or written. */
  at: string | null;
  /** The claim's own freshness says it is past its decay window. */
  stale: boolean;
  source: string | null;
};
export type FactGroup = { title: string; facts: Fact[] };

export type ClaimIn = {
  property: string; value: unknown; confidence?: number | null; freshness?: string | null;
  last_observed_at?: string | null;
};
export type NoteIn = {
  id: string; category?: string | null; label?: string | null; content?: string | null; source?: string | null;
  confidence?: number | null; created_at?: string | null; metadata?: Record<string, unknown> | null; intel?: boolean;
};
export type DealIn = {
  id: string; implied?: boolean; name: string; stage: string | null; status: string; value: number | null;
  currency?: string | null; close_date: string | null; last_stage_change_at?: string | null; hubspot_url?: string | null;
};

// The company's own facts, in reading order. Anything else on the entity is bookkeeping (name,
// domain, scores, stage) the header or the list already shows.
const COMPANY_PROPS: [prop: string, label: string][] = [
  ["industry", "Industry"], ["description", "What they do"], ["employee_count", "Headcount"],
  ["headcount", "Headcount"], ["location", "Location"], ["hq_location", "Location"], ["country", "Country"],
  ["revenue_range", "Revenue"], ["annual_revenue", "Revenue"], ["funding_stage", "Funding"],
  ["founded_year", "Founded"], ["tech_stack", "Current stack"],
];

/** A note is intel unless it is a document or bookkeeping (same rule as the Workspace record). */
export function isIntel(n: NoteIn): boolean {
  if (n.intel === false) return false;
  const m = (n.metadata ?? {}) as { doc_type?: string; summary?: boolean; flag?: string; signal_type?: string };
  if (m.doc_type || m.summary === true || m.flag === "speaker_name_link" || m.signal_type === "health_adoption") return false;
  return !!String(n.content ?? "").trim();
}

const money = (n: number, currency?: string | null) => {
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "31 Oct". A bare date is a calendar day, not midnight UTC, so it is read in UTC and never shifts. */
const shortDay = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const utc = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return utc ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/**
 * The record's left column: the company's facts, its open deals, then what was learned on calls and
 * email, one group per category. Nothing is invented: a fact with no confidence or source shows none.
 */
/** A CRM deal named after its account reads "Meridian Analytics · Platform"; on that account, "Platform". */
export function dealLabel(name: string, account: unknown): string {
  const a = typeof account === "string" ? account.trim() : "";
  if (!a) return name;
  const m = new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[·\\-–—:|]\\s*`, "i").exec(name);
  return m && name.length > m[0].length ? name.slice(m[0].length) : name;
}

export function factGroups(input: {
  claims?: ClaimIn[] | null;
  company?: Record<string, unknown> | null;
  notes?: NoteIn[] | null;
  deals?: DealIn[] | null;
  /** Category reading order; categories not in it sort after, alphabetically. */
  order?: string[];
  categoryName?: (c: string) => string;
  /** A person's name, for a fact with no label of its own that someone said. */
  nameOf?: (personId: string) => string | null;
}): FactGroup[] {
  const groups: FactGroup[] = [];

  // Company — from the claims when there are any, else the company row (no epistemics to show).
  const claims = new Map((input.claims ?? []).map((c) => [c.property, c]));
  const company: Fact[] = [];
  const seen = new Set<string>();
  for (const [prop, label] of COMPANY_PROPS) {
    if (seen.has(label)) continue;
    const c = claims.get(prop);
    const fromClaim = c ? claimText(c.value) : "";
    const fromRow = !fromClaim ? claimText(input.company?.[prop]) : "";
    // A year is not a quantity: "2001", never "2,001".
    const value = prop === "founded_year" ? (fromClaim || fromRow).replace(/,/g, "") : fromClaim || fromRow;
    if (!value) continue;
    seen.add(label);
    company.push({
      key: `c:${prop}`, label, value,
      confidence: fromClaim ? confidenceOf(c!.confidence) : null,
      at: fromClaim ? c!.last_observed_at ?? null : null,
      stale: fromClaim ? !!c!.freshness && c!.freshness !== "fresh" && c!.freshness !== "aging" : false,
      source: null,
    });
  }
  if (company.length) groups.push({ title: "Company", facts: company });

  // Deals — born in the CRM, so the CRM is the source and there is no confidence to give.
  const open = (input.deals ?? []).filter((d) => !d.implied && d.status === "open");
  if (open.length) {
    groups.push({
      title: open.length === 1 ? "Deal" : "Deals",
      facts: open.map((d) => ({
        key: `d:${d.id}`, label: dealLabel(d.name, input.company?.name),
        value: [
          d.value != null && d.value > 0 ? money(d.value, d.currency) : null,
          d.stage,
          d.close_date ? `closes ${shortDay(d.close_date)}` : null,
        ].filter(Boolean).join(" · ") || "Open",
        confidence: null, at: d.last_stage_change_at ?? null, stale: false,
        source: d.hubspot_url ? "hubspot" : null,
      })),
    });
  }

  // Intel — one group per category, in the record's reading order.
  const order = input.order ?? [];
  const name = input.categoryName ?? ((c: string) => c);
  const byCat = new Map<string, NoteIn[]>();
  for (const n of input.notes ?? []) {
    if (!isIntel(n)) continue;
    const cat = String(n.category || "general").toLowerCase();
    const list = byCat.get(cat) ?? [];
    list.push(n);
    byCat.set(cat, list);
  }
  const rank = (c: string) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  const cats = [...byCat.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const cat of cats) {
    const notes = byCat.get(cat)!.slice().sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    groups.push({
      title: name(cat),
      facts: notes.map((n) => {
        const m = (n.metadata ?? {}) as Record<string, unknown>;
        const voiced = typeof m.voiced_by_contact_id === "string" ? input.nameOf?.(m.voiced_by_contact_id) ?? null : null;
        const label = String(n.label ?? m.entity ?? m.speaker ?? voiced ?? "").trim();
        return {
          key: `n:${n.id}`, label, value: String(n.content ?? "").trim(),
          confidence: confidenceOf(n.confidence), at: n.created_at ?? null, stale: false,
          source: sourceOf(m.via, m.provider, m.extraction_source, m.source, n.source),
        };
      }),
    });
  }
  return groups;
}
