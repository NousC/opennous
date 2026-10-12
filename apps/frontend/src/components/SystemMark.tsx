// The mark of the system a source came from, shared by the chat's source panel and a page's
// Evidence panel (GET-197) — one definition, so a Fireflies call looks the same in both.
import { Mail, Settings2, Upload, User } from "lucide-react";
import { cn } from "@/lib/utils";

// The real logo of every system we can pull from — you should recognise where a
// fact came from before you've read a word of it. Falls back to a lucide glyph
// for the things that have no brand (an import, a manual note, Nous itself).
export const SYSTEM_LOGOS: Record<string, string> = {
  Gmail:      "/provider-logos/gmail.svg",
  Calendar:   "/provider-logos/google.svg",
  LinkedIn:   "/provider-logos/linkedin.png",
  Slack:      "/provider-logos/slack.svg",
  Fireflies:  "/provider-logos/fireflies.svg",
  Fathom:     "/provider-logos/fathom.svg",
  Granola:    "/provider-logos/granola.svg",
  Fellow:     "/provider-logos/fellow.png",
  RingCentral: "/provider-logos/ringcentral.svg",
  HubSpot:    "/provider-logos/hubspot.svg",
  Salesforce: "/provider-logos/salesforce.svg",
  Attio:      "/provider-logos/attio.svg",
  Pipedrive:  "/provider-logos/pipedrive.svg",
  Close:      "/provider-logos/close.svg",
  Apollo:     "/provider-logos/apollo.svg",
  Instantly:  "/provider-logos/instantly.svg",
  Smartlead:  "/provider-logos/smartlead.png",
  HeyReach:   "/provider-logos/heyreach.png",
  Lemlist:    "/provider-logos/lemlist.svg",
  RB2B:       "/provider-logos/rb2b.png",
  Calendly:   "/provider-logos/calendly.svg",
  "Cal.com":  "/provider-logos/cal_com.svg",
  Notion:     "/provider-logos/notion.svg",
  Airtable:   "/provider-logos/airtable.svg",
  // Nous derived it rather than observing it — our own mark. Use the current
  // brand logo the app chrome uses (/nous-logo.svg), not the old exported mark.
  Nous:       "/nous-logo.svg",
  Agent:      "/nous-logo.svg",
};

const SYSTEM_GLYPHS: Record<string, { icon: typeof Mail; color: string }> = {
  Import:  { icon: Upload,    color: "text-muted-foreground" },
  CSV:     { icon: Upload,    color: "text-muted-foreground" },
  Manual:  { icon: User,      color: "text-muted-foreground" },
  System:  { icon: Settings2, color: "text-muted-foreground" },
};

// What KIND of record a source is, in plain words, so a citation reads like one —
// "Call · Fathom", "Email · Gmail" — instead of just a logo and a raw snippet.
// Inferred from the system; a good-enough default that makes the panel read the
// way a person would say where a fact came from.
const EVIDENCE_KIND: Record<string, string> = {
  Fireflies: "Call", Fathom: "Call", Granola: "Call", Fellow: "Call", RingCentral: "Phone call",
  Gmail: "Email",
  LinkedIn: "LinkedIn message",
  Slack: "Slack message",
  Calendar: "Meeting",
  HubSpot: "CRM record", Salesforce: "CRM record", Attio: "CRM record",
  Pipedrive: "CRM record", Close: "CRM record",
  Apollo: "Enrichment", Instantly: "Campaign", Smartlead: "Campaign",
  HeyReach: "Campaign", Lemlist: "Campaign", RB2B: "Website visit",
  Calendly: "Booking", "Cal.com": "Booking",
  Notion: "Note", Airtable: "Record",
  Nous: "Recorded by Nous", Agent: "Recorded by Nous",
  Import: "Imported", CSV: "Imported", Manual: "Manual note", System: "System",
};
export const evidenceKind = (system: string) => EVIDENCE_KIND[system] ?? system;

/** One system's mark, at a given size. */
export function SystemMark({ system, className = "h-3.5 w-3.5" }: { system: string; className?: string }) {
  const logo = SYSTEM_LOGOS[system];
  if (logo) return <img src={logo} alt="" className={cn(className, "object-contain")} />;
  // An import, a manual note, or a CSV keeps its own glyph. Everything else with
  // no upstream logo (Onboarding, a recorded foundation, anything Nous derived
  // itself) is ours — show the Nous mark, never a blank circle.
  const glyph = SYSTEM_GLYPHS[system];
  if (!glyph) return <img src="/nous-logo.svg" alt="" className={cn(className, "object-contain")} />;
  const { icon: Icon, color } = glyph;
  return <Icon className={cn(className, color)} />;
}

/** The small marks shown inline in the collapsed summary. */
export function SystemMarks({ systems }: { systems: string[] }) {
  return (
    <span className="inline-flex items-center -space-x-1 mr-0.5">
      {systems.slice(0, 5).map(sys => (
        <span key={sys} title={sys}
          className="inline-flex items-center justify-center h-[18px] w-[18px] rounded-full border border-border bg-background">
          <SystemMark system={sys} className="h-2.5 w-2.5" />
        </span>
      ))}
    </span>
  );
}
