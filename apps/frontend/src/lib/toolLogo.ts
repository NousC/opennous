// The real tool's logo for something that came from a tool (GET-659): the Gmail mark on an email,
// Instantly on a cold-email reply, Fellow on a call summary. Null when the source is not a tool we
// have a logo for, so the caller keeps its plain kind icon.

const PNG = new Set(["fellow", "linkedin", "smartlead", "emailbison", "heyreach", "leadmagic", "rb2b", "aiark"]);
const KNOWN = new Set([
  "fellow", "fireflies", "fathom", "granola", "gmail", "google-calendar", "hubspot", "salesforce", "pipedrive",
  "attio", "close", "instantly", "smartlead", "emailbison", "lemlist", "heyreach", "linkedin", "slack", "stripe",
  "calendly", "cal_com", "notion", "apollo", "leadmagic", "rb2b", "ringcentral",
]);
const ALIAS: Record<string, string> = {
  google_calendar: "google-calendar", gcal: "google-calendar", calendar: "google-calendar",
  email: "gmail", smtp: "gmail", google: "gmail", "cal.com": "cal_com",
};

/** "/provider-logos/gmail.svg" for a tool name ("gmail", "HubSpot", "google_calendar"), else null. */
export function toolLogo(name: string | null | undefined): string | null {
  const raw = String(name ?? "").trim().toLowerCase();
  if (!raw) return null;
  const key = ALIAS[raw] ?? raw;
  return KNOWN.has(key) ? `/provider-logos/${key}.${PNG.has(key) ? "png" : "svg"}` : null;
}

/** The tool behind a source ref or link: "source://fellow/…" → fellow, "https://app.hubspot.com/…" → hubspot. */
export function toolOfRef(ref: string | null | undefined): string | null {
  const r = String(ref ?? "");
  const m = /^source:\/\/([^/]+)\//.exec(r);
  if (m) return m[1];
  const host = /^https?:\/\/(?:www\.)?([^/]+)/.exec(r)?.[1]?.toLowerCase() ?? "";
  for (const t of KNOWN) if (host.includes(t.replace("_", "").replace("-", ""))) return t;
  if (host.includes("mail.google")) return "gmail";
  return null;
}
