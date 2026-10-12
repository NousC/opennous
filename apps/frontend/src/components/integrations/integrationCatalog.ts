// The API plan's Add integration dialog (GET-638): the real provider catalogue sorted into the
// rail's categories, and what each tool's detail step may say. Pure, pinned by
// tests/integrationCatalog.test.ts.
//
// The copy is deliberately thin. "What Nous reads" names only what the ingest code for that kind of
// tool actually pulls in, and "What it never does" appears only where a rule in the code holds it
// (a deal is born in the CRM; Nous never creates, edits or deletes one). Where nothing is
// demonstrable the section is left out rather than filled with a promise.

export type CatalogCategory = "mail" | "notes" | "crm" | "outbound" | "chat" | "other";
export type RailKey = "all" | CatalogCategory;

export const RAIL: { key: RailKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mail", label: "Email & calendar" },
  { key: "notes", label: "Meeting notes" },
  { key: "crm", label: "CRM" },
  { key: "outbound", label: "Outbound" },
  { key: "chat", label: "Chat" },
  { key: "other", label: "Other" },
];
export const railLabel = (k: RailKey) => RAIL.find((r) => r.key === k)?.label ?? "Other";

export type CatalogProvider = { name: string; display_name: string; category?: string | null; description?: string | null };

const MAIL = new Set(["gmail_oauth", "gmail", "google_calendar", "outlook", "outlook_oauth", "smtp", "cal_com", "calendly"]);
const CHAT = new Set(["linkedin", "slack"]);

/** Which rail category a catalogue provider sits under. */
export function catalogCategoryOf(p: CatalogProvider): CatalogCategory {
  const name = p.name.toLowerCase();
  const cat = (p.category ?? "").toLowerCase();
  if (MAIL.has(name)) return "mail";
  if (CHAT.has(name)) return "chat";
  if (cat === "meetings") return "notes";
  if (cat === "crm") return "crm";
  if (cat === "outbound") return "outbound";
  if (cat === "communication") return "chat";
  return "other";
}

/** Counts per rail key; "all" is everything. Categories with nothing are 0, not missing. */
export function railCounts(ps: CatalogProvider[]): Record<RailKey, number> {
  const out = { all: ps.length, mail: 0, notes: 0, crm: 0, outbound: 0, chat: 0, other: 0 } as Record<RailKey, number>;
  for (const p of ps) out[catalogCategoryOf(p)] += 1;
  return out;
}

/** "All" lists the tools in the rail's order (email first, the rest last), stable within each. */
export function sortByRail<T extends CatalogProvider>(ps: T[]): T[] {
  const rank = (p: T) => RAIL.findIndex((r) => r.key === catalogCategoryOf(p));
  return ps.map((p, i) => [p, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
}

export function matchesSearch(p: CatalogProvider, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return p.display_name.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
    || railLabel(catalogCategoryOf(p)).toLowerCase().includes(needle);
}

/** What Nous reads from this tool, as short lines. Empty when we can't say. */
export function readsFor(p: CatalogProvider): string[] {
  const name = p.name.toLowerCase();
  const cat = (p.category ?? "").toLowerCase();
  if (name === "gmail_oauth" || name === "gmail" || name === "outlook" || name === "outlook_oauth") return ["Email threads in the mailbox you connect"];
  if (name === "google_calendar") return ["Meetings on the calendar you connect"];
  if (name === "smtp") return ["Incoming mail in the mailbox you connect"];
  if (name === "cal_com" || name === "calendly") return ["Bookings and cancellations"];
  if (name === "linkedin") return ["Messages on the LinkedIn account you connect"];
  if (name === "stripe") return ["Payments, from the webhook you add in Stripe"];
  if (name === "nous") return ["Signups and subscription events from your own product"];
  if (cat === "meetings") return ["Meeting transcripts and summaries"];
  if (cat === "crm") return ["Companies, contacts and deals"];
  if (cat === "outbound") return ["Campaign replies and activity"];
  if (cat === "enrichment") return ["Contact data, looked up with your key when Nous enriches"];
  if (cat === "verification") return ["Email validity, checked with your key"];
  return [];
}

/** The one thing this tool's connection never does, where the code guarantees it; else null. */
export function neverFor(p: CatalogProvider): string | null {
  const cat = (p.category ?? "").toLowerCase();
  if (cat === "crm") return "Never creates, edits or deletes a deal";
  return null;
}

/** The tile's one line: the catalogue's own description, else what it reads, else its category. */
export function tileLine(p: CatalogProvider): string {
  return p.description?.trim() || readsFor(p)[0] || railLabel(catalogCategoryOf(p));
}
