import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Webhook, Copy, Check, Info, ArrowRight, ExternalLink, ChevronDown, AlertTriangle, Plus, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/ui/page-header";
import { useApiTopBar } from "@/components/shell/apiTopBarContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ListCard, ListEmpty, ListHeader, ListAction, ListText, ListTile, listRowClass } from "@/components/ui/list";
import { ApiWebhooks, CopyField } from "@/components/webhooks/ApiWebhooks";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type WebhookStatus = "live" | "stale" | "pending";

interface WebhookUrl {
  source: string;
  url: string;
  auto_registered?: boolean;
  last_event_at?: string | null;
  status?: WebhookStatus;
  // Server-computed: is this webhook in play (connected / registered / has events /
  // added by hand)? Only active ones show on the page; the rest populate "Add".
  active?: boolean;
  // Purely user-added (removable), vs. backed by a live integration.
  manual?: boolean;
}

// Nicer labels for the few sources whose slug doesn't title-case cleanly.
const SOURCE_LABELS: Record<string, string> = {
  cal_com: "Cal.com",
  rb2b: "RB2B",
  emailbison: "EmailBison",
  heyreach: "HeyReach",
  linkedin: "LinkedIn",
};
const label = (s: string) => SOURCE_LABELS[s] ?? s.replace(/_/g, " ");

// ─── Provider logo ──────────────────────────────────────────────────────────
// Listing PNG sources explicitly avoids a wasted .svg request that 404s on
// every page load.
const PNG_SOURCES = new Set(["emailbison", "heyreach", "smartlead", "rb2b", "linkedin", "aiark", "leadmagic"]);

function ProviderLogo({ source, size = 8 }: { source: string; size?: number }) {
  const initialExt = PNG_SOURCES.has(source) ? "png" : "svg";
  const [src, setSrc] = useState(`/provider-logos/${source}.${initialExt}`);
  // 4 = bare, inside a ListTile; 5 = the 20px tile of the inbound card, 8 = list rows, 10 = the guide sheet.
  const bare = size === 4;
  const tile = bare ? "w-6 h-6" : size === 5 ? "w-5 h-5 rounded-md" : size === 8 ? "w-8 h-8 rounded-lg" : "w-10 h-10 rounded-xl";
  const inner = bare ? "w-3.5 h-3.5" : size === 5 ? "w-3.5 h-3.5" : size === 8 ? "w-5 h-5" : "w-6 h-6";
  const icon  = bare ? "h-3 w-3" : size === 5 ? "h-3 w-3" : size === 8 ? "h-4 w-4" : "h-5 w-5";
  return (
    <div className={cn("relative flex flex-shrink-0 items-center justify-center overflow-hidden", tile, bare ? "bg-card" : "bg-muted/50 border border-border/60")}>
      <Webhook className={`${icon} text-muted-foreground/50`} strokeWidth={1.75} />
      <img
        src={src}
        alt=""
        className={cn("absolute inset-0 m-auto object-contain", inner, bare ? "bg-card" : "bg-muted/50")}
        onError={e => {
          if (src.endsWith(".svg"))      setSrc(`/provider-logos/${source}.png`);
          else if (src.endsWith(".png")) setSrc(`/provider-logos/${source}.svg`);
          else (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    </div>
  );
}

// ─── Time formatting ────────────────────────────────────────────────────────

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "no events yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "no events yet";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60)  return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30)  return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusTip(status?: WebhookStatus, lastEventAt?: string | null): string {
  const sub = formatRelative(lastEventAt);
  return status === "live"
    ? `Last event received ${sub}. Webhook is wired up.`
    : status === "stale"
    ? `Last event was ${sub}. The webhook may have been disabled on the provider side. Check the integration.`
    : "No events received yet. If you just set this up, send a test event from the provider to confirm.";
}

function StatusPill({ status, lastEventAt }: { status?: WebhookStatus; lastEventAt?: string | null }) {
  const cfg = status === "live"
    ? { dot: "bg-emerald-500",         text: "text-emerald-700",         bg: "bg-emerald-50", border: "border-emerald-200", label: "Live"    }
    : status === "stale"
    ? { dot: "bg-amber-500",           text: "text-amber-700",           bg: "bg-amber-50",   border: "border-amber-200",   label: "Stale"   }
    : { dot: "bg-muted-foreground/40", text: "text-muted-foreground/80", bg: "bg-muted/40",   border: "border-border",      label: "Pending" };
  const sub = formatRelative(lastEventAt);
  const tooltip = status === "live"
    ? `Last event received ${sub}. Webhook is wired up.`
    : status === "stale"
    ? `Last event was ${sub} — webhook may have been disabled on the provider side. Check the integration.`
    : "No events received yet. If you just set this up, send a test event from the provider to confirm.";
  return (
    <span title={tooltip}
      className={`flex-shrink-0 inline-flex items-center gap-1.5 h-7 px-2 rounded-md border ${cfg.bg} ${cfg.border} ${cfg.text} text-[11px] font-semibold`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label} · {sub}
    </span>
  );
}

// ─── Per-source setup guide config ──────────────────────────────────────────
// Add new providers here as their integrations stabilise. Each guide tells the
// user (a) whether Nous wires the webhook automatically or expects a paste,
// (b) exactly which provider events we listen for and what they become inside
// Nous, (c) which events we deliberately skip and why, and (d) how to add more
// events manually if their setup is non-default.

type WebhookMode = "auto" | "paste";

interface EventMapping {
  source_event: string;
  nous_activity: string;
}

interface SkippedEvent {
  event: string;
  reason: string;
}

interface ManualConfig {
  intro: string;
  steps: string[];
}

interface WebhookGuide {
  mode: WebhookMode;
  modeNote: string;
  events: EventMapping[];
  skipped?: SkippedEvent[];
  skippedExplainer?: string;
  manualConfig?: ManualConfig;
  docsUrl?: string;
}

const WEBHOOK_GUIDES: Record<string, WebhookGuide> = {
  // ─── Auto-registered ──────────────────────────────────────────────────────

  linkedin: {
    mode: "auto",
    modeNote: "Set up automatically through your LinkedIn (Unipile) connection. Nothing for you to do here.",
    events: [
      { source_event: "message_received", nous_activity: "linkedin_message_received" },
      { source_event: "new_relation",     nous_activity: "linkedin_connection_accepted" },
    ],
    docsUrl: "https://docs.opennous.cloud/providers/linkedin",
  },

  calendly: {
    mode: "auto",
    modeNote: "Set up automatically when you connected. Nothing for you to do here.",
    events: [
      { source_event: "invitee.created",  nous_activity: "meeting_scheduled" },
      { source_event: "invitee.canceled", nous_activity: "meeting_cancelled" },
    ],
    docsUrl: "https://docs.opennous.cloud/providers/calendly",
  },

  cal_com: {
    mode: "auto",
    modeNote: "Set up automatically when you connected. Nothing for you to do here.",
    events: [
      { source_event: "BOOKING_CREATED",     nous_activity: "meeting_scheduled" },
      { source_event: "BOOKING_CANCELLED",   nous_activity: "meeting_cancelled" },
      { source_event: "BOOKING_RESCHEDULED", nous_activity: "meeting_rescheduled" },
    ],
    docsUrl: "https://docs.opennous.cloud/providers/cal-com",
  },

  granola: {
    mode: "auto",
    modeNote: "Set up automatically from your Granola key when you connected. Granola only offers webhooks on Business and Enterprise plans; your notes are also imported every 15 minutes as a backup.",
    events: [
      { source_event: "note.generated",      nous_activity: "meeting_held" },
      { source_event: "note.edited",         nous_activity: "meeting_held" },
      { source_event: "note.access_granted", nous_activity: "meeting_held" },
    ],
  },

  heyreach: {
    mode: "auto",
    modeNote: "Set up automatically when you connected. Nothing for you to do here.",
    events: [
      { source_event: "CONNECTION_REQUEST_SENT", nous_activity: "linkedin_connection_sent" },
      { source_event: "MESSAGE_SENT",            nous_activity: "linkedin_message_sent" },
      { source_event: "INMAIL_SENT",             nous_activity: "linkedin_message_sent" },
      { source_event: "FOLLOW_SENT",             nous_activity: "linkedin_follow_sent" },
      { source_event: "LIKED_POST",              nous_activity: "linkedin_like" },
      { source_event: "VIEWED_PROFILE",          nous_activity: "linkedin_profile_view" },
      { source_event: "CAMPAIGN_COMPLETED",      nous_activity: "campaign_completed" },
      { source_event: "LEAD_TAG_UPDATED",        nous_activity: "tag_updated" },
    ],
    docsUrl: "https://docs.opennous.cloud/providers/heyreach",
  },

  // ─── Paste-required ───────────────────────────────────────────────────────

  emailbison: {
    mode: "paste",
    modeNote: "EmailBison doesn't expose a webhook-registration API, so the URL below has to be pasted into EmailBison once.",
    events: [
      { source_event: "REPLY_RECEIVED",   nous_activity: "email_received" },
      { source_event: "EMAIL_REPLIED",    nous_activity: "email_received" },
      { source_event: "INTERESTED",       nous_activity: "email_received" },
      { source_event: "EMAIL_SENT",       nous_activity: "email_sent" },
      { source_event: "EMAIL_OPENED",     nous_activity: "email_opened" },
      { source_event: "EMAIL_CLICKED",    nous_activity: "email_opened" },
      { source_event: "EMAIL_BOUNCED",    nous_activity: "email_bounced" },
      { source_event: "UNSUBSCRIBED",     nous_activity: "email_bounced" },
    ],
    manualConfig: {
      intro: "Configure the webhook once in EmailBison and every event from then on flows automatically:",
      steps: [
        "Open EmailBison → Settings → Webhooks → New Webhook URL",
        "Paste the webhook URL shown above",
        "Select the events you want (recommended: all of them — see the table)",
        "Save the webhook",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/emailbison",
  },

  smartlead: {
    mode: "paste",
    modeNote: "Smartlead webhooks can be set up globally for your workspace or scoped to a single campaign. Pick whichever fits your setup.",
    events: [
      { source_event: "EMAIL_REPLIED",         nous_activity: "email_received" },
      { source_event: "EMAIL_SENT",            nous_activity: "email_sent" },
      { source_event: "EMAIL_OPENED",          nous_activity: "email_opened" },
      { source_event: "EMAIL_CLICKED",         nous_activity: "email_opened" },
      { source_event: "EMAIL_BOUNCED",         nous_activity: "email_bounced" },
      { source_event: "LEAD_UNSUBSCRIBED",     nous_activity: "email_bounced" },
      { source_event: "LEAD_CATEGORY_UPDATED", nous_activity: "lead_category_updated" },
    ],
    manualConfig: {
      intro: "The simplest setup is to add one webhook per campaign — Smartlead also supports a workspace-wide webhook if you'd rather:",
      steps: [
        "Open the campaign you want to track in Smartlead",
        "Go to Settings → Webhooks → Add Webhook",
        "Paste the webhook URL shown above",
        "Tick the events you want (recommended: all of them)",
        "Save, then repeat for every other campaign you want signals from",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/smartlead",
  },

  lemlist: {
    mode: "auto",
    modeNote: "Set up automatically when you connected. Nothing for you to do here.",
    events: [
      // Email
      { source_event: "emailsSent",         nous_activity: "email_sent" },
      { source_event: "emailsOpened",       nous_activity: "email_opened" },
      { source_event: "emailsClicked",      nous_activity: "email_opened" },
      { source_event: "emailsReplied",      nous_activity: "email_received" },
      { source_event: "emailsInterested",   nous_activity: "email_received" },
      { source_event: "emailsBounced",      nous_activity: "email_bounced" },
      { source_event: "emailsFailed",       nous_activity: "email_bounced" },
      { source_event: "emailsUnsubscribed", nous_activity: "email_bounced" },
      // LinkedIn (outbound only)
      { source_event: "linkedinSent",             nous_activity: "linkedin_message_sent" },
      { source_event: "linkedinOpened",           nous_activity: "linkedin_message_opened" },
      { source_event: "linkedinInviteDone",       nous_activity: "linkedin_connection_sent" },
      { source_event: "linkedinFollowDone",       nous_activity: "linkedin_follow_sent" },
      { source_event: "linkedinVisitDone",        nous_activity: "linkedin_profile_view" },
      { source_event: "linkedinLikeLastPostDone", nous_activity: "linkedin_like" },
      { source_event: "linkedinVoiceNoteDone",    nous_activity: "linkedin_message_sent" },
      // Lifecycle
      { source_event: "campaignComplete",         nous_activity: "campaign_completed" },
    ],
    skipped: [
      { event: "linkedinReplied",        reason: "Native LinkedIn integration already logs this" },
      { event: "linkedinInviteAccepted", reason: "Native LinkedIn integration already logs this" },
    ],
    skippedExplainer: "These events fire when a reply or accept lands in your LinkedIn inbox. Native LinkedIn (Unipile) is already the source of truth for them — subscribing via Lemlist too would log every reply twice on the contact timeline.",
    manualConfig: {
      intro: "Set up the webhook once in Lemlist and every event flows in automatically:",
      steps: [
        "Open Lemlist → Settings → Integrations → Webhooks",
        "Click Add Webhook",
        "Paste the webhook URL shown above into Target URL",
        "Select the events you want (recommended: the email and LinkedIn outbound events)",
        "Optionally set a secret — Lemlist will echo it back in every delivery for verification",
        "Save",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/lemlist",
  },

  instantly: {
    mode: "paste",
    modeNote: "Configure the webhook once in Instantly's settings and every event from then on flows automatically.",
    events: [
      { source_event: "reply_received", nous_activity: "email_received" },
      { source_event: "email_replied",  nous_activity: "email_received" },
      { source_event: "email_sent",     nous_activity: "email_sent" },
      { source_event: "email_opened",   nous_activity: "email_opened" },
      { source_event: "email_bounced",  nous_activity: "email_bounced" },
      { source_event: "unsubscribed",   nous_activity: "email_bounced" },
    ],
    manualConfig: {
      intro: "Add the webhook in Instantly's webhook settings:",
      steps: [
        "Open Instantly → Settings → Integrations → Webhooks",
        "Click Add Webhook",
        "Paste the webhook URL shown above",
        "Select the events you want (recommended: all of them)",
        "Save the webhook",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/instantly",
  },

  fireflies: {
    mode: "paste",
    modeNote: "Fireflies pushes transcripts via webhook once a meeting finishes. Paste the URL below into your Fireflies notebook integrations.",
    events: [
      { source_event: "transcript_ready", nous_activity: "meeting_held" },
    ],
    manualConfig: {
      intro: "Set up the webhook once in Fireflies and every recorded meeting flows in automatically:",
      steps: [
        "Open Fireflies → Settings → Developer Settings → Webhook",
        "Paste the webhook URL shown above",
        "Toggle the webhook on and save",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/fireflies",
  },

  fathom: {
    mode: "paste",
    modeNote: "Fathom pushes recordings via webhook once the meeting summary is ready. Paste the URL below into Fathom's integrations.",
    events: [
      { source_event: "meeting_ready", nous_activity: "meeting_held" },
    ],
    manualConfig: {
      intro: "Set up the webhook once in Fathom and every recorded meeting flows in automatically:",
      steps: [
        "Open Fathom → Settings → Integrations → Webhooks",
        "Click Add Webhook",
        "Paste the webhook URL shown above",
        "Save",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/fathom",
  },

  rb2b: {
    mode: "paste",
    modeNote: "RB2B pushes de-anonymised website visitors to a webhook. Paste the URL below into your RB2B destination settings.",
    events: [
      { source_event: "visitor_identified", nous_activity: "website_visit" },
    ],
    manualConfig: {
      intro: "RB2B sends one event per identified visitor. Set it up once:",
      steps: [
        "Open RB2B → Destinations → Add Destination → Webhook",
        "Paste the webhook URL shown above",
        "Save",
      ],
    },
    docsUrl: "https://docs.opennous.cloud/providers/rb2b",
  },
};

// ─── Guide sheet ────────────────────────────────────────────────────────────

function WebhookGuideSheet({
  source,
  url,
  open,
  onOpenChange,
}: {
  source: string | null;
  url: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const guide = source ? WEBHOOK_GUIDES[source] : null;
  const niceSource = source ? source.replace(/_/g, " ") : "";
  // Auto-registered providers default to the slim "you're done" view;
  // expanding reveals URL + event mapping for the curious.
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => { setShowDetails(false); }, [source]);

  const eventsTable = guide && (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2">
        Events Nous listens for <span className="text-muted-foreground/50 font-normal">({guide.events.length})</span>
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        {guide.events.map((e, i) => (
          <div key={e.source_event}
            className={`flex items-center gap-2 px-3 py-2 text-[12px] ${i > 0 ? "border-t border-border/60" : ""}`}>
            <Check className="h-3 w-3 text-emerald-600 flex-shrink-0" />
            <code className="font-mono text-foreground/80 flex-shrink-0">{e.source_event}</code>
            <ArrowRight className="h-3 w-3 text-muted-foreground/50 mx-1 flex-shrink-0" />
            <code className="font-mono text-muted-foreground/80 truncate">{e.nous_activity}</code>
          </div>
        ))}
      </div>
    </div>
  );

  const webhookUrlBlock = (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-1.5">Webhook URL</div>
      <code className="block text-[11px] font-mono break-all px-3 py-2 rounded-lg border border-border bg-muted/30">{url}</code>
    </div>
  );

  const docsLink = guide?.docsUrl && (
    <a href={guide.docsUrl} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground/70 hover:text-foreground transition-colors">
      Read full docs <ExternalLink className="h-3 w-3" />
    </a>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg w-full overflow-y-auto p-0">
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <SheetHeader className="text-left space-y-3">
            <div className="flex items-center gap-3">
              {source && <ProviderLogo source={source} size={10} />}
              <div>
                <SheetTitle className="text-[16px] font-bold capitalize">{niceSource}</SheetTitle>
                <SheetDescription className="text-[12px] text-muted-foreground/80">
                  Webhook setup
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="px-6 py-5 space-y-6">
          {!guide ? (
            <>
              <div className="rounded-lg border border-dashed border-border p-4">
                <p className="text-[13px] font-medium text-foreground/80 mb-1">Setup guide coming soon</p>
                <p className="text-[12px] text-muted-foreground/70">
                  Paste the URL below into the provider's webhook settings — Nous will route incoming events automatically.
                </p>
              </div>
              {webhookUrlBlock}
            </>
          ) : guide.mode === "auto" ? (
            /* AUTO-REGISTERED — slim view: just confirmation. Details on demand. */
            <>
              <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-4">
                <div className="text-[13px] font-semibold mb-1 flex items-center gap-1.5 text-emerald-700">
                  <Check className="h-4 w-4" /> Set up — nothing to do here
                </div>
                <p className="text-[12px] leading-relaxed text-emerald-800/90">{guide.modeNote}</p>
              </div>

              <button onClick={() => setShowDetails(v => !v)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown className={`h-3 w-3 transition-transform ${showDetails ? "rotate-180" : ""}`} />
                {showDetails ? "Hide details" : "Show details"}
              </button>

              {showDetails && (
                <div className="space-y-5 pt-1">
                  {webhookUrlBlock}
                  {eventsTable}
                </div>
              )}

              {docsLink}
            </>
          ) : (
            /* PASTE-REQUIRED — full guide: status, URL, events, skipped, manual steps. */
            <>
              <div className="rounded-lg border bg-amber-50 border-amber-200 p-4">
                <div className="text-[12px] font-semibold mb-1 flex items-center gap-1.5 text-amber-700">
                  <Info className="h-3.5 w-3.5" /> Paste required
                </div>
                <p className="text-[12px] leading-relaxed text-amber-800/90">{guide.modeNote}</p>
              </div>

              {webhookUrlBlock}
              {eventsTable}

              {guide.skipped && guide.skipped.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2">
                    Events Nous skips <span className="text-muted-foreground/50 font-normal">({guide.skipped.length})</span>
                  </div>
                  <div className="rounded-lg border border-border overflow-hidden mb-2">
                    {guide.skipped.map((s, i) => (
                      <div key={s.event}
                        className={`flex items-start gap-2 px-3 py-2 text-[12px] ${i > 0 ? "border-t border-border/60" : ""}`}>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="w-3 inline-block text-center text-muted-foreground/40">·</span>
                          <code className="font-mono text-muted-foreground/80">{s.event}</code>
                        </div>
                        <span className="text-muted-foreground/60 text-[11px] ml-auto">{s.reason}</span>
                      </div>
                    ))}
                  </div>
                  {guide.skippedExplainer && (
                    <p className="text-[12px] text-muted-foreground/70 leading-relaxed">{guide.skippedExplainer}</p>
                  )}
                </div>
              )}

              {guide.manualConfig && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2">
                    Add events manually
                  </div>
                  <p className="text-[12px] text-muted-foreground/70 mb-2.5 leading-relaxed">{guide.manualConfig.intro}</p>
                  <ol className="space-y-1.5 list-decimal list-inside text-[12px] text-foreground/80 marker:text-muted-foreground/60">
                    {guide.manualConfig.steps.map((step, i) => (
                      <li key={i} className="leading-relaxed">{step}</li>
                    ))}
                  </ol>
                </div>
              )}

              {docsLink}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Your tools (every plan's Webhooks page) ─────────────────────────────────
// The tools that push events INTO Nous (GET-675): one row per tool with whether events are
// flowing; opening a row shows that tool's inbound URL and its own setup steps, the way the
// endpoint rows open to their deliveries. Replaces the old "Inbound webhooks" card (one tool at a
// time) and the "From your tools" list with its long URLs.

const STATUS_WORD: Record<WebhookStatus, { label: string; cls: string }> = {
  live:    { label: "Live",    cls: "text-positive" },
  stale:   { label: "Stale",   cls: "text-warning" },
  pending: { label: "Pending", cls: "text-muted-foreground/70" },
};

function ToolRow({ w, open, onOpenChange, copied, busy, onCopy, onGuide, onRemove }: {
  w: WebhookUrl; open: boolean; onOpenChange: (open: boolean) => void;
  copied: boolean; busy: boolean;
  onCopy: () => void; onGuide: () => void; onRemove: () => void;
}) {
  const status = STATUS_WORD[w.status ?? "pending"];
  const name = label(w.source).replace(/^\w/, (c) => c.toUpperCase());
  // Opens to the URL alone (GET-676): no step-by-step text; the guide sheet stays one click away.
  const panelId = `wh-tool-${w.source}`;
  const toggle = () => onOpenChange(!open);
  return (
    <div className={cn("rounded-lg transition-colors duration-fast", open && "bg-hover/40")}>
      <div className={cn(listRowClass, "cursor-pointer", open && "hover:bg-transparent")} onClick={toggle}>
        <ListTile><ProviderLogo source={w.source} size={4} /></ListTile>
        <button type="button" aria-expanded={open} aria-controls={panelId}
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListText
            titleClassName="flex-shrink-0"
            title={name}
            sub={w.auto_registered ? <span title="Nous registered this webhook with the provider for you.">Set up for you</span> : undefined}
          />
        </button>
        <span title={statusTip(w.status, w.last_event_at)} className="flex-shrink-0 whitespace-nowrap text-[12px] tabular-nums">
          <span className={status.cls}>{status.label}</span>
          {w.last_event_at && <span className="text-muted-foreground/70"> · {formatRelative(w.last_event_at)}</span>}
        </span>
        <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50 transition-transform duration-fast", open && "rotate-180")} />
      </div>

      {open && (
        <div id={panelId} className="pb-3 pl-2 pr-2 pt-1 sm:pl-[42px]">
          <div className="max-w-[640px]">
            <div className="min-w-0 space-y-2">
              <CopyField id={`in-url-${w.source}`} label="Inbound URL" value={w.url}
                copied={copied} onCopy={onCopy} copyLabel={`Copy ${name} inbound URL`} />
              <div className="-ml-2 flex flex-wrap items-center gap-1">
                <ListAction onClick={onGuide} className="opacity-100">Events and docs</ListAction>
                {w.manual && (
                  <ListAction onClick={onRemove} disabled={busy} className="opacity-100 hover:text-risk">Remove</ListAction>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolsCard({ loading, rows, add, copied, busy, onCopy, onGuide, onRemove }: {
  loading: boolean; rows: WebhookUrl[]; add: ReactNode;
  copied: string | null; busy: string | null;
  onCopy: (url: string, source: string) => void; onGuide: (source: string) => void; onRemove: (source: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A feed that should be flowing and has gone quiet opens itself once, so its URL and steps are
  // right there to check. A never-connected tool being pending is not a problem.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const quiet = rows.filter((w) => w.status === "stale" && (w.auto_registered || w.last_event_at) && !seen.current.has(w.source));
    if (quiet.length === 0) return;
    quiet.forEach((w) => seen.current.add(w.source));
    setOpen((cur) => new Set([...cur, ...quiet.map((w) => w.source)]));
  }, [rows]);
  const setRowOpen = (source: string, v: boolean) =>
    setOpen((cur) => { const next = new Set(cur); if (v) next.add(source); else next.delete(source); return next; });
  return (
    <ListCard>
      <ListHeader title="Webhooks" count={loading && rows.length === 0 ? null : rows.length} right={add} className="items-center" />
      {loading && rows.length === 0 ? (
        <div className="space-y-1 p-1">{[0, 1].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />)}</div>
      ) : rows.length === 0 ? (
        <ListEmpty>Connect an integration and its webhook shows up here.</ListEmpty>
      ) : (
        rows.map((w) => (
          <ToolRow key={w.source} w={w}
            open={open.has(w.source)} onOpenChange={(v) => setRowOpen(w.source, v)}
            copied={copied === w.source} busy={busy === w.source}
            onCopy={() => onCopy(w.url, w.source)} onGuide={() => onGuide(w.source)} onRemove={() => onRemove(w.source)} />
        ))
      )}
    </ListCard>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

// Rendered as its own page at /webhooks, and embedded as a tab inside Settings. When
// embedded, the outer page shell (full-height scroll + padding) is dropped so it flows
// inside the Settings scroll container instead of nesting a second one.
export default function Webhooks({ embedded = false }: { embedded?: boolean } = {}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  // The Webhooks page (GET-632): outbound endpoints with their delivery log, then inbound. Every
  // plan's page since GET-660; embedded somewhere else it stays the list below.
  const apiPage = !embedded;

  const [urls, setUrls] = useState<WebhookUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [guideSource, setGuideSource] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busySource, setBusySource] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/webhooks/urls?workspaceId=${encodeURIComponent(workspaceId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUrls(res.ok ? (await res.json()).urls ?? [] : []);
    } catch {
      setUrls([]);
    } finally { setLoading(false); }
  }, [token, workspaceId]);
  useApiTopBar({ onRefresh: load, refreshing: loading, enabled: !embedded && !apiPage });

  useEffect(() => { load(); }, [load]);

  // Add a webhook by hand — for sources with no integration to connect (e.g. RB2B), or
  // to surface one ahead of connecting. Writes a subscription, then opens its setup guide
  // so the URL is right there to copy.
  const addWebhook = async (source: string) => {
    if (!token || !workspaceId) return;
    setBusySource(source);
    try {
      await fetch(`${apiUrl}/api/webhooks/subscriptions?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, workspaceId }),
      });
      setAddOpen(false);
      await load();
      setGuideSource(source);
    } finally { setBusySource(null); }
  };

  const removeWebhook = async (source: string) => {
    if (!token || !workspaceId) return;
    setBusySource(source);
    try {
      await fetch(`${apiUrl}/api/webhooks/subscriptions/${source}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await load();
    } finally { setBusySource(null); }
  };

  // Refresh every 30s so a fresh test ping flips Pending → Live without reload.
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const copyUrl = (url: string, source: string) => {
    navigator.clipboard.writeText(url);
    setCopied(source);
    setTimeout(() => setCopied(null), 1500);
  };

  const guideUrl = urls.find(u => u.source === guideSource)?.url ?? "";

  // Something that should be flowing isn't. A webhook we set up (auto-registered) or one
  // that used to deliver has gone quiet for over a week — the case worth warning about,
  // because the user thinks it's working. A never-connected provider being "pending" is
  // not a problem, so it doesn't warn.
  const stale = urls.filter(u => u.status === "stale" && (u.auto_registered || u.last_event_at));

  // Only webhooks that are actually in play show on the page. Everything else is offered
  // under "Add" — a source with no integration behind it yet (e.g. RB2B) or one you want
  // to surface before connecting.
  const activeUrls = urls.filter(u => u.active);
  const available = urls.filter(u => !u.active);

  const addButton = (
    <Popover open={addOpen} onOpenChange={setAddOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={apiPage ? "Add tool" : "Add a webhook"}
          disabled={available.length === 0}
          className={cn("inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card text-[12.5px] text-foreground transition-colors duration-fast hover:bg-hover disabled:opacity-40",
            apiPage ? "h-7 px-2" : "h-8 px-2.5")}>
          <Plus className="h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={1.75} />{apiPage ? "Add tool" : "Add"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground/60">Add a webhook</div>
        {available.length === 0 ? (
          <div className="px-2 py-2 text-[12px] text-muted-foreground/70">Every source is already added.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {available.map(w => (
              <button key={w.source} onClick={() => addWebhook(w.source)} disabled={busySource === w.source}
                className="flex w-full items-center gap-2.5 px-2 py-1.5 rounded-md text-left hover:bg-accent transition-colors disabled:opacity-50">
                <ProviderLogo source={w.source} />
                <span className="flex-1 text-[13px] font-medium text-foreground capitalize truncate">{label(w.source)}</span>
                <Plus className="h-3.5 w-3.5 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );

  if (apiPage) {
    return (
      // Endpoints (where events go) live on the Events page (GET-941); this page is the
      // webhooks your tools send in.
      <ApiWebhooks
        token={token}
        workspaceId={workspaceId}
        only="in"
        onRefreshInbound={load}
        inbound={
          <>
            <ToolsCard
              loading={loading}
              rows={activeUrls}
              add={addButton}
              copied={copied}
              busy={busySource}
              onCopy={copyUrl}
              onGuide={setGuideSource}
              onRemove={removeWebhook}
            />
            <WebhookGuideSheet
              source={guideSource}
              url={guideUrl}
              open={guideSource != null}
              onOpenChange={(v) => { if (!v) setGuideSource(null); }}
            />
          </>
        }
      />
    );
  }

  return (
    <div className={embedded ? "" : "h-full overflow-y-auto bg-background"}>
      <div className={embedded ? "" : "px-8 py-7"}>
        {/* Laid out exactly like the Sources page: title + Plus-icon add on the right,
            then a bottom-bordered tab row, then the list. */}
        {embedded ? (
          // The settings top bar already names the section (round 2): just the add action.
          <div className="mb-3 flex justify-end">{addButton}</div>
        ) : (
          <PageHeader title="Webhooks" actions={addButton} />
        )}

        {/* One tab ("All") was a tab row with nothing to switch to; the count lives on the card. */}

        {/* Warning — a feed that should be live has gone quiet. */}
        {stale.length > 0 && (
          <div className="flex items-start gap-2.5 mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-[12.5px] text-amber-800 leading-relaxed">
              <span className="font-semibold">
                {stale.length === 1
                  ? `No events from ${stale[0].source.replace(/_/g, " ")} in over a week.`
                  : `${stale.length} integrations have gone quiet for over a week.`}
              </span>{" "}
              They may have been disconnected on the provider's side — open the setup guide to check, or reconnect the integration.
            </div>
          </div>
        )}

        {/* Endpoints — the URLs, on top. */}
        {loading ? (
          <div className="space-y-px rounded-xl overflow-hidden border border-border">
            {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-muted/50 animate-pulse" />)}
          </div>
        ) : activeUrls.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 py-10 text-center">
            <p className="text-[13px] text-foreground/80">No webhooks yet</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground/60">Connect an integration and its webhook shows up here.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-card p-2 overflow-hidden">
            {activeUrls.map(w => (
              <div key={w.source}
                className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover transition-colors duration-fast">
                <ProviderLogo source={w.source} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] text-foreground capitalize">{label(w.source)}</p>
                    {w.auto_registered && (
                      <span
                        title="Nous registered this webhook for you via the provider's API. No paste step needed — but the status pill still shows whether events are flowing."
                        className="flex-shrink-0 text-[11px] text-muted-foreground/60">
                        Auto-registered
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-muted-foreground/70 font-mono truncate mt-0.5">{w.url}</p>
                </div>
                <StatusPill status={w.status} lastEventAt={w.last_event_at} />
                <button onClick={() => setGuideSource(w.source)}
                  title="Setup guide — which events to enable, where to paste, what's auto-registered"
                  className="flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg bg-background border border-border text-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors">
                  <Info className="h-4 w-4" />
                </button>
                <button onClick={() => copyUrl(w.url, w.source)}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-accent transition-colors">
                  {copied === w.source
                    ? <><Check className="h-3.5 w-3.5 text-emerald-600" /> Copied</>
                    : <><Copy className="h-3.5 w-3.5" /> Copy</>}
                </button>
                {w.manual && (
                  <button onClick={() => removeWebhook(w.source)} disabled={busySource === w.source}
                    title="Remove this webhook"
                    className="flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg bg-background border border-border text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <WebhookGuideSheet
        source={guideSource}
        url={guideUrl}
        open={guideSource != null}
        onOpenChange={(v) => { if (!v) setGuideSource(null); }}
      />
    </div>
  );
}
