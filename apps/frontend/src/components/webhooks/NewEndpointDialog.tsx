// The "add an outbound webhook" dialog (a trigger_subscriptions row via POST /api/triggers).
// Shared by the Webhooks page (GET-632, "Add endpoint") and the headless Triggers page.
import { useEffect, useMemo, useState } from "react";
import { Briefcase, Calendar, Check, ExternalLink, Gauge, Github, Lightbulb, Link2, Mail, MessageSquare, Phone, Radio, Search, TrendingUp, UserMinus, UserPlus, Webhook } from "lucide-react";
import { TONE_DOT, eventTone } from "@/lib/events";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Mini logo tile — same look as the Webhooks page ProviderLogo but with a
// fallback Lucide icon when the provider logo isn't present.
export function EventLogo({ logo, fallback: Fallback, size = "sm" }: {
  logo: string | null;
  fallback: React.ElementType;
  size?: "sm" | "md";
}) {
  const [src, setSrc] = useState(logo ? `/provider-logos/${logo}.svg` : null);
  const tile = size === "md" ? "w-6 h-6 rounded-md" : "w-4 h-4 rounded";
  const inner = size === "md" ? "w-3.5 h-3.5" : "w-3 h-3";
  const icon = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
  return (
    <div className={`relative ${tile} ${size === "md" ? "bg-card shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]" : "bg-muted/50 border border-border/60"} flex items-center justify-center overflow-hidden flex-shrink-0`}>
      <Fallback className={`${icon} text-muted-foreground/50`} strokeWidth={1.75} />
      {src && (
        <img src={src} alt="" className={`absolute inset-0 m-auto ${inner} object-contain`}
          onError={() => {
            if (src.endsWith(".svg")) setSrc(`/provider-logos/${logo}.png`);
            else setSrc(null);
          }} />
      )}
    </div>
  );
}

export interface EventDef {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  logo: string | null;   // provider-logos/<logo>.{svg,png}; null = use icon only
}

// Every event the API emits (TRIGGER_EVENTS in packages/core/src/db/triggers.ts), grouped, with the
// API's own one-line descriptions (EVENT_CATALOG there, which GET /v2/webhooks/events and the docs
// serve). Record events carry the whole account record; interaction events a person snapshot.
// Each renders with a real provider logo when one's available (gmail, linkedin); the rest fall back
// to an icon. An event the API lists that is not here still shows, under Other (see `eventGroups`).
export const EVENT_CATALOG: { group: string; items: EventDef[] }[] = [
  {
    group: "Signals",
    items: [
      { id: "signal.stakeholder_left", label: "Stakeholder left", description: "Someone left the account's team.", icon: Radio, logo: null },
      { id: "signal.churn_risk", label: "Churn risk", description: "A churn risk: stated churn, at risk, or friction.", icon: Radio, logo: null },
      { id: "signal.competitor_evaluating", label: "Evaluating a competitor", description: "A competitor is being actively evaluated.", icon: Radio, logo: null },
      { id: "signal.objection_raised", label: "Objection raised", description: "A buyer pushed back on a call or in email, in their words.", icon: Radio, logo: null },
      { id: "signal.expansion_signal", label: "Expansion signal", description: "They asked about, or are considering, more: a product, seats, a team.", icon: Radio, logo: null },
      { id: "signal.buying_signal", label: "Buying signal", description: "Intent to buy, a request for pricing or a proposal.", icon: Radio, logo: null },
      { id: "signal.next_step_missed", label: "Next step missed", description: "An agreed next step is a day past its due date with nothing on the account since.", icon: Radio, logo: null },
      { id: "signal.next_step_slipped", label: "Next step slipped", description: "The buyer pushed the date of the same next step a second time.", icon: Radio, logo: null },
      { id: "signal.usage_dropped", label: "Usage dropped", description: "Product use at the account halved against the 30 days before (PostHog).", icon: Radio, logo: null },
      { id: "signal.account_inactive", label: "Account inactive", description: "Nobody at the account has used the product for 14 days (PostHog).", icon: Radio, logo: null },
      { id: "signal.feature_adopted", label: "Feature adopted", description: "The account used a key product feature for the first time (PostHog).", icon: Radio, logo: null },
      { id: "signal.seat_dropped", label: "Seat dropped", description: "Someone at the account stopped using the product (PostHog).", icon: Radio, logo: null },
      { id: "signal.product_qualified", label: "Product-qualified", description: "3 or more people at the account now use the product (PostHog).", icon: Radio, logo: null },
      { id: "signal.seats_growing", label: "Seats growing", description: "More people at the account use the product than last month (PostHog).", icon: Radio, logo: null },
      { id: "signal.account_activated", label: "Account activated", description: "The account has used every key part of the product (PostHog).", icon: Radio, logo: null },
      { id: "signal.stakeholder_identified", label: "Stakeholder identified", description: "A buying role was named: champion, economic buyer, decision maker or blocker.", icon: Radio, logo: null },
      { id: "signal.stakeholder_joined", label: "Stakeholder joined", description: "Someone new joined the account's team.", icon: Radio, logo: null },
      { id: "signal.competitor_mentioned", label: "Competitor mentioned", description: "A competitor came up, and in what stance.", icon: Radio, logo: null },
      { id: "signal.budget_discussed", label: "Budget discussed", description: "Budget, procurement or a commercial constraint came up.", icon: Radio, logo: null },
      { id: "signal.objection_resolved", label: "Objection resolved", description: "An open objection was answered.", icon: Radio, logo: null },
      { id: "signal.expansion_declined", label: "Expansion declined", description: "They declined more of a product.", icon: Radio, logo: null },
    ],
  },
  {
    // Interpreted events (GET-950): what a signal means for the account, with the evidence.
    group: "Accounts",
    items: [
      { id: "account.champion_left", label: "Champion left",
        description: "A champion of the account left: who, who took over if anyone was named, the quote, and how sure we are.",
        icon: UserMinus, logo: null },
      { id: "account.expansion_requested", label: "Expansion requested",
        description: "A customer asked for more of a named product, in their words.",
        icon: TrendingUp, logo: null },
    ],
  },
  {
    group: "Meetings and replies",
    items: [
      { id: "conversation.call_ended", label: "Meeting ended",
        description: "A meeting with a customer ended and its notes were read. Carries the meeting, its summary, the attendees, the account record, and the recorder with its own meeting id.",
        icon: Phone, logo: null },
      { id: "conversation.reply_received", label: "Reply received",
        description: "Someone replied to an email you sent. Carries the message and the account record.",
        icon: MessageSquare, logo: null },
    ],
  },
  {
    group: "Deals",
    items: [
      { id: "deal.stage_changed", label: "Stage changed",
        description: "An account's pipeline stage moved. Checked hourly.",
        icon: Briefcase, logo: null },
      { id: "deal.won", label: "Deal won",
        description: "A deal closed won. Checked hourly; deals reach the ledger after the CRM records the close.",
        icon: Briefcase, logo: null },
      { id: "deal.lost", label: "Deal lost",
        description: "A deal closed lost. Same timing as deal.won.",
        icon: Briefcase, logo: null },
      { id: "deal.stalled", label: "Stale deal detected",
        description: "An open deal sat in its stage past the window with no touch and no meeting booked. Checked every six hours.",
        icon: Briefcase, logo: null },
    ],
  },
  {
    group: "ICP",
    items: [
      { id: "icp.tier_changed", label: "Tier changed",
        description: "An ICP score crossed a tier. From any scorer, yours included. Checked hourly.",
        icon: Gauge, logo: null },
      { id: "icp.score_changed", label: "Score changed",
        description: "Someone's ICP score moved, or they were scored for the first time. Checked hourly.",
        icon: Gauge, logo: null },
    ],
  },
  {
    group: "People",
    items: [
      { id: "people.added", label: "People added",
        description: "New people landed. At most once an hour, with up to 100 of them, so a scorer can score them.",
        icon: UserPlus, logo: null },
    ],
  },
  {
    group: "Insights",
    items: [
      { id: "insight.emerged", label: "New insight",
        description: "The same point heard from 5 or more accounts: a feature request, objection, competitor or friction. Checked hourly; once per insight.",
        icon: Lightbulb, logo: null },
      { id: "insight.rising", label: "Insight rising",
        description: "An insight is heard from more accounts: 2 or more and half again, the last 30 days against the 30 before. At most once a week.",
        icon: TrendingUp, logo: null },
    ],
  },
  {
    group: "Email (outreach tools)",
    items: [
      { id: "interaction.email_received", label: "Email received",
        description: "An email arrived from a contact (sequencing tools). Person snapshot only.",
        icon: Mail, logo: "gmail" },
      { id: "interaction.email_bounced", label: "Email bounced",
        description: "An email bounced or the contact unsubscribed. Person snapshot only.",
        icon: Mail, logo: "gmail" },
    ],
  },
  {
    group: "LinkedIn (outreach tools)",
    items: [
      { id: "interaction.linkedin_connection_accepted", label: "Connection accepted",
        description: "A LinkedIn connection request was accepted. Person snapshot only.",
        icon: Link2, logo: "linkedin" },
      { id: "interaction.linkedin_message_received", label: "LinkedIn message received",
        description: "A LinkedIn message arrived. Person snapshot only.",
        icon: MessageSquare, logo: "linkedin" },
    ],
  },
  {
    group: "Meetings (booking tools)",
    items: [
      { id: "interaction.meeting_scheduled", label: "Meeting scheduled",
        description: "A meeting was booked. Person snapshot only.",
        icon: Calendar, logo: null },
      { id: "interaction.meeting_held", label: "Meeting held",
        description: "A meeting took place. Person snapshot only.",
        icon: Calendar, logo: null },
    ],
  },
];

/** The catalog, plus any event the API lists that it does not know yet (shown by its id). */
export function eventGroups(available: Set<string>): { group: string; items: EventDef[] }[] {
  const known = new Set(EVENT_CATALOG.flatMap((g) => g.items.map((i) => i.id)));
  const extra = [...available].filter((id) => !known.has(id))
    .map((id) => ({ id, label: id, description: "", icon: Webhook, logo: null }));
  return extra.length ? [...EVENT_CATALOG, { group: "Other", items: extra }] : EVENT_CATALOG;
}

export function eventDef(id: string): EventDef | undefined {
  for (const g of EVENT_CATALOG) for (const i of g.items) if (i.id === id) return i;
  return undefined;
}

/** An endpoint as the Edit dialog starts from (GET-675): PATCH /api/triggers/:id. */
export type EditableEndpoint = {
  id: string;
  name: string;
  url: string | null;
  destination?: { type: "url"; url: string } | { type: "github"; repo: string } | { type: "slack"; hint?: string } | { type: "claude"; url: string; task?: string | null };
  events: string[];
};

/** A Slack incoming webhook: the only URL a Slack destination takes (core: SLACK_WEBHOOK_RE). */
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9_\-/]+$/;
const SLACK_HELP = "https://api.slack.com/messaging/webhooks";
/** A Claude scheduled task's Fire URL, as its API trigger panel shows it (core: CLAUDE_FIRE_URL_RE). */
export const CLAUDE_FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
const CLAUDE_HELP = "https://code.claude.com/docs/en/routines";
// The groups shown open; the outreach-tool events (a person snapshot only) sit behind "More events".
const MAIN_GROUPS = new Set(["Signals", "Accounts", "Meetings and replies", "Deals", "ICP", "People"]);

function DestinationCard({ on, onClick, title, sub, tile }: { on: boolean; onClick: () => void; title: string; sub: string; tile: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition-colors duration-fast",
        on ? "border-foreground/25 bg-hover" : "border-border/70 hover:bg-hover/60")}>
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-card shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">{tile}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{title}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground/80">{sub}</span>
      </span>
      <span className={cn("mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border", on ? "border-foreground bg-foreground" : "border-input")}>
        {on && <span className="h-1.5 w-1.5 rounded-full bg-background" />}
      </span>
    </button>
  );
}

export function NewEndpointDialog({
  open, onOpenChange, token, workspaceId, availableEvents, onCreated, editing = null,
  title = "Add endpoint", submitLabel = "Add endpoint",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  workspaceId: string;
  /** From GET /api/triggers; empty = every catalog event is selectable. */
  availableEvents: Set<string>;
  /** Gets the new endpoint's id and its signing secret: the only time the secret is returned. */
  onCreated: (created?: { id: string; signing_secret?: string }) => void;
  title?: string;
  submitLabel?: string;
  /** Edit this endpoint instead of creating one. A GitHub repo stays as it is (its token is never
   *  sent back); a Slack webhook is replaced only when a new one is pasted. */
  editing?: EditableEndpoint | null;
}) {
  // Where events go: a URL (n8n, Make, Zapier, your server), a Slack channel (GET-941) or a Claude
  // scheduled task (GET-1035). GitHub repos are no longer offered for new endpoints; existing ones
  // keep working and can be edited.
  const [kind, setKind] = useState<"url" | "slack" | "claude">("url");
  const [claudeUrl, setClaudeUrl] = useState("");
  const [claudeToken, setClaudeToken] = useState("");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [slackUrl, setSlackUrl] = useState("");
  const [newEvents, setNewEvents] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const editKind = editing?.destination?.type ?? (editing ? "url" : null);
  const editGithub = editKind === "github";
  useEffect(() => {
    if (!open || !editing) return;
    setNewName(editing.name);
    setNewUrl(editing.destination?.type === "url" ? editing.destination.url : (editing.url ?? ""));
    setKind(editKind === "slack" ? "slack" : editKind === "claude" ? "claude" : "url");
    setSlackUrl("");
    setClaudeUrl(editing.destination?.type === "claude" ? editing.destination.url : "");
    setClaudeToken("");
    setNewEvents(editing.events);
    setCreateError(null);
  }, [open, editing, editKind]);

  const toggleEvent = (id: string) =>
    setNewEvents(curr => curr.includes(id) ? curr.filter(x => x !== id) : [...curr, id]);

  const resetForm = () => {
    setNewName(""); setNewUrl(""); setSlackUrl(""); setClaudeUrl(""); setClaudeToken(""); setNewEvents([]); setCreateError(null); setSubmitting(false);
    setKind("url"); setQuery(""); setMoreOpen(false);
  };

  const validUrl = useMemo(() => {
    if (!newUrl.trim()) return false;
    try { const u = new URL(newUrl.trim()); return u.protocol === "https:" || u.protocol === "http:"; }
    catch { return false; }
  }, [newUrl]);
  const validSlack = SLACK_WEBHOOK.test(slackUrl.trim());
  const validClaudeUrl = CLAUDE_FIRE_URL.test(claudeUrl.trim());
  // Editing a Claude task keeps its token unless a new one is pasted; a new Fire URL needs its token.
  const keepClaude = editKind === "claude" && !claudeToken.trim() && editing?.destination?.type === "claude" && claudeUrl.trim() === editing.destination.url;

  const validDestination = editGithub ? true
    : kind === "claude" ? validClaudeUrl && (keepClaude || claudeToken.trim().length > 20)
    : kind === "url" ? validUrl
    : editKind === "slack" ? (!slackUrl.trim() || validSlack)
    : validSlack;
  const canCreate = newName.trim().length > 0 && validDestination && newEvents.length > 0 && !!workspaceId;

  const destinationBody = () => {
    if (editGithub) return {};
    if (kind === "url") return { url: newUrl.trim() };
    if (kind === "claude") return keepClaude ? {} : { destination: { type: "claude", url: claudeUrl.trim(), token: claudeToken.trim() } };
    if (editKind === "slack" && !slackUrl.trim()) return {};
    return { destination: { type: "slack", url: slackUrl.trim() } };
  };

  const create = async () => {
    if (!canCreate) return;
    setCreateError(null); setSubmitting(true);
    try {
      const res = await fetch(
        editing ? `${apiUrl}/api/triggers/${editing.id}?workspace_id=${encodeURIComponent(workspaceId)}` : `${apiUrl}/api/triggers?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: workspaceId, name: newName.trim(), events: newEvents, ...destinationBody() }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(data.error === "invalid_slack_webhook" ? "That is not a Slack incoming webhook URL. It starts with https://hooks.slack.com/."
          : data.error === "invalid_claude_fire_url" ? "That is not a Claude task's Fire URL. Copy it from the task's API trigger."
          : data.detail ?? data.error ?? (editing ? "update_failed" : "create_failed"));
        return;
      }
      onOpenChange(false);
      resetForm();
      if (editing) onCreated({ id: editing.id });
      else onCreated(data?.trigger?.id ? { id: data.trigger.id, signing_secret: data.signing_secret } : undefined);
    } catch {
      setCreateError("network_error");
    } finally {
      setSubmitting(false);
    }
  };

  const isAvail = (id: string) => availableEvents.size === 0 || availableEvents.has(id);
  const q = query.trim().toLowerCase();
  const groups = eventGroups(availableEvents)
    .map((g) => ({ ...g, items: g.items.filter((ev) => !q || ev.label.toLowerCase().includes(q) || ev.id.includes(q)) }))
    .filter((g) => g.items.length > 0);
  const shown = groups.filter((g) => q || moreOpen || MAIN_GROUPS.has(g.group));
  const hiddenCount = q ? 0 : groups.filter((g) => !MAIN_GROUPS.has(g.group)).reduce((n, g) => n + g.items.length, 0);
  const setMany = (ids: string[], on: boolean) =>
    setNewEvents((curr) => on ? [...new Set([...curr, ...ids])] : curr.filter((x) => !ids.includes(x)));
  const signalIds = (EVENT_CATALOG.find((g) => g.group === "Signals")?.items ?? []).map((i) => i.id).filter(isAvail);
  const presets: [string, string[]][] = [
    ["All signals", signalIds],
    ["Risks", signalIds.filter((id) => ["risk", "warning"].includes(eventTone(id)))],
    ["Wins", [...signalIds.filter((id) => eventTone(id) === "positive"), "deal.won"].filter(isAvail)],
    ["Deals", ["deal.won", "deal.lost", "deal.stage_changed"].filter(isAvail)],
  ];
  const field = "h-9 rounded-lg bg-card font-mono text-[12.5px] focus-visible:border-foreground/30";
  const label = "mb-1.5 block text-[12px] font-medium text-ink-2";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      {/* GET-941: where it goes (a URL or a Slack channel), then the events: presets, a search, and
          the groups as compact rows with each event's tone dot. The count is in the footer. */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-hairline px-5 py-3.5 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Send events to a URL, signed with HMAC-SHA256, or to a Slack channel as messages.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-5 overflow-y-auto px-5 py-4">
          {editGithub ? (
            <div>
              <span className={label}>Sends to</span>
              <div className="flex h-9 items-center gap-2 rounded-lg bg-hover px-2.5 font-mono text-[12.5px] text-foreground">
                <Github className="h-3.5 w-3.5" />{editing?.destination?.type === "github" ? editing.destination.repo : ""}
              </div>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Send events to" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <DestinationCard on={kind === "url"} onClick={() => setKind("url")} title="Webhook URL"
                sub="n8n, Make, Zapier or your own server. Signed JSON." tile={<Link2 className="h-3.5 w-3.5 text-foreground" strokeWidth={1.75} />} />
              <DestinationCard on={kind === "slack"} onClick={() => setKind("slack")} title="Slack channel"
                sub="Each event posted as a short message." tile={<img src="/provider-logos/slack.svg" alt="" className="h-3.5 w-3.5" />} />
              <DestinationCard on={kind === "claude"} onClick={() => setKind("claude")} title="Claude task"
                sub="Each event starts your scheduled task." tile={<img src="/provider-logos/claude.svg" alt="" className="h-3.5 w-3.5" />} />
            </div>
          )}

          <div className="space-y-3">
            {!editGithub && kind === "url" && (
              <div>
                <label htmlFor="endpoint-url" className={label}>URL</label>
                <Input id="endpoint-url" autoFocus={!editing} value={newUrl} onChange={e => setNewUrl(e.target.value)}
                  placeholder="https://your-receiver.example.com/hook" className={field} />
                {newUrl && !validUrl && <p className="mt-1.5 text-[11.5px] text-warning">Include https:// (http works for local dev).</p>}
              </div>
            )}
            {!editGithub && kind === "slack" && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="endpoint-slack" className="text-[12px] font-medium text-ink-2">Slack incoming webhook</label>
                  <a href={SLACK_HELP} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
                    Get one from Slack <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <Input id="endpoint-slack" type="password" autoComplete="off" autoFocus={!editing} value={slackUrl} onChange={e => setSlackUrl(e.target.value)}
                  placeholder={editKind === "slack" ? `Keep ${editing?.destination?.type === "slack" ? editing.destination.hint ?? "the current webhook" : "the current webhook"}, or paste a new one` : "https://hooks.slack.com/services/…"}
                  className={field} />
                {slackUrl && !validSlack
                  ? <p className="mt-1.5 text-[11.5px] text-warning">A Slack incoming webhook starts with https://hooks.slack.com/.</p>
                  : <p className="mt-1.5 text-[11.5px] text-muted-foreground/70">Create it in Slack for the channel you want. We only ever show its start.</p>}
              </div>
            )}
            {!editGithub && kind === "claude" && (
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label htmlFor="endpoint-claude-url" className="text-[12px] font-medium text-ink-2">Fire URL</label>
                    <a href={CLAUDE_HELP} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
                      Add an API trigger in Claude <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <Input id="endpoint-claude-url" autoFocus={!editing} value={claudeUrl} onChange={e => setClaudeUrl(e.target.value)}
                    placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" className={field} />
                  {claudeUrl && !validClaudeUrl && <p className="mt-1.5 text-[11.5px] text-warning">Copy the Fire URL from the task's API trigger.</p>}
                </div>
                <div>
                  <label htmlFor="endpoint-claude-token" className={label}>Task token</label>
                  <Input id="endpoint-claude-token" type="password" autoComplete="off" value={claudeToken} onChange={e => setClaudeToken(e.target.value)}
                    placeholder={editKind === "claude" ? "Keep the current token, or paste a new one" : "sk-ant-oat01-…"} className={field} />
                  <p className="mt-1.5 text-[11.5px] text-muted-foreground/70">Stored encrypted, never shown again. In the task's prompt, ask it to act on the event in the routine-fire-payload block.</p>
                </div>
              </div>
            )}
            <div>
              <label htmlFor="endpoint-name" className={label}>Name</label>
              <Input id="endpoint-name" autoFocus={!!editing} value={newName} onChange={e => setNewName(e.target.value)}
                placeholder={kind === "slack" ? "e.g. #deal-risks" : kind === "claude" ? "e.g. Follow-up after every meeting" : "e.g. n8n follow-ups"} className="h-9 rounded-lg bg-card text-[13px] focus-visible:border-foreground/30" />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-ink-2">Events</span>
              <span className="flex-1" />
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an event" aria-label="Find an event"
                  className="h-8 w-[180px] rounded-md bg-hover pl-7 pr-2 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70" />
              </div>
            </div>
            {!q && (
              <div className="flex flex-wrap gap-1.5">
                {presets.map(([name, ids]) => {
                  const on = ids.length > 0 && ids.every((id) => newEvents.includes(id));
                  return (
                    <button key={name} type="button" aria-pressed={on} onClick={() => setMany(ids, !on)} disabled={!ids.length}
                      className={cn("h-7 rounded-full border px-2.5 text-[12px] transition-colors duration-fast disabled:opacity-40",
                        on ? "border-foreground/25 bg-hover text-foreground" : "border-border/70 text-ink-2 hover:bg-hover hover:text-foreground")}>
                      {on && <Check className="-ml-0.5 mr-1 inline h-3 w-3" strokeWidth={2.5} />}{name}
                    </button>
                  );
                })}
                {newEvents.length > 0 && (
                  <button type="button" onClick={() => setNewEvents([])} className="h-7 px-1.5 text-[12px] text-muted-foreground hover:text-foreground">Clear</button>
                )}
              </div>
            )}

            <div className="rounded-xl border border-border/70 p-1">
              {shown.map((group, gi) => {
                const ids = group.items.filter((ev) => isAvail(ev.id)).map((ev) => ev.id);
                const picked = ids.filter((id) => newEvents.includes(id)).length;
                const all = ids.length > 0 && picked === ids.length;
                return (
                  <div key={group.group} className={cn(gi > 0 && "mt-1 border-t border-hairline pt-1")}>
                    <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground/70">{group.group}</span>
                      {picked > 0 && <span className="text-[11px] tabular-nums text-muted-foreground/60">{picked}/{ids.length}</span>}
                      <span className="flex-1" />
                      {ids.length > 1 && (
                        <button type="button" onClick={() => setMany(ids, !all)}
                          className="text-[11px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
                          {all ? "None" : "All"}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2">
                      {group.items.map(ev => {
                        const on = newEvents.includes(ev.id);
                        const avail = isAvail(ev.id);
                        const tone = eventTone(ev.id);
                        return (
                          <button key={ev.id} type="button" role="checkbox" aria-checked={on} disabled={!avail} title={ev.description || ev.id}
                            onClick={() => avail && toggleEvent(ev.id)}
                            className={cn("flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors duration-fast hover:bg-hover",
                              on ? "text-foreground" : "text-ink-2", !avail && "cursor-not-allowed opacity-40")}>
                            <span className={cn("flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-fast",
                              on ? "border-foreground bg-foreground text-background" : "border-input bg-card")}>
                              {on && <Check className="h-3 w-3" strokeWidth={2.5} />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{ev.label}</span>
                            {tone !== "neutral" && <span aria-hidden className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", TONE_DOT[tone])} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {shown.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">No event matches.</p>}
              {!q && !moreOpen && hiddenCount > 0 && (
                <button type="button" onClick={() => setMoreOpen(true)}
                  className="mt-1 w-full rounded-lg border-t border-hairline px-2 py-2 text-left text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground">
                  More events from outreach and booking tools ({hiddenCount})
                </button>
              )}
            </div>
          </div>

          {createError && <p className="rounded-lg bg-risk/10 px-3 py-2 text-[12px] text-risk">{createError}</p>}
        </div>

        <DialogFooter className="flex items-center gap-2 border-t border-hairline px-5 py-3 sm:justify-between">
          <span className="text-[12px] tabular-nums text-muted-foreground/70">
            {newEvents.length === 0 ? "Pick at least one event" : `${newEvents.length} event${newEvents.length === 1 ? "" : "s"} selected`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={create} disabled={!canCreate || submitting}>
              {submitting ? (editing ? "Saving…" : "Creating…") : submitLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
