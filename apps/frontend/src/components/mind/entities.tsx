// Shared entity types, helpers, and small components used by the standalone
// People / Companies / Integrations pages (extracted from Mind.tsx).

import { Phone, FileText, MessageSquare } from "lucide-react";
import type { IcpTier } from "@/components/mind/shared";
import {
  ALL_PIPELINE_STAGES, TERMINAL_STAGES, OPEN_STAGES, DEFAULT_STAGE, normalizeStage, stageRank, accountStageOf,
} from "@/config/pipeline";

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
  photo: string | null;
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
  /** A CRM is connected and this person has no CRM record linked (GET-788): a meeting note-taker
   *  created them. False when linked, and when there is no CRM to be linked to. */
  notInCrm: boolean;
  /** Uses the product, per PostHog (GET-751). */
  productUser: boolean;
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
  dealValue: number | null;      // the account's deal size — max deal_value across its contacts
  dealHealth: number | null;     // company-level deal_health_score (0-100), rolled up server-side
  summary: string | null;        // memory_summary — the one-line AI description on the card
  activityCount: number;         // total interactions across the account's contacts
  meetingCount: number;          // meetings held across the account
}

// Pipeline order, lowest to highest — the canonical ladder followed by the terminal
// exits, in STAGE_RANK order. Kept exported under its old name so nothing that
// imports it breaks. This list only holds current stage names, and the DB still has
// rows on the old ones, so rank a value with stageRank() from @/config/pipeline
// (which normalizes legacy names first) rather than calling indexOf on this array.
export const STAGE_ORDER: readonly string[] = ALL_PIPELINE_STAGES;

export interface IntegrationConn {
  id: string;
  name: string;
  is_verified: boolean;
  provider: { display_name: string; logo_url?: string; category?: string; name?: string; auth_type?: string } | null;
  /** Personal (only its owner sees it) or company (shared). Decided server-side (GET-232). */
  scope?: "personal" | "company";
  owner_name?: string | null;
  is_mine?: boolean;
  /** Whether this viewer may update, test or disconnect it. */
  can_manage?: boolean;
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
  /** Personal or company source, from the API's one rule (GET-232). */
  scope?: "personal" | "company";
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

// ─── Forecast — win probability + pipeline value ─────────────────────────────
// Win probability = f(stage × ICP × intent × deal-health). Stage sets the base
// close-rate (a negotiation is far likelier than a freshly identified account); ICP
// fit, intent band, and deal health each nudge it. This turns a pile of open deals
// into a weighted forecast a revenue leader can trust. Keyed on the current stage
// names only — the lookup normalizes first, so legacy rows land on their successor.
const STAGE_BASE: Record<string, number> = {
  identified: 0.03, connected: 0.10, interested: 0.20, meeting_booked: 0.35,
  discovery: 0.45, demo: 0.60, negotiation: 0.75, closed_won: 1,
  // Decided and gone. Explicit zeroes, otherwise a dead deal falls through to the
  // 0.05 default and keeps carrying weight in the forecast.
  closed_lost: 0, disqualified: 0, churned: 0,
};
const INTENT_FACTOR: Record<string, number> = {
  "Red-hot": 1.35, Hot: 1.25, Warm: 1.1, Aware: 0.95, Dormant: 0.85,
  Expansion: 1.2, Active: 1.05, "At-risk": 0.7,
};
// Still in play — the ladder minus closed_won, terminals excluded. Re-exported from
// the canonical funnel so the pages that import it from here keep working.
export { OPEN_STAGES };

export function winProbability(c: { stage: string | null; icpScore: number | null; intentBand: string | null; dealHealth: number | null }): number {
  const base = STAGE_BASE[normalizeStage(c.stage) ?? DEFAULT_STAGE] ?? 0.05;
  const icp = c.icpScore != null ? 0.7 + (c.icpScore / 100) * 0.6 : 1;        // 0.7–1.3
  const intent = INTENT_FACTOR[c.intentBand ?? ""] ?? 1;
  const health = c.dealHealth != null ? 0.75 + (c.dealHealth / 100) * 0.45 : 1; // 0.75–1.2
  return Math.max(0.02, Math.min(0.97, base * icp * intent * health));
}

// A deal's dollar value: the real deal_value if set, else an estimate from the
// workspace's average deal size scaled by ICP fit (a better-fit account is worth
// more). Real values always override the estimate as they come in. Returns whether
// the number was estimated so the UI can mark it.
export function dealValueOrEstimate(
  c: { dealValue: number | null; icpScore: number | null }, defaultAcv: number,
): { value: number; estimated: boolean } {
  if (c.dealValue != null && c.dealValue > 0) return { value: c.dealValue, estimated: false };
  if (!defaultAcv || defaultAcv <= 0) return { value: 0, estimated: false };
  const fit = c.icpScore != null ? 0.6 + (c.icpScore / 100) * 0.8 : 1; // 0.6–1.4× by ICP fit
  return { value: Math.round(defaultAcv * fit), estimated: true };
}

// Roll a set of companies up into the pipeline forecast (open deals only). Uses the
// real deal value where set and the ACV estimate otherwise, so the forecast is never
// empty just because values haven't been entered. `health` is a v1 pipeline-health
// score: the average deal-health across the open pipeline. `estimated` = any deal
// used the estimate.
export function computeForecast(companies: Company[], defaultAcv = 0): { pipeline: number; weighted: number; deals: number; health: number | null; estimated: boolean } {
  const open = companies.filter(
    // normalizeStage first: a row still on a legacy stage ('evaluating', 'proposal')
    // is not in the new set by name and would silently drop out of the forecast.
    c => OPEN_STAGES.has(normalizeStage(c.stage) ?? DEFAULT_STAGE) && (c.contactCount > 0 || c.meetingCount > 0),
  );
  let pipeline = 0, weighted = 0, healthSum = 0, healthN = 0, estimated = false;
  for (const c of open) {
    const dv = dealValueOrEstimate(c, defaultAcv);
    if (dv.estimated && dv.value > 0) estimated = true;
    pipeline += dv.value;
    weighted += dv.value * winProbability(c);
    if (c.dealHealth != null) { healthSum += c.dealHealth; healthN++; }
  }
  return { pipeline, weighted, deals: open.length, health: healthN ? Math.round(healthSum / healthN) : null, estimated };
}

// Stage colour. The ladder runs cool → green as the deal advances, so a row of
// dots reads as progress at a glance; the terminals sit off that scale (red/rose
// for a loss, dark slate for a churn) so a dead account never looks like it is
// moving. Normalizes first, so a legacy row still gets its successor's colour
// instead of the unknown-stage grey.
const STAGE_COLOR: Record<string, string> = {
  identified: "#9ca3af",     // grey — nothing has happened yet
  connected: "#60a5fa",      // blue
  interested: "#38bdf8",     // sky
  meeting_booked: "#22d3ee", // cyan
  discovery: "#2dd4bf",      // teal
  demo: "#34d399",           // emerald
  negotiation: "#a3e635",    // lime — nearly there
  closed_won: "#4ade80",     // green
  closed_lost: "#f87171",    // red
  disqualified: "#fb7185",   // rose
  churned: "#64748b",        // dark slate — stopped, and darker than 'identified'
};

export function stageColor(s: string) {
  const stage = normalizeStage(s);
  return (stage && STAGE_COLOR[stage]) || "#9ca3af";
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
  // PostHog first (GET-751): its signup is the customer's own product, not ours.
  if (s === "posthog"         || t.includes("product_used"))      return logo("/provider-logos/posthog.svg");
  if (t.includes("signed_up") || t.includes("welcome_email"))     return logo("/provider-logos/nous-mark.svg");
  if (s === "stripe"          || t.includes("subscription"))      return logo("/provider-logos/stripe.svg");
  // Outbound-tool sources own their events before the generic email/linkedin
  // checks below — otherwise a cold-email reply (source=instantly, type=email_received)
  // falls through to the Gmail logo, and HeyReach falls through to LinkedIn.
  if (s === "instantly")                                          return logo("/provider-logos/instantly.svg");
  if (s === "smartlead")                                          return logo("/provider-logos/smartlead.png");
  if (s === "emailbison")                                         return logo("/provider-logos/emailbison.png");
  if (s === "lemlist")                                            return logo("/provider-logos/lemlist.svg");
  if (s === "heyreach")                                           return logo("/provider-logos/heyreach.png");
  if (s === "linkedin"        || t.includes("linkedin"))          return <img src="/provider-logos/linkedin.png" alt="" className="w-3.5 h-3.5 rounded-sm object-contain flex-shrink-0" />;
  if (s === "gmail"           || s === "email" || s === "smtp" || t.includes("email")) return logo("/provider-logos/gmail.svg");
  if (s === "google_calendar" || s === "google-calendar"       || t.includes("calendar")) return logo("/provider-logos/google-calendar.svg");
  if (s === "slack"           || t.includes("slack"))             return logo("/provider-logos/slack.svg");
  if (s === "hubspot"         || t.includes("hubspot"))           return logo("/provider-logos/hubspot.svg");
  if (s === "fireflies"       || t.includes("fireflies"))         return logo("/provider-logos/fireflies.svg");
  if (s === "granola"         || t.includes("granola"))           return logo("/provider-logos/granola.svg");
  if (s === "fellow"          || t.includes("fellow"))            return logo("/provider-logos/fellow.png");
  if (s === "ringcentral"     || t.includes("ringcentral"))       return logo("/provider-logos/ringcentral.svg");
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
  // The catalogue names it google_calendar; IntegrationLogo keys off the DISPLAY name,
  // so "Google Calendar" has to be here too or the card falls back to a grey monogram.
  googlecalendar: "/provider-logos/google-calendar.svg",
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
  granola: "/provider-logos/granola.svg",
  fellow: "/provider-logos/fellow.png",
  ringcentral: "/provider-logos/ringcentral.svg",
  posthog: "/provider-logos/posthog.svg",
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
    photo: c.photo_url ?? c.photo ?? null,
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
    notInCrm: c.in_crm === false,
    productUser: c.product_user === true,
    ownerUserId: c.owner_user_id ?? null,
    ownerName: c.owner_name ?? null,
    ownerMembers: Array.isArray(c.owner_members) ? c.owner_members : [],
  };
}

const TERMINAL_SET = new Set<string>(TERMINAL_STAGES);

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
    // A paged list (GET-290) arrives with its numbers already rolled up over ALL of the
    // account's people, and four faces for the avatars. Only a list that was handed every
    // contact in the workspace can compute them here — and at tens of thousands of contacts, none is.
    if (co.people_count != null) {
      // `photo` is the field every avatar reads (`photoUrl` was quietly ignored), and the email
      // comes along because a face with no photo is resolved from it (GET-312).
      const faces: ContactInfo[] = (co.people ?? []).map((p: any) => ({
        id: p.id, name: p.name, companyId: co.id,
        photo: p.photo_url ?? null, email: p.email ?? null,
      })) as ContactInfo[];
      return {
        id: co.id,
        name: co.name,
        domain: co.domain ?? null,
        industry: co.industry ?? null,
        location: co.location ?? null,
        revenueRange: co.revenue_range ?? null,
        contactCount: co.people_count ?? 0,
        contacts: faces,
        icpScore: co.best_icp_score ?? co.icp_score ?? null,
        intentScore: null,
        intentBand: null,
        stage: co.stage ?? 'identified',   // the list's stage comes from the account's deals
        lastActivityAt: co.last_activity_at ?? null,
        employeeCount: co.employee_count ?? null,
        dealValue: co.deal_value ?? null,
        dealHealth: co.deal_health_score ?? null,
        summary: co.memory_summary ?? null,
        activityCount: co.activity_count ?? 0,
        meetingCount: co.meeting_count ?? 0,
      } as Company;
    }
    const coContacts = byCompany.get(co.id) ?? [];
    const lastActivityAt = coContacts.reduce<string | null>((best, c) => {
      if (!c.lastActivityAt) return best;
      if (!best || c.lastActivityAt > best) return c.lastActivityAt;
      return best;
    }, null);
    // The account's stage = its furthest contact, by canonical rank. Terminal exits
    // now rank above the whole ladder, so a plain max would let one churned contact
    // bury an account that has someone in negotiation — pick from the live contacts
    // first and only fall back to the terminals when every contact is done. (The old
    // local list encoded that by wedging the terminals down next to 'identified';
    // the shared ranks can't, so it is spelled out here.) Rolls up the normalized
    // name, so the value is always a current stage even while the DB holds old ones.
    const stage = accountStageOf(coContacts.map(c => c.pipelineStage));
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
      // The account's deal size = the largest deal_value on any of its contacts
      // (one active deal per company, so max avoids double-counting a summed figure).
      dealValue: coContacts.reduce<number | null>(
        (best, c) => (c.dealValue != null && (best == null || c.dealValue > best)) ? c.dealValue : best, null),
      // Company-level health is rolled up server-side (seniority-weighted avg of contacts).
      dealHealth: co.deal_health_score ?? null,
      summary: co.memory_summary ?? null,
      activityCount: co.activity_count ?? 0,
      meetingCount: co.meeting_count ?? 0,
    };
  });
}
