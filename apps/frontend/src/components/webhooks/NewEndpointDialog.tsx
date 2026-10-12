// The "add an outbound webhook" dialog (a trigger_subscriptions row via POST /api/triggers).
// Shared by the Webhooks page (GET-632, "Add endpoint") and the headless Triggers page.
import { useEffect, useMemo, useState } from "react";
import { Briefcase, Calendar, Check, Gauge, Github, Link2, Mail, MessageSquare, Phone, UserPlus, Webhook } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
    ],
  },
  {
    group: "Conversations",
    items: [
      { id: "conversation.call_ended", label: "Call ended",
        description: "A customer call was recorded and reviewed. Carries the call, its score and the account record.",
        icon: Phone, logo: null },
      { id: "conversation.reply_received", label: "Reply received",
        description: "Someone replied to an email you sent. Carries the message and the account record.",
        icon: MessageSquare, logo: null },
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
      { id: "people.added", label: "Person created",
        description: "New people landed. At most once an hour, with up to 100 of them, so a scorer can score them.",
        icon: UserPlus, logo: null },
    ],
  },
  {
    group: "Email",
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
    group: "LinkedIn",
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
    group: "Meetings",
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
  destination?: { type: "url"; url: string } | { type: "github"; repo: string };
  events: string[];
};

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
  /** Edit this endpoint instead of creating one: name, URL and events. A GitHub repo stays as it
   *  is (its token is never sent back), so only its name and events change here. */
  editing?: EditableEndpoint | null;
}) {
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  // Where events go (GET-670): a URL, or a GitHub repo whose Actions run on each event.
  const [kind, setKind] = useState<"url" | "github">("url");
  const [repo, setRepo] = useState("");
  const [ghToken, setGhToken] = useState("");
  // The repos already connected in Settings (GET-674): pick one and its stored token is used.
  // "other" is the paste-a-repo-and-token fallback.
  const [connected, setConnected] = useState<{ source: "personal" | "company"; repo: string; usable: boolean }[]>([]);
  const [pick, setPick] = useState<"personal" | "company" | "other">("other");

  useEffect(() => {
    if (!open || !workspaceId) return;
    let alive = true;
    fetch(`${apiUrl}/api/triggers/github-repos?workspace_id=${encodeURIComponent(workspaceId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : { repos: [] }))
      .then(d => {
        if (!alive) return;
        const repos = (d?.repos ?? []).filter((r: { usable: boolean }) => r.usable);
        setConnected(repos);
        setPick(repos[0]?.source ?? "other");
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, workspaceId, token]);
  const [newEvents, setNewEvents] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const editGithub = editing?.destination?.type === "github";
  useEffect(() => {
    if (!open || !editing) return;
    setNewName(editing.name);
    setNewUrl(editing.destination?.type === "url" ? editing.destination.url : (editing.url ?? ""));
    setKind(editGithub ? "github" : "url");
    setRepo(editing.destination?.type === "github" ? editing.destination.repo : "");
    setNewEvents(editing.events);
    setCreateError(null);
  }, [open, editing, editGithub]);

  const toggleEvent = (id: string) =>
    setNewEvents(curr => curr.includes(id) ? curr.filter(x => x !== id) : [...curr, id]);

  const resetForm = () => {
    setNewName(""); setNewUrl(""); setNewEvents([]); setCreateError(null); setSubmitting(false);
    setKind("url"); setRepo(""); setGhToken(""); setPick(connected[0]?.source ?? "other");
  };

  const validUrl = useMemo(() => {
    if (!newUrl.trim()) return false;
    try { const u = new URL(newUrl.trim()); return u.protocol === "https:" || u.protocol === "http:"; }
    catch { return false; }
  }, [newUrl]);

  const validRepo = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));
  const validDestination = editing ? (editGithub || validUrl)
    : kind === "url" ? validUrl
    : pick !== "other" ? true
    : validRepo && ghToken.trim().length > 0;
  const canCreate = newName.trim().length > 0 && validDestination && newEvents.length > 0 && !!workspaceId;

  const create = async () => {
    if (!canCreate) return;
    setCreateError(null); setSubmitting(true);
    if (editing) {
      try {
        const res = await fetch(`${apiUrl}/api/triggers/${editing.id}?workspace_id=${encodeURIComponent(workspaceId)}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspaceId, name: newName.trim(), events: newEvents,
            ...(editGithub ? {} : { url: newUrl.trim() }),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setCreateError(data.detail ?? data.error ?? "update_failed"); return; }
        onOpenChange(false);
        resetForm();
        onCreated({ id: editing.id });
      } catch {
        setCreateError("network_error");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/triggers?workspace_id=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId, name: newName.trim(), events: newEvents,
          ...(kind === "url"
            ? { url: newUrl.trim() }
            : pick !== "other"
              ? { destination: { type: "github", connected_repo: pick } }
              : { destination: { type: "github", repo: repo.trim(), token: ghToken.trim() } }),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "create_failed"); return; }
      onOpenChange(false);
      resetForm();
      onCreated(data?.trigger?.id ? { id: data.trigger.id, signing_secret: data.signing_secret } : undefined);
    } catch {
      setCreateError("network_error");
    } finally {
      setSubmitting(false);
    }
  };

  const groups = eventGroups(availableEvents);
  const isAvail = (id: string) => availableEvents.size === 0 || availableEvents.has(id);
  const toggleGroup = (ids: string[]) => {
    const on = ids.every((id) => newEvents.includes(id));
    setNewEvents((curr) => on ? curr.filter((x) => !ids.includes(x)) : [...new Set([...curr, ...ids])]);
  };
  const field = "h-9 rounded-lg bg-card font-mono text-[12.5px] focus-visible:border-foreground/30";
  const label = "mb-1.5 block text-[12px] font-medium text-ink-2";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      {/* GET-676: destination first as two quiet choices, then the fields it needs, then the events
          as a compact grid of toggle tiles (no descriptions), the count in the footer. */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[600px]">
        <DialogHeader className="border-b border-hairline px-5 py-3.5 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Subscribe a URL or a GitHub repo to one or more events. A URL gets a payload signed with HMAC-SHA256; a repo gets a repository_dispatch.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {!editing && (
            <div role="radiogroup" aria-label="Destination" className="grid grid-cols-2 gap-2">
              {([["url", "URL", Link2], ["github", "GitHub repo", Github]] as const).map(([k, text, Icon]) => {
                const on = kind === k;
                return (
                  <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setKind(k)}
                    className={cn("flex h-11 items-center gap-2.5 rounded-xl border px-3 text-left text-[13px] transition-colors duration-fast",
                      on ? "border-foreground/20 bg-hover text-foreground" : "border-border/70 text-ink-2 hover:bg-hover/60 hover:text-foreground")}>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-card shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </span>
                    <span className="flex-1">{text}</span>
                    {on && <Check className="h-3.5 w-3.5 text-foreground/70" strokeWidth={2} />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="space-y-3">
            {kind === "url" ? (
              <div>
                <label htmlFor="endpoint-url" className={label}>URL</label>
                <Input id="endpoint-url" autoFocus={!editing} value={newUrl} onChange={e => setNewUrl(e.target.value)}
                  placeholder="https://your-receiver.example.com/hook" className={field} />
                {newUrl && !validUrl && <p className="mt-1.5 text-[11.5px] text-warning">Include https:// (http works for local dev).</p>}
              </div>
            ) : !editing && connected.length > 0 ? (
              <div>
                <label className={label}>Repo</label>
                <Select value={pick} onValueChange={(v) => setPick(v as typeof pick)}>
                  <SelectTrigger className="h-9 rounded-lg bg-card font-mono text-[12.5px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {connected.map(r => (
                      <SelectItem key={r.source} value={r.source} className="font-mono text-[12.5px]">
                        {r.repo}{r.source === "company" ? " · workspace" : ""}
                      </SelectItem>
                    ))}
                    <SelectItem value="other">Other repo…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div>
                <label htmlFor="endpoint-repo" className={label}>Repo</label>
                <Input id="endpoint-repo" value={repo} onChange={e => setRepo(e.target.value)} readOnly={editGithub}
                  placeholder="owner/repo" className={field} />
              </div>
            )}

            {kind === "github" && !editing && pick === "other" && connected.length > 0 && (
              <div>
                <label htmlFor="endpoint-other-repo" className={label}>Repo</label>
                <Input id="endpoint-other-repo" value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/repo" className={field} />
              </div>
            )}

            {kind === "github" && !editing && pick === "other" && (
              <div>
                <label htmlFor="endpoint-token" className={label}>Token</label>
                <Input id="endpoint-token" type="password" autoComplete="off" value={ghToken} onChange={e => setGhToken(e.target.value)}
                  placeholder="github_pat_…" className={field} />
                <p className="mt-1.5 text-[11.5px] text-muted-foreground/70">Fine-grained, this repo only, Contents: read and write.</p>
              </div>
            )}

            <div>
              <label htmlFor="endpoint-name" className={label}>Name</label>
              <Input id="endpoint-name" autoFocus={!!editing} value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="e.g. n8n follow-ups" className="h-9 rounded-lg bg-card text-[13px] focus-visible:border-foreground/30" />
            </div>
          </div>

          <div className="space-y-3">
            <span className={label}>Events</span>
            {groups.map(group => {
              const ids = group.items.filter((ev) => isAvail(ev.id)).map((ev) => ev.id);
              const all = ids.length > 0 && ids.every((id) => newEvents.includes(id));
              return (
                <div key={group.group}>
                  <div className="flex items-center justify-between px-0.5 pb-1.5">
                    <span className="text-[11px] font-medium text-muted-foreground/60">{group.group}</span>
                    {ids.length > 1 && (
                      <button type="button" onClick={() => toggleGroup(ids)}
                        className="text-[11px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
                        {all ? "None" : "All"}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {group.items.map(ev => {
                      const on = newEvents.includes(ev.id);
                      const avail = isAvail(ev.id);
                      return (
                        <button key={ev.id} type="button" role="checkbox" aria-checked={on} disabled={!avail} title={ev.id}
                          onClick={() => avail && toggleEvent(ev.id)}
                          className={cn("flex h-10 items-center gap-2.5 rounded-lg border px-2.5 text-left text-[13px] transition-colors duration-fast",
                            on ? "border-foreground/20 bg-hover text-foreground" : "border-border/70 text-ink-2 hover:bg-hover/60 hover:text-foreground",
                            !avail && "cursor-not-allowed opacity-40")}>
                          <EventLogo logo={ev.logo} fallback={ev.icon} size="md" />
                          <span className="min-w-0 flex-1 truncate">{ev.label}</span>
                          <span className={cn("flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-fast",
                            on ? "border-foreground bg-foreground text-background" : "border-input")}>
                            {on && <Check className="h-3 w-3" strokeWidth={2.5} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {createError && <p className="rounded-lg bg-risk/10 px-3 py-2 text-[12px] text-risk">{createError}</p>}
        </div>

        <DialogFooter className="flex items-center gap-2 border-t border-hairline px-5 py-3 sm:justify-between">
          <span className="text-[12px] tabular-nums text-muted-foreground/70">
            {newEvents.length === 0 ? "No events yet" : `${newEvents.length} event${newEvents.length === 1 ? "" : "s"}`}
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
