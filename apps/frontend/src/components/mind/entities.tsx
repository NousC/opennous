// Shared entity types, helpers, and small components used by the standalone
// People / Companies / Integrations pages (extracted from Mind.tsx).

import { Phone, FileText, MessageSquare } from "lucide-react";
import type { IcpTier } from "@/components/mind/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContactInfo {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  pipelineStage: string;
  icpScore: number | null;
  icpTier: IcpTier | null;
  icpFit: boolean | null;
  intentScore: number | null;
  intentBand: string | null;
  seniority: string | null;
  companyId: string | null;
  companyName: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  lastActivityAt: string | null;
  dealStage: string | null;
  dealValue: number | null;
  source: string | null;
  segmentLabel: string | null;
  firstContact: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  department: string | null;
  createdAt: string | null;
  isInternal: boolean;
  /** Marked personal/network — a friend or connection, not a deal. Stays in the
   *  graph and the list; excluded from pipeline/deal logic. */
  isPersonal: boolean;
  /** The rep currently carrying this account (most recent to touch it). */
  ownerUserId: string | null;
  ownerName: string | null;
  /** Everyone in touch — more than one rep on an account is the thing worth seeing. */
  ownerMembers: { user_id: string; name: string | null }[];
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  location: string | null;
  revenueRange: string | null;
  contactCount: number;
  contacts: ContactInfo[];
  icpScore: number | null;
  intentScore: number | null;    // highest-intent person at the account (the one to act on now)
  intentBand: string | null;
  stage: string | null;          // furthest pipeline stage across the account's contacts
  lastActivityAt: string | null;
  employeeCount: number | null;
}

// Pipeline order, lowest to highest — used to pick an account's furthest stage
// and to sort the companies table by it. Terminal exits (lost/disqualified/churned)
// rank just above 'identified' so that when a company has both a dead contact and
// a live one, the live (further-along) contact wins the company's rollup stage.
export const STAGE_ORDER = ["identified", "lost", "disqualified", "churned", "aware", "connected", "interested", "evaluating", "client"];

export interface IntegrationConn {
  id: string;
  name: string;
  is_verified: boolean;
  provider: { display_name: string; logo_url?: string; category?: string; name?: string; auth_type?: string } | null;
}

export interface AuthField {
  name: string;
  label: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  description?: string;
  optional?: boolean;
}

export interface AvailableProvider {
  id: string;
  name: string;
  display_name: string;
  logo_url?: string;
  category?: string;
  description?: string;
  auth_type?: string;
  auth_fields?: AuthField[];
  // Setup metadata from workflow_providers (seeded from the provider catalogue).
  key_url?: string | null;              // deep link to where the key is issued
  key_hint?: string | null;             // the click-path in words
  webhook_mode?: "auto" | "manual" | "none" | null;
  webhook_settings_url?: string | null; // where a manual webhook gets pasted
}

export interface MemoryFact {
  id: string;
  category: string;
  content: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function healthColor(h: number | null) {
  if (h === null) return "#6b7280";
  return h >= 70 ? "#4ade80" : h >= 40 ? "#facc15" : "#f87171";
}

export function stageColor(s: string) {
  return s === "client" ? "#4ade80" : s === "evaluating" ? "#60a5fa" : s === "interested" ? "#fb923c" : s === "connected" ? "#38bdf8" : s === "aware" ? "#facc15"
    : s === "lost" ? "#f87171" : s === "disqualified" ? "#fb7185" : s === "churned" ? "#94a3b8"
    : "#9ca3af";
}

// ─── ActivityIcon ─────────────────────────────────────────────────────────────

export function ActivityIcon({ source, type }: { source: string | null; type: string }) {
  const s = (source || "").toLowerCase();
  const t = (type || "").toLowerCase();
  const logo = (src: string) => (
    <img src={src} alt="" className="w-3.5 h-3.5 rounded-sm object-contain flex-shrink-0"
      onError={e=>{(e.target as HTMLImageElement).style.display="none";}} />
  );
  // Dogfood checks first — `welcome_email_sent` contains "email", so the generic
  // email-icon check below would otherwise win and we'd render the Gmail logo.
  // `nous-mark.svg` is the brand mark; pinning a versioned filename also forces
  // a fresh download when the underlying svg gets updated.
  if (t.includes("signed_up") || t.includes("welcome_email"))     return logo("/provider-logos/nous-mark.svg");
  if (s === "stripe"          || t.includes("subscription"))      return logo("/provider-logos/stripe.svg");
  if (s === "linkedin"        || t.includes("linkedin"))          return <img src="/provider-logos/linkedin.png" alt="" className="w-3.5 h-3.5 rounded-sm object-contain flex-shrink-0" />;
  if (s === "gmail"           || s === "email" || s === "smtp" || t.includes("email")) return logo("/provider-logos/gmail.svg");
  if (s === "google_calendar" || s === "google-calendar"       || t.includes("calendar")) return logo("/provider-logos/google-calendar.svg");
  if (s === "slack"           || t.includes("slack"))             return logo("/provider-logos/slack.svg");
  if (s === "hubspot"         || t.includes("hubspot"))           return logo("/provider-logos/hubspot.svg");
  if (s === "fireflies"       || t.includes("fireflies"))         return logo("/provider-logos/fireflies.svg");
  if (s === "granola"         || t.includes("granola"))           return logo("/provider-logos/granola.svg");
  if (s === "fathom"          || t.includes("fathom"))            return logo("/provider-logos/fathom.svg");
  if (s === "calendly"        || t.includes("calendly"))          return logo("/provider-logos/calendly.svg");
  if (s === "cal_com"         || s === "cal.com" || t.includes("cal.com")) return logo("/provider-logos/cal_com.svg");
  if (s === "apollo"          || t.includes("apollo"))            return logo("/provider-logos/apollo.svg");
  if (s === "prospeo"         || t.includes("prospeo"))           return logo("/provider-logos/prospeo.svg");
  if (s === "millionverifier" || t.includes("millionverifier"))   return logo("/provider-logos/millionverifier.png");
  if (s === "neverbounce"     || t.includes("neverbounce"))       return logo("/provider-logos/neverbounce.png");
  if (t.includes("meeting")   || t.includes("call"))              return <Phone className="w-3.5 h-3.5 text-muted-foreground/45 flex-shrink-0" />;
  if (t.includes("note")      || t.includes("manual"))            return <FileText className="w-3.5 h-3.5 text-muted-foreground/45 flex-shrink-0" />;
  return <MessageSquare className="w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0" />;
}

// ─── IntegrationLogo ──────────────────────────────────────────────────────────

const LOGO_FALLBACK: Record<string, string> = {
  apollo: "/provider-logos/apollo.svg",
  "apollo.io": "/provider-logos/apollo.svg",
  gmail: "/provider-logos/gmail.svg",
  gmail_oauth: "/provider-logos/gmail.svg",
  google_calendar: "/provider-logos/google-calendar.svg",
  "google-calendar": "/provider-logos/google-calendar.svg",
  salesforce: "/provider-logos/salesforce.svg",
  linkedin: "/provider-logos/linkedin.png",
  hubspot: "/provider-logos/hubspot.svg",
  pipedrive: "/provider-logos/pipedrive.svg",
  attio: "/provider-logos/attio.svg",
  prospeo: "/provider-logos/prospeo.svg",
  apify: "/provider-logos/apify.svg",
  airtable: "/provider-logos/airtable.svg",
  slack: "/provider-logos/slack.svg",
  instantly: "/provider-logos/instantly.svg",
  rb2b: "/provider-logos/rb2b.png",
  fireflies: "/provider-logos/fireflies.svg",
  fathom: "/provider-logos/fathom.svg",
  calendly: "/provider-logos/calendly.svg",
  cal_com: "/provider-logos/cal_com.svg",
  "cal.com": "/provider-logos/cal_com.svg",
  emailbison: "/provider-logos/emailbison.png",
  heyreach: "/provider-logos/heyreach.png",
  smartlead: "/provider-logos/smartlead.png",
  millionverifier: "/provider-logos/millionverifier.png",
  neverbounce: "/provider-logos/neverbounce.png",
};

// Logos whose marks are predominantly black/dark — they need a light tile.
const DARK_LOGOS = new Set(["apollo", "cal_com", "calcom", "cal.com", "notion", "linear", "anthropic"]);

export function IntegrationLogo({ url, name, size=28 }: { url?: string; name: string; size?: number }) {
  const key = name.toLowerCase().replace(/[^a-z0-9._]/g, "");
  const src = url || LOGO_FALLBACK[key] || LOGO_FALLBACK[key.split(".")[0]];
  const isDark = DARK_LOGOS.has(key) || DARK_LOGOS.has(key.split(".")[0]);
  if (src) {
    if (isDark) {
      return (
        <div className="rounded bg-white flex items-center justify-center flex-shrink-0 border border-border/20"
          style={{ width: size, height: size }}>
          <img src={src} alt={name} className="object-contain"
            style={{ width: size * 0.7, height: size * 0.7 }}
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      );
    }
    return <img src={src} alt={name} className="rounded object-contain flex-shrink-0"
      style={{ width: size, height: size }}
      onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />;
  }
  return (
    <div className="rounded bg-muted/40 flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}>
      <span className="text-[9px] text-muted-foreground/40">{name.slice(0,2).toUpperCase()}</span>
    </div>
  );
}

// ─── DocIcon ──────────────────────────────────────────────────────────────────
// Icon for a document/note in the Notes tab. A doc pulled from a provider
// (a Fireflies transcript, a Fathom recap) shows that provider's logo; anything
// the user or an agent wrote (briefs, hand notes) falls back to the file icon.

const PLAIN_DOC_SOURCES = new Set(["", "agent", "manual", "user", "nous", "system", "signal_extraction"]);

export function DocIcon({ source }: { source?: string | null }) {
  const key = (source || "").toLowerCase().replace(/[^a-z0-9._]/g, "");
  const logo = PLAIN_DOC_SOURCES.has(key)
    ? null
    : (LOGO_FALLBACK[key] || LOGO_FALLBACK[key.split(".")[0]]);
  if (logo) {
    return <img src={logo} alt="" className="w-4 h-4 rounded-sm object-contain flex-shrink-0 mt-0.5"
      onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />;
  }
  return <FileText className="h-4 w-4 text-muted-foreground/60 flex-shrink-0 mt-0.5" />;
}

// ─── Data mapping ─────────────────────────────────────────────────────────────
// Mirrors the raw-API → view-model mapping that Mind.tsx does in loadData().

export function mapContact(c: any): ContactInfo {
  return {
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "—",
    email: c.email ?? null,
    title: c.job_title ?? null,
    pipelineStage: c.pipeline_stage ?? "identified",
    icpScore: c.icp_score ?? null,
    icpTier: c.icp_tier ?? null,
    icpFit: c.icp_fit ?? null,
    intentScore: c.intent_score ?? null,
    intentBand: c.intent_band ?? null,
    seniority: c.seniority ?? null,
    companyId: c.company_id ?? null,
    companyName: c.company ?? null,
    domain: c.domain ?? null,
    linkedinUrl: c.linkedin_url ?? null,
    lastActivityAt: c.last_activity_at ?? null,
    dealStage: c.deal_stage ?? null,
    dealValue: c.deal_value ?? null,
    source: c.source ?? null,
    segmentLabel: c.segment_label ?? null,
    firstContact: c.first_contact ?? null,
    phone: c.phone ?? null,
    city: c.city ?? null,
    country: c.country ?? null,
    department: c.department ?? null,
    createdAt: c.created_at ?? null,
    isInternal: c.is_internal === true,
    isPersonal: c.is_personal === true,
    ownerUserId: c.owner_user_id ?? null,
    ownerName: c.owner_name ?? null,
    ownerMembers: Array.isArray(c.owner_members) ? c.owner_members : [],
  };
}

export function buildCompanies(rawCompanies: any[], contacts: ContactInfo[]): Company[] {
  const byCompany = new Map<string, ContactInfo[]>();
  for (const c of contacts) {
    if (c.companyId) {
      const arr = byCompany.get(c.companyId) ?? [];
      arr.push(c);
      byCompany.set(c.companyId, arr);
    }
  }
  return (rawCompanies ?? []).map((co: any) => {
    const coContacts = byCompany.get(co.id) ?? [];
    const lastActivityAt = coContacts.reduce<string | null>((best, c) => {
      if (!c.lastActivityAt) return best;
      if (!best || c.lastActivityAt > best) return c.lastActivityAt;
      return best;
    }, null);
    const stage = coContacts.reduce<string | null>((best, c) => {
      const r = STAGE_ORDER.indexOf(c.pipelineStage);
      if (r < 0) return best;
      return best === null || r > STAGE_ORDER.indexOf(best) ? c.pipelineStage : best;
    }, null);
    // An account's ICP fit reads off its best-fitting individual — the person
    // you'd actually target. The company-level score is only a fallback for
    // accounts that have no scored contacts.
    const contactIcps = coContacts
      .map(c => c.icpScore)
      .filter((s): s is number => s != null);
    const bestContactIcp = contactIcps.length ? Math.max(...contactIcps) : null;
    // Intent rolls up max-of-people too — the account is as "hot" as its hottest
    // person (the one you'd reach out to now). The band follows that person's score.
    const intentScore = coContacts.reduce<number | null>(
      (best, c) => (c.intentScore != null && (best == null || c.intentScore > best)) ? c.intentScore : best, null);
    const intentBand = intentScore == null ? null
      : intentScore >= 85 ? 'Red-hot' : intentScore >= 70 ? 'Hot' : intentScore >= 50 ? 'Warm'
      : intentScore >= 20 ? 'Aware' : 'Dormant';
    return {
      id: co.id,
      name: co.name,
      domain: co.domain ?? null,
      industry: co.industry ?? null,
      location: co.location ?? null,
      revenueRange: co.revenue_range ?? null,
      contactCount: coContacts.length,
      contacts: coContacts,
      icpScore: bestContactIcp ?? co.icp_score ?? null,
      intentScore,
      intentBand,
      stage,
      lastActivityAt,
      employeeCount: co.employee_count ?? co.employees ?? null,
    };
  });
}
