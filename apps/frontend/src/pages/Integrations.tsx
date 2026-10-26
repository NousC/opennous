import { useState, useEffect, useRef, Suspense, type ReactNode } from "react";
import { ArrowLeft, Check, RefreshCw, Plus, ExternalLink, Copy, Lock, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { toast } from "@/components/ui/sonner";
import { watchOAuthPopup } from "@/lib/oauthPopup";
import { IntegrationConn, AvailableProvider, IntegrationLogo } from "@/components/mind/entities";
import { PageHeader } from "@/components/ui/page-header";
import { useApiTopBar, useOpenConnect } from "@/components/shell/apiTopBarContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NousInstallTabs } from "@/components/integrations/TrackYourSignupsCard";
import { ComposioConfigCard } from "@/components/integrations/ComposioConfigCard";
import { roleOf } from "@/lib/roles";
import { fetchGoogleNative, connectNativeGoogle, isGoogleProduct } from "@/lib/googleConnect";
import { useTopBarCrumbs } from "@/components/shell/topBar";
import { SourcesToolbar, SourceCard, AddSourceCard, SourceGrid, type ManageAction } from "@/components/integrations/SourceCards";
import { PostHogEventsDialog } from "@/components/integrations/PostHogEventsDialog";
import { accountLine, anySyncing, sourceStatus, syncedLabel, type CardConn, type SyncProgress } from "@/components/integrations/sourceCardModel";
import { AddIntegrationDialog, type TileState } from "@/components/integrations/AddIntegrationDialog";
import { Button } from "@/components/ui/button";

// Gmail + Google Calendar connect through Composio, not our own OAuth app. The connect flow
// is start → open Composio consent popup → poll status, gated behind the Integration Engine
// (Composio key) being configured for the workspace.
const COMPOSIO_PROVIDERS = new Set(["gmail_oauth", "google_calendar"]);
const isComposio = (p: AvailableProvider | null) =>
  !!p && (COMPOSIO_PROVIDERS.has(p.name) || (p as any).managed_by === "composio");

import { cloud } from "@/lib/cloud";

const IntegrationSetup = cloud.integrationSetup;
const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Shown for providers whose API can't create a webhook for us (Fireflies, HubSpot).
// The auto ones never render this — they're the whole point. Here we show the exact URL
// to paste and a link straight to the page it gets pasted on.
function WebhookManualPanel({ displayName, url, settingsUrl, intro }: { displayName: string; url?: string; settingsUrl?: string | null; intro?: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="text-[12px] text-muted-foreground/80 rounded-lg border border-border bg-muted/40 px-3 py-2.5 space-y-2">
      {intro === null ? null : <div>{intro ?? `${displayName} can't set up its webhook from an API key, so after connecting, paste this into their settings:`}</div>}
      {url ? (
        <div className="flex items-start gap-1.5">
          <code className="flex-1 min-w-0 break-all rounded bg-background border border-border px-2 py-1 text-[11px] leading-relaxed text-foreground">{url}</code>
          <button onClick={copy} className="inline-flex items-center gap-1 h-7 px-2 rounded border border-border bg-background hover:bg-muted/60 text-[11px] font-medium shrink-0">
            {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <div className="text-muted-foreground/60">Your webhook URL appears on the Webhooks settings page once connected.</div>
      )}
      {settingsUrl && (
        <a href={settingsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline font-medium">
          Open {displayName} webhook settings <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// Hardcoded providers (API key based) — mirrors the real Integrations page.
// "nous" is the self-integration: drop the CLI into your product and your own
// signups/sub events flow into your Nous workspace. Pinned to the top.
const HARDCODED_PROVIDERS: AvailableProvider[] = [
  { id:"nous",       name:"nous",       display_name:"Nous",       logo_url:"/nous-logo.svg",                  category:"self"         },
  { id:"instantly",  name:"instantly",  display_name:"Instantly",  logo_url:"/provider-logos/instantly.svg",  category:"outbound"     },
  { id:"lemlist",    name:"lemlist",    display_name:"Lemlist",    logo_url:"/provider-logos/lemlist.svg",    category:"outbound"     },
  { id:"emailbison", name:"emailbison", display_name:"EmailBison", logo_url:"/provider-logos/emailbison.png", category:"outbound"     },
  { id:"heyreach",   name:"heyreach",   display_name:"HeyReach",   logo_url:"/provider-logos/heyreach.png",   category:"outbound"     },
  { id:"smartlead",  name:"smartlead",  display_name:"Smartlead",  logo_url:"/provider-logos/smartlead.png",  category:"outbound"     },
  { id:"apollo",     name:"apollo",     display_name:"Apollo",     logo_url:"/provider-logos/apollo.svg",     category:"enrichment"   },
  { id:"prospeo",    name:"prospeo",    display_name:"Prospeo",    logo_url:"/provider-logos/prospeo.svg",    category:"enrichment"   },
  { id:"findymail",  name:"findymail",  display_name:"Findymail",  logo_url:"/provider-logos/findymail.svg",  category:"enrichment"   },
  { id:"aiark",      name:"aiark",      display_name:"AI-Ark",     logo_url:"/provider-logos/aiark.png",      category:"enrichment"   },
  { id:"blitz",      name:"blitz",      display_name:"Blitz",      logo_url:"/provider-logos/blitz.svg",      category:"enrichment"   },
  { id:"leadmagic",  name:"leadmagic",  display_name:"LeadMagic",  logo_url:"/provider-logos/leadmagic.png",  category:"enrichment"   },
  { id:"millionverifier", name:"millionverifier", display_name:"MillionVerifier", logo_url:"/provider-logos/millionverifier.png", category:"verification" },
  { id:"neverbounce",     name:"neverbounce",     display_name:"NeverBounce",     logo_url:"/provider-logos/neverbounce.png",     category:"verification" },
  // BYOK key for the LinkedIn engager scrape (weekly + on-demand "scrape engagers").
  { id:"apify",     name:"apify",     display_name:"Apify",     logo_url:"/provider-logos/apify.svg",     category:"scraping"     },
  { id:"fireflies", name:"fireflies", display_name:"Fireflies.ai", logo_url:"/provider-logos/fireflies.svg", category:"meetings"     },
  { id:"fathom",    name:"fathom",    display_name:"Fathom",       logo_url:"/provider-logos/fathom.svg",    category:"meetings"     },
  { id:"cal_com",   name:"cal_com",   display_name:"Cal.com",      logo_url:"/provider-logos/cal_com.svg",   category:"meetings"     },
  // Stripe is a manual webhook — clicking Connect shows the per-workspace inbound URL
  // to paste into the user's own Stripe. No key, no OAuth, no Connect platform.
  { id:"stripe",    name:"stripe",    display_name:"Stripe",       logo_url:"/provider-logos/stripe.svg",    category:"billing"      },
  // LinkedIn connects natively (Unipile), not via a key form — clicking Connect in
  // the catalog hands off to connectLinkedIn(). It only appears here while NOT
  // connected; once accounts exist it renders as its own row on the main list.
  { id:"linkedin",  name:"linkedin",  display_name:"LinkedIn",     logo_url:"/provider-logos/linkedin.png",  category:"communication" },
  {
    id:"smtp", name:"smtp", display_name:"Custom SMTP / IMAP",
    logo_url:"/provider-logos/smtp.svg", category:"communication",
    auth_type: "credentials",
    auth_fields: [
      { name: "host",      label: "Mail server host",      type: "text",     placeholder: "smtp.yourdomain.com",  description: "Your provider's SMTP host. We derive the IMAP host automatically (smtp. → imap.)." },
      { name: "port",      label: "SMTP port",             type: "text",     placeholder: "587",                   description: "587 (STARTTLS) or 465 (SSL). Leave blank for 587.", optional: true },
      { name: "username",  label: "Email address",         type: "text",     placeholder: "you@yourdomain.com",   description: "The mailbox we poll for incoming messages." },
      { name: "password",  label: "Password",              type: "password", placeholder: "app-specific password", description: "For Gmail / Outlook, generate an app password — login password won't work." },
      { name: "imap_host", label: "IMAP host (optional)",  type: "text",     placeholder: "imap.yourdomain.com",  description: "Only fill in if your IMAP host doesn't match the smtp. → imap. pattern.", optional: true },
      { name: "imap_port", label: "IMAP port (optional)",  type: "text",     placeholder: "993",                   description: "Defaults to 993 (SSL).", optional: true },
    ],
  },
];

// Slack is the one Workspace-plan integration — the backend blocks connecting it off-plan and
// on self-host (assertIntegrationAllowed in workflowProviders.mjs). Mirror that here so other
// plans see it locked rather than getting an error on connect. Must match
// CUSTOM_ONLY_INTEGRATIONS in apps/api/src/lib/plans.mjs.
// CRMs are open to every plan (GET-517); Slack stays a team integration.
const CUSTOM_ONLY_INTEGRATIONS = new Set(["slack", "slack_personal"]);

// A few hardcoded cards are NOT active rows in the workflow_providers catalogue: "nous"
// is the self-integration, "linkedin" connects natively via Unipile, and "stripe" is a
// manual-webhook billing card. They will never appear in `dbMeta` (the API's is_active
// list), so keep them unconditionally. EVERY OTHER hardcoded card is gated on being
// present in dbMeta — so hiding a provider in the catalogue (is_active=false) actually
// removes its card here, instead of it lingering because the name is baked into
// HARDCODED_PROVIDERS below. (This was the bug: hidden providers like Apollo/Blitz kept
// rendering because the hardcoded array was spread in unconditionally.)
const HARDCODED_ONLY = new Set(["nous", "linkedin", "stripe"]);

// Personal vs company is decided by the API (providers/sourceScope.mjs) and arrives as
// `scope` on every catalogue provider and connection. The cards the catalogue doesn't hold
// (Nous, Stripe) are shared tools; LinkedIn has its own row under Personal integrations.
export type SourceScope = "personal" | "company";
const scopeOfProvider = (p: AvailableProvider): SourceScope => p.scope ?? "company";
const scopeOfConn = (c: IntegrationConn): SourceScope => c.scope ?? "company";

const CATEGORY_ORDER = ["self","crm","outbound","enrichment","verification","scraping","meetings","communication","billing","database","ai","analytics","productivity","other"] as const;
const CATEGORY_LABEL: Record<string,string> = {
  self:"Nous", crm:"CRM", outbound:"Outbound", enrichment:"Enrichment", verification:"Email verification", scraping:"Scraping", meetings:"Meetings",
  communication:"Communication", billing:"Billing", database:"Database", ai:"AI models", analytics:"Analytics",
  productivity:"Productivity", other:"Other",
};
function groupByCategory<T extends { category?: string }>(items: T[]): Array<[string, T[]]> {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const cat = (it.category && CATEGORY_ORDER.includes(it.category as any)) ? it.category : "other";
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(it);
  }
  return CATEGORY_ORDER
    .filter(c => buckets.has(c))
    .map(c => [c, buckets.get(c)!] as [string, T[]]);
}

// Rendered as its own page at /integrations, and embedded as a tab inside Settings.
// When embedded, the outer page shell (full-height scroll + padding) is dropped so it
// flows inside the Settings scroll container instead of nesting a second one.
export default function Integrations({ embedded = false, connectProvider, chromeless = false, onClose, scope, onWrongScope }: {
  embedded?: boolean;
  /** Render ONE side as its own page: "personal" = Personal integrations, "company" = Shared integrations.
   *  Omitted, both sections render on one page (the old Sources layout). */
  scope?: SourceScope;
  /** A `connect=` deep link for a provider that belongs on the OTHER page. The page hands it
   *  over instead of connecting here, because the new connection would then land in a list
   *  this page does not show and look like it silently failed. */
  onWrongScope?: (scope: SourceScope, slug: string) => void;
  /** Open this provider's connect flow on mount. Same job as `?connect=`, for the places
   *  that mount this component rather than navigate to it — the chat's connect cards. */
  connectProvider?: string;
  /** Render ONLY the connect dialog — no catalog, no page, no header.
   *
   *  The chat's connect cards mount this component to reuse the real connect flow. Mounting
   *  the whole page inside a dialog put Integrations' OWN dialog inside that one, so the
   *  operator landed on the Sources catalog and had to find the + button and pick the
   *  provider again — for a tool they had just clicked Configure on. */
  chromeless?: boolean;
  onClose?: () => void;
} = {}) {
  const { session, userData } = useAuth();
  const { can, loading: planLoading, selfHosted } = usePlan();
  // Self-host: tools whose OAuth app nous.env does not have yet (Gmail and Calendar share Google's).
  const setupIds = new Set<string>(((userData as { integrations_needing_setup?: string[] } | null)?.integrations_needing_setup) ?? []);
  const needsSetup = (name: string) => selfHosted && (setupIds.has(name) || (isGoogleProduct(name) && setupIds.has("gmail_oauth")));
  // The Integrations pages are a card grid (GET-631), on every plan since GET-660: as the two
  // standalone pages and, since Integrations moved into Settings (GET-1043), as its Personal and
  // Shared tabs too. In the chat, or anywhere without a side, it stays the list.
  const apiCards = !!scope && !chromeless;
  // Outside the API plan's own bar, the app's top bar names the side the way that bar does.
  useTopBarCrumbs(apiCards && !embedded ? [{ label: "Integrations", href: "/integrations" }, { label: scope === "company" ? "Shared" : "Personal" }] : null);
  // Slack is on the Workspace plan; self-host is Self-serve, so it stays locked there too
  // (GET-576). While the plan is still loading, don't lock — usePlan warns that gating before
  // the first response flickers items away from a Workspace customer on every cold load.
  const canEnterprise = planLoading || can("slack");
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  // Clerk rotates `token` every ~30s and on window focus. The connections fetch below must
  // NOT re-run on rotation — it wholesale-replaces liveConns and would race an in-flight
  // OAuth callback, briefly dropping a just-connected tile. Read the token from a ref and
  // key the effect on a stable "authenticated" flag instead of the rotating string.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const authed = !!token;

  const [dbProviders, setDbProviders] = useState<AvailableProvider[]>([]);
  const [dbMeta, setDbMeta] = useState<Record<string, AvailableProvider>>({});
  // provider name → the inbound URL to paste, for manual-webhook providers. Sourced from
  // the one endpoint that already knows them, so this file never builds a URL itself.
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  // Which side the catalog was opened from: "Add" under Personal integrations shows personal
  // tools, under Shared integrations shows the team's; the header + shows both.
  const [addScope, setAddScope] = useState<SourceScope | null>(null);
  const [connecting, setConnecting] = useState<AvailableProvider|null>(null);
  const [connApiKey, setConnApiKey] = useState("");
  const [connCreds, setConnCreds] = useState<Record<string,string>>({});
  const [connName, setConnName] = useState("");
  const [connTesting, setConnTesting] = useState(false);
  const [connTestResult, setConnTestResult] = useState<{verified:boolean;message:string}|null>(null);
  const [connSaving, setConnSaving] = useState(false);
  const [connSuccess, setConnSuccess] = useState<string|null>(null);
  const [connOAuthLoading, setConnOAuthLoading] = useState(false);
  // Composio "Integration Engine" config: is a Composio key set for this workspace? Gmail +
  // Calendar connect stay locked until it is. Managers configure it; everyone can connect once set.
  const [composioConfigured, setComposioConfigured] = useState(false);
  // False until the status check answers. `composioConfigured` starts false, so without this
  // the setup card flashed on every load for workspaces that are already configured.
  const [composioChecked, setComposioChecked] = useState(false);
  const canManageComposio = roleOf(userData) === "manager";
  // Is Composio set up for this workspace (server env or a pasted key)? Drives both the
  // Gmail/Calendar connect gate AND whether the setup card shows at all — once it's
  // configured there's nothing to do, so the card is hidden.
  useEffect(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/workspace/composio?workspace_id=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setComposioConfigured(!!d?.configured))
      .catch(() => {})
      .finally(() => setComposioChecked(true));
  }, [token, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Self-host with its own Google OAuth app (GET-765): Gmail + Calendar connect with Google
  // directly, no Composio. The API says which, per workspace. A Cloud build never asks — it is
  // always Composio — and any failure keeps the Composio flow.
  const [googleNative, setGoogleNative] = useState(false);
  useEffect(() => {
    fetchGoogleNative(apiUrl, token, workspaceId).then(setGoogleNative);
  }, [token, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stripe one-time "import existing customers" backfill (see runStripeBackfill below).
  const [stripeKey, setStripeKey] = useState("");
  const [stripeBackfill, setStripeBackfill] = useState<{busy:boolean; mode:"preview"|"apply"|null; result:any; error:string|null}>({busy:false, mode:null, result:null, error:null});
  const [liveConns, setLiveConns] = useState<IntegrationConn[]>([]);
  // The empty-state box used to show while the list was still loading ("Connect your email…"
  // for a second on a page that has connections). Nothing renders until the first load answers.
  const [connsLoaded, setConnsLoaded] = useState(false);
  const [linkedinStatus, setLinkedinStatus] = useState<{
    connected:boolean; needs_reconnect?:boolean; connection:any;
    connections?:any[]; limit?:number; used?:number; can_connect_more?:boolean;
  }|null>(null);
  const [linkedinBusy, setLinkedinBusy] = useState(false);

  const fetchLinkedInStatus = () => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/linkedin/status?workspaceId=${workspaceId}`, { headers:{ Authorization:`Bearer ${token}` } })
      .then(r=>r.ok?r.json():null).then(d=>{ if (d) setLinkedinStatus(d); }).catch(()=>{});
  };

  // The cards also show when each source last brought something in, and how far a running
  // backfill has got (sync_progress); only they ask for it.
  const connectionsUrl = () =>
    `${apiUrl}/api/workflow-providers/connections?workspace_id=${workspaceId}${apiCards ? "&include=last_synced,progress" : ""}`;

  useEffect(() => {
    const t = tokenRef.current;
    if (!t || !workspaceId) return;
    fetchLinkedInStatus();
    fetch(connectionsUrl(), { headers:{ Authorization:`Bearer ${t}` } })
      .then(r=>r.ok?r.json():({} as any)).then(d=>setLiveConns(d.connections??[])).catch(()=>{})
      .finally(() => setConnsLoaded(true));
    fetch(`${apiUrl}/api/workflow-providers`, { headers:{ Authorization:`Bearer ${t}` } })
      .then(r=>r.ok?r.json():({} as any)).then(d=>{
        // The API already returns only is_active providers, so there is nothing to
        // exclude here any more — that decision now lives in the catalogue, not in a
        // list kept in this file. Split into "extends a hardcoded card" (metadata to
        // merge) vs "new card" (render as-is).
        const list: any[] = d.providers || d || [];
        const hardcodedNames = new Set(HARDCODED_PROVIDERS.map(h=>h.name));
        setDbMeta(Object.fromEntries(list.map((p:any) => [p.name, p])));
        setDbProviders(list.filter((p:any) => p.auth_type !== "none" && !hardcodedNames.has(p.name)));
      }).catch(()=>{});
    fetch(`${apiUrl}/api/webhooks/urls?workspace_id=${workspaceId}`, { headers:{ Authorization:`Bearer ${t}` } })
      .then(r=>r.ok?r.json():({} as any)).then(d=>{
        setWebhookUrls(Object.fromEntries((d.urls||[]).map((u:any)=>[u.source, u.url])));
      }).catch(()=>{});
    // Keyed on `authed`/workspace, NOT the rotating token — a rotation must not re-fetch
    // and wipe the (optimistically-updated) connections list. See tokenRef note above.
  }, [authed, workspaceId, apiCards]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-pull the REAL connections from the server. Used after an OAuth round-trip so a tile
  // reflects what actually persisted — never a phantom "Connected" we assumed on popup close.
  const refreshConnections = () => {
    const t = tokenRef.current;
    if (!t || !workspaceId) return;
    fetch(connectionsUrl(), { headers:{ Authorization:`Bearer ${t}` } })
      .then(r=>r.ok?r.json():({} as any)).then(d=>setLiveConns(d.connections??[])).catch(()=>{});
  };
  // While any card is mid-sync, re-read every 10s so its percent moves; stop once none is.
  const syncing = apiCards && anySyncing(liveConns as Pick<CardConn, "is_verified" | "sync_progress">[]);
  useEffect(() => {
    if (!syncing) return;
    const id = window.setInterval(() => { if (document.visibilityState === "visible") refreshConnections(); }, 10_000);
    return () => window.clearInterval(id);
  }, [syncing, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The API plan's top bar refresh (GET-621) — only as its own page, never embedded in a dialog.
  useApiTopBar({ onRefresh: refreshConnections, enabled: !embedded && !chromeless });
  // "Your own data → API" in the Add integration dialog opens the shell's REST connect dialog.
  const openConnect = useOpenConnect();

  // Hardcoded cards carry the logos and the special "nous" self-integration; the DB
  // carries how each one connects and where its key lives. Merge so a hardcoded card
  // still gets its key_url / key_hint / webhook_mode.
  const allProviders: AvailableProvider[] = [
    ...HARDCODED_PROVIDERS
      // Only render a hardcoded card if the catalogue still lists it as active (present in
      // dbMeta) — or it's one of the intentional hardcoded-only cards. Hidden providers
      // (is_active=false) are absent from dbMeta, so they correctly drop off the page.
      .filter(h => HARDCODED_ONLY.has(h.name) || dbMeta[h.name])
      .map(h => ({ ...h, ...(dbMeta[h.name] ?? {}), logo_url: h.logo_url })),
    ...dbProviders,
  ];
  // A connection the workspace actually made stays visible even if we later hide the
  // provider from the catalogue — they still need to see and manage what they connected.
  const visibleConns = liveConns;
  const connected  = visibleConns.filter(i=>i.is_verified);
  const needsAuth  = visibleConns.filter(i=>!i.is_verified);
  const linkedinAccountCount = linkedinStatus?.connections?.length ?? 0;
  // Every provider can hold MULTIPLE connections — one per teammate, or several
  // accounts owned by the same person (three Gmails, three Fireflies). So the
  // catalog always offers every tool ("Add another") instead of hiding it once a
  // connection exists. How many are already on drives the row's hint + button label.
  // LinkedIn is the exception: it's native (Unipile) and manages its own per-rep
  // accounts inline, so it only appears in the catalog until the first account is on.
  const connCountByProvider = new Map<string, number>();
  for (const c of visibleConns) {
    const n = c.provider?.name ?? c.name;
    if (n) connCountByProvider.set(n, (connCountByProvider.get(n) ?? 0) + 1);
  }
  const catalogProviders = allProviders.filter(p =>
    (p.name === "linkedin" ? linkedinAccountCount === 0 : true)
    && (!addScope || (p.name === "linkedin" ? addScope === "personal" : scopeOfProvider(p) === addScope))
  );
  const isManager = roleOf(userData) === "manager";

  // The database is the only answer to "how does this connect" — see the auth_type
  // column on workflow_providers. This used to be a hardcoded list of provider
  // names kept in two files, and the two drifted: Salesforce ships a full PKCE
  // flow that the catalogue filtered out, and Gmail rendered a key form because
  // one list said "gmail" while the provider is named "gmail_oauth".
  const isOAuth = (p: AvailableProvider | null) => p?.auth_type === "oauth2";

  // presetName is passed when re-opening an EXISTING connection ("Update") so the
  // save upserts that same (workspace, provider, name) row. Adding a NEW connection
  // to an already-connected provider gets a uniquified default ("Fireflies.ai 2") so
  // it lands as its own row instead of overwriting the first.
  // What happens after a connection succeeds — and the reason it is one function.
  //
  // The three success paths (API key, OAuth popup, OAuth message) each cleared `connecting`
  // and closed the dialog by hand. In the page that is correct. Chromeless it was the bug the
  // operator kept hitting: clearing `connecting` drops the chromeless branch back to its
  // "Loading the connect form" spinner, and `setAddOpen(false)` is a programmatic state
  // change, so Radix never fires `onOpenChange` and `onClose` never runs. The connection had
  // genuinely worked; the dialog then sat on a spinner for a form it had already filled in.
  const finishConnect = () => {
    setConnecting(null);
    setConnSuccess(null);
    setAddOpen(false);
    // Chromeless has an owner above it, and closing means telling them.
    if (chromeless) onClose?.();
  };

  const startConnect = (p: AvailableProvider, presetName?: string) => {
    // LinkedIn is native (Unipile) — hand off to its own popup flow, not the
    // credential form. Close the catalog so the popup is unobstructed.
    if (p.name === "linkedin") { setAddOpen(false); connectLinkedIn(); return; }
    // Merge the hardcoded entry's form shape in, but never let it clobber the
    // provider's auth_type with an undefined — that would turn an OAuth provider
    // back into a key form.
    const hardcoded = HARDCODED_PROVIDERS.find(h => h.name === p.name);
    const merged = hardcoded
      ? { ...p, auth_fields: hardcoded.auth_fields ?? p.auth_fields, auth_type: hardcoded.auth_type ?? p.auth_type }
      : p;
    const existingCount = connCountByProvider.get(merged.name) ?? 0;
    const defaultName = presetName
      ?? (existingCount > 0 ? `${merged.display_name} ${existingCount + 1}` : merged.display_name);
    setConnecting(merged); setConnApiKey(""); setConnCreds({}); setConnName(defaultName);
    setConnTestResult(null); setConnSuccess(null); setConnOAuthLoading(false);
  };

  // LinkedIn (Unipile) — its own native connection, separate from the
  // workflow-provider OAuth/API-key flow. Opens the Unipile hosted-auth popup.
  const connectLinkedIn = async () => {
    if (!token || !workspaceId) return;
    setLinkedinBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/linkedin/connect?workspaceId=${workspaceId}`, { headers:{ Authorization:`Bearer ${token}` } });
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message || e.error || "Couldn't start LinkedIn connection"); }
      const { url } = await res.json();
      const w = 600, h = 700;
      window.open(url, "LinkedInUnipile", `width=${w},height=${h},left=${window.screenX+(window.outerWidth-w)/2},top=${window.screenY+(window.outerHeight-h)/2}`);
      let cleanup: (()=>void)|null = null;
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type !== "linkedin_auth") return;
        window.removeEventListener("message", onMessage); cleanup?.(); setLinkedinBusy(false);
        if (e.data.success) { toast.success("LinkedIn connected"); fetchLinkedInStatus(); }
        else toast.error("LinkedIn connection failed. Please try again.");
      };
      window.addEventListener("message", onMessage);
      cleanup = watchOAuthPopup({ onClose: () => { window.removeEventListener("message", onMessage); setLinkedinBusy(false); fetchLinkedInStatus(); } });
    } catch (err: any) { toast.error(err.message || "Failed to connect LinkedIn"); setLinkedinBusy(false); }
  };

  const disconnectLinkedIn = async (accountId?: string) => {
    if (!token || !workspaceId) return;
    if (!window.confirm(accountId
      ? "Disconnect this LinkedIn account? This removes the Unipile link and stops its signals + weekly engagement run."
      : "Disconnect LinkedIn? This removes the Unipile link and stops LinkedIn signals + the weekly engagement run.")) return;
    setLinkedinBusy(true);
    try {
      const qs = accountId ? `&accountId=${encodeURIComponent(accountId)}` : "";
      const res = await fetch(`${apiUrl}/api/linkedin/disconnect?workspaceId=${workspaceId}${qs}`, { method:"DELETE", headers:{ Authorization:`Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to disconnect");
      toast.success("LinkedIn disconnected");
      fetchLinkedInStatus();
    } catch (err: any) { toast.error(err.message || "Failed to disconnect"); }
    finally { setLinkedinBusy(false); }
  };

  // Deep-link connect: an agent (or any link) can send the user to
  // /settings?section=integrations&connect=<provider>. Auto-open that provider's
  // connect flow so a terminal-first user finishes OAuth in one click instead of
  // hunting for the tile. Runs once, after the provider catalog has loaded.
  // Chromeless mounts exist only to show the connect dialog, so open it immediately. In the
  // page, `addOpen` is the + button's job and this never runs.
  useEffect(() => { if (chromeless) setAddOpen(true); }, [chromeless]);

  const deepLinkHandled = useRef(false);
  const [deepLinkMiss, setDeepLinkMiss] = useState<string | null>(null);
  // A dialog that says "Opening…" forever is the worst failure mode there is: it looks like
  // it is working. Whatever goes wrong — a slow catalogue, a provider we can't resolve, a
  // fetch that never returns — after eight seconds it says so instead of spinning.
  const [openTimedOut, setOpenTimedOut] = useState(false);
  useEffect(() => {
    if (!chromeless) return;
    const t = setTimeout(() => setOpenTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, [chromeless]);
  useEffect(() => {
    // Wait for the CATALOGUE, not for `allProviders`.
    //
    // `allProviders` is never empty: three providers (nous, linkedin, stripe) are hardcoded-only
    // and present from the first render. So this fired before the fetch resolved, failed to find
    // hubspot, showed "open the catalog below" and latched the ref — leaving the chat's connect
    // dialog on "Loading the connect form" forever, because `connecting` was never set.
    if (deepLinkHandled.current) return;
    if (!Object.keys(dbMeta).length && !dbProviders.length) return;
    let slug = (connectProvider ?? "").toLowerCase();
    if (!slug) {
      try { slug = (new URLSearchParams(window.location.search).get("connect") ?? "").toLowerCase(); } catch { /* ignore */ }
    }
    if (!slug) return;
    deepLinkHandled.current = true;
    // Clear the param so a refresh doesn't re-trigger the flow.
    try { const u = new URL(window.location.href); u.searchParams.delete("connect"); window.history.replaceState({}, "", u.toString()); } catch { /* ignore */ }
    if (slug === "linkedin") {
      if (scope === "company" && onWrongScope) { onWrongScope("personal", slug); return; }
      connectLinkedIn(); return;
    }
    const gmailAliases = new Set(["gmail", "google", "gmail_oauth", "googlemail", "google-mail"]);
    const target = allProviders.find(p => p.name === slug || (gmailAliases.has(slug) && (p.name === "gmail" || p.name === "gmail_oauth")));
    if (target && scope && onWrongScope && scopeOfProvider(target) !== scope) {
      onWrongScope(scopeOfProvider(target), slug);
      return;
    }
    if (target) { startConnect(target); setAddOpen(true); return; }
    // Genuinely not in the catalogue — hidden, or a name we don't ship. Say so where the
    // person is, rather than as a toast over a dialog that will now never fill in.
    setDeepLinkMiss(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbMeta, dbProviders, connectProvider]);

  // One-time Stripe backfill: import a workspace's EXISTING payments so customers who
  // already paid flip to Client. Sends a read-only restricted key to the server, which
  // runs the import and never stores it. Preview (apply=false) first, then Import.
  const runStripeBackfill = async (apply: boolean) => {
    if (!token || !workspaceId || !stripeKey.trim()) return;
    setStripeBackfill({ busy: true, mode: apply ? "apply" : "preview", result: null, error: null });
    try {
      const res = await fetch(`${apiUrl}/api/stripe-connect/backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, restrictedKey: stripeKey.trim(), apply }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setStripeBackfill({ busy: false, mode: null, result: null, error: data?.message || data?.error || "Backfill failed" }); return; }
      setStripeBackfill({ busy: false, mode: apply ? "apply" : "preview", result: data, error: null });
      if (apply) { setStripeKey(""); toast.success(`Imported ${data?.stats?.logged ?? 0} payment(s) — matched customers are now Client.`); }
    } catch (err: any) {
      setStripeBackfill({ busy: false, mode: null, result: null, error: err?.message || "Backfill failed" });
    }
  };

  // Gmail + Google Calendar via Composio: start a hosted consent, open it in a popup, then
  // poll status until the connected account goes ACTIVE (or the popup closes). No postMessage
  // dance — Composio's redirect page is theirs, not ours, so we reconcile by polling.
  const handleComposioConnect = async () => {
    if (!connecting || !workspaceId || !token) return;
    if (selfHosted) {
      // Self-host never goes through Composio: without its own Google OAuth app there is no way in.
      setConnTestResult({ verified: false, message: "Gmail and Google Calendar need this install's Google OAuth app. See Settings → Instance setup." });
      return;
    }
    if (!composioConfigured) {
      setConnTestResult({ verified: false, message: "Connect the Integration Engine (Composio) first — an admin pastes the Composio key once at the top of this page." });
      return;
    }
    setConnOAuthLoading(true);
    const provider = connecting;
    try {
      const resp = await fetch(`${apiUrl}/api/connect/composio/start?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: provider.name }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.redirect_url) {
        setConnTestResult({ verified: false, message: data.message || data.error || "Couldn't start the Google connection." });
        setConnOAuthLoading(false);
        return;
      }
      const reqId = data.connection_request_id;
      const w = 600, h = 700;
      window.open(data.redirect_url, `${provider.name}Composio`, `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`);

      let done = false;
      const finish = (ok: boolean, message?: string) => {
        if (done) return; done = true;
        clearInterval(poll); cleanup?.();
        setConnOAuthLoading(false);
        if (ok) {
          setConnSuccess(provider.display_name);
          refreshConnections();
          setTimeout(finishConnect, 1500);
        } else if (message) {
          setConnTestResult({ verified: false, message });
        } else {
          refreshConnections();  // popup closed with no verdict — reflect whatever persisted
        }
      };

      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${apiUrl}/api/connect/composio/status?workspace_id=${workspaceId}&provider=${encodeURIComponent(provider.name)}&connection_request_id=${encodeURIComponent(reqId)}`, {
            headers: { Authorization: `Bearer ${tokenRef.current}` },
          });
          const sd = await s.json().catch(() => ({}));
          if (sd.status === "connected") finish(true);
          else if (sd.status === "failed") finish(false, "Google didn't approve the connection. Try again.");
        } catch { /* keep polling */ }
      }, 2000);

      const cleanup = watchOAuthPopup({ onClose: () => finish(false) });
    } catch {
      setConnTestResult({ verified: false, message: "Couldn't start the Google connection." });
      setConnOAuthLoading(false);
    }
  };

  // Self-host with its own Google OAuth app (GET-765): sign in with Google in a popup, then this
  // page finishes the connection with the member's own session (lib/googleConnect.ts).
  const handleNativeGoogleConnect = async () => {
    if (!connecting || !workspaceId || !isGoogleProduct(connecting.name)) return;
    const provider = connecting;
    setConnOAuthLoading(true);
    try {
      const r = await connectNativeGoogle({ apiUrl, workspaceId, provider: provider.name as "gmail_oauth" | "google_calendar", getToken: () => tokenRef.current });
      setConnOAuthLoading(false);
      if (r.ok) {
        setConnSuccess(provider.display_name);
        refreshConnections();
        setTimeout(finishConnect, 1500);
      } else if ("message" in r) {
        setConnTestResult({ verified: false, message: r.message });
      } else {
        refreshConnections();
      }
    } catch {
      setConnTestResult({ verified: false, message: "Couldn't start the Google connection." });
      setConnOAuthLoading(false);
    }
  };

  const handleOAuthConnect = async () => {
    if (!connecting || !workspaceId || !token) return;
    if (googleNative && isGoogleProduct(connecting.name)) return handleNativeGoogleConnect();
    if (isComposio(connecting)) return handleComposioConnect();
    setConnOAuthLoading(true);
    try {
      const url = `${apiUrl}/api/workflow-providers/${connecting.name}/oauth/authorize?workspace_id=${workspaceId}&connectionName=${encodeURIComponent(connName.trim() || connecting.display_name)}`;

      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setConnTestResult({ verified: false, message: body.message || "Failed to initiate OAuth" });
        setConnOAuthLoading(false);
        return;
      }
      const data = await resp.json();
      const authUrl = data.authUrl || data.authorization_url;
      if (!authUrl) { setConnTestResult({ verified: false, message: "No authorization URL returned" }); setConnOAuthLoading(false); return; }

      const w = 600, h = 700;
      const provider = connecting;
      window.open(authUrl, `${provider.name}OAuth`, `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`);

      // The popup posts back { type:'oauth-callback', success } from oauth-callback.html.
      // Only a REAL success marks the tile connected (then we re-pull the server's actual
      // connections). A failure — e.g. Google blocks an unverified app's Gmail scopes, or the
      // user cancels — must NOT show a phantom "Connected"; it says what went wrong. If the
      // popup closes with no message at all, we just reconcile against the server.
      let cleanup: (() => void) | null = null;
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type !== "oauth-callback") return;
        window.removeEventListener("message", onMessage); cleanup?.();
        setConnOAuthLoading(false);
        if (e.data.success) {
          setConnSuccess(provider.display_name);
          refreshConnections();
          setTimeout(finishConnect, 1500);
        } else {
          setConnTestResult({ verified: false, message: "Google didn't approve the connection. If the app isn't verified yet, add this Google account as a test user (or finish verification) and try again." });
        }
      };
      window.addEventListener("message", onMessage);
      cleanup = watchOAuthPopup({
        onClose: () => {
          window.removeEventListener("message", onMessage);
          setConnOAuthLoading(false);
          refreshConnections();  // no phantom row — reflect whatever actually persisted
        },
      });
    } catch { setConnTestResult({ verified: false, message: "OAuth failed" }); setConnOAuthLoading(false); }
  };

  const [disconnecting, setDisconnecting] = useState<string|null>(null);
  // The PostHog connection whose events are being edited (GET-751).
  const [posthogEventsFor, setPosthogEventsFor] = useState<string | null>(null);
  // The connection the user is being asked to confirm removing. A real dialog, not the
  // browser's "localhost says" confirm().
  const [confirmDisconnect, setConfirmDisconnect] = useState<IntegrationConn|null>(null);

  const disconnect = (conn: IntegrationConn) => setConfirmDisconnect(conn);

  const doDisconnect = async () => {
    const conn = confirmDisconnect;
    if (!conn || !workspaceId || !token) return;
    setDisconnecting(conn.id);
    setConfirmDisconnect(null);
    try {
      const res = await fetch(`${apiUrl}/api/workflow-providers/connections/${conn.id}?workspace_id=${workspaceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      setLiveConns(prev => prev.filter(c => c.id !== conn.id));
      toast.success(`${conn.provider?.display_name || conn.name} disconnected`);
    } catch (e: any) {
      toast.error(e.message || "Disconnect failed");
    } finally {
      setDisconnecting(null);
    }
  };

  const isMultiField = !!connecting?.auth_fields && connecting.auth_fields.length > 0
    && !(connecting.auth_fields.length === 1 && connecting.auth_fields[0].name === "api_key");

  const credsComplete = () => {
    if (!connecting) return false;
    if (!isMultiField) return !!connApiKey.trim();
    return (connecting.auth_fields || [])
      .filter(f => !f.optional)
      .every(f => (connCreds[f.name] || "").trim() !== "");
  };

  const testConnection = async () => {
    if (!connecting || !credsComplete()) return;
    setConnTesting(true); setConnTestResult(null);
    try {
      let res: Response;
      if (isMultiField) {
        const provRes = await fetch(`${apiUrl}/api/workflow-providers`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const provData = await provRes.json().catch(() => ({}));
        const provider = (provData.providers || []).find((p: any) => p.name === connecting.name);
        if (!provider?.id) throw new Error(`Provider ${connecting.name} not found`);
        res = await fetch(`${apiUrl}/api/workflow-providers/connections/test`, {
          method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${token}`},
          body: JSON.stringify({ provider_id: provider.id, credentials: connCreds }),
        });
      } else {
        res = await fetch(`${apiUrl}/api/workflow-providers/${connecting.name}/test`, {
          method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${token}`},
          body: JSON.stringify({ api_key: connApiKey }),
        });
      }
      setConnTestResult(await res.json());
    } catch (e: any) { setConnTestResult({ verified:false, message: e.message || "Connection failed" }); }
    finally { setConnTesting(false); }
  };

  const saveConnection = async () => {
    if (!connecting || !connTestResult?.verified) return;
    setConnSaving(true);
    try {
      let res: Response;
      if (isMultiField) {
        const provRes = await fetch(`${apiUrl}/api/workflow-providers`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const provData = await provRes.json().catch(() => ({}));
        const provider = (provData.providers || []).find((p: any) => p.name === connecting.name);
        if (!provider?.id) throw new Error(`Provider ${connecting.name} not found`);
        res = await fetch(`${apiUrl}/api/workflow-providers/connections`, {
          method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${token}`},
          body: JSON.stringify({ workspace_id: workspaceId, provider_id: provider.id, name: connName.trim()||connecting.display_name, credentials: connCreds, is_verified: true }),
        });
      } else {
        res = await fetch(`${apiUrl}/api/workflow-providers/${connecting.name}/connect`, {
          method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${token}`},
          body: JSON.stringify({ workspace_id: workspaceId, name: connName.trim()||connecting.display_name, api_key: connApiKey }),
        });
      }
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.note) toast.info(body.note);
        setConnSuccess(connecting.display_name);
        setLiveConns(prev => [...prev, { id: Date.now().toString(), name: connName.trim()||connecting.display_name, is_verified: true, scope: scopeOfProvider(connecting), is_mine: true, can_manage: true, provider: { display_name: connecting.display_name, logo_url: connecting.logo_url, category: connecting.category, name: connecting.name } }]);
        refreshConnections();
        setTimeout(finishConnect, 1500);
      } else {
        const err = await res.json().catch(()=>({}));
        setConnTestResult({ verified:false, message: err.error||"Failed to save" });
      }
    } catch { setConnTestResult({ verified:false, message:"Save failed" }); }
    finally { setConnSaving(false); }
  };

  // Two lists, one rule: the API decides each connection's scope and has already dropped
  // teammates' personal sources, so what arrives here is exactly what this viewer may see.
  const allConns = [...connected, ...needsAuth];
  const personalConns = allConns.filter(c => scopeOfConn(c) === "personal");
  const companyConns = allConns.filter(c => scopeOfConn(c) === "company");
  // LinkedIn renders as its own row under Personal integrations once this person has an account;
  // before that it lives in the catalog like any tool.
  const showLinkedInRow = linkedinAccountCount > 0;
  const openCatalog = (scope: SourceScope | null) => { setConnecting(null); setAddScope(scope); setAddOpen(true); };

  // One connection row, for either list. Update and Disconnect show only where the API
  // said this viewer may change it (their own personal source; a company one for admins).
  const providerOf = (conn: IntegrationConn): AvailableProvider => ({
    id: conn.provider?.name ?? conn.name,
    name: conn.provider?.name ?? conn.name,
    display_name: conn.provider?.display_name ?? conn.name,
    logo_url: conn.provider?.logo_url,
    category: conn.provider?.category,
    auth_type: conn.provider?.auth_type,
    scope: conn.scope,
  });
  const renderConn = (conn: any) => {
    const providerForConnect = providerOf(conn);
    const sub = [
      conn.name && conn.name !== (conn.provider?.display_name ?? "") ? conn.name : null,
      scopeOfConn(conn) === "company" && conn.owner_name ? `Connected by ${conn.is_mine ? "you" : conn.owner_name}` : null,
    ].filter(Boolean).join(" · ");
    const canManage = conn.can_manage !== false;
    return (
      <div key={conn.id} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover transition-colors duration-fast group">
        <IntegrationLogo url={conn.provider?.logo_url} name={conn.provider?.display_name??conn.name} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-foreground">{conn.provider?.display_name??conn.name}</div>
          {sub && <div className="text-[12px] text-muted-foreground/70 truncate">{sub}</div>}
        </div>
        {IntegrationSetup && conn.provider?.name === "slack" && <Suspense fallback={null}><IntegrationSetup provider="slack" token={token} workspaceId={workspaceId} canManage={canManage && isManager} /></Suspense>}
        <span className={`text-[11px] px-2 py-0.5 rounded-md border flex-shrink-0 ${conn.is_verified?"text-emerald-700 border-emerald-200 bg-emerald-50":"text-amber-700 border-amber-200 bg-amber-50"}`}>
          {conn.is_verified ? "Connected" : "Needs auth"}
        </span>
        {(conn.provider?.name === "calendly" || conn.provider?.name === "cal_com") && conn.webhook_registered && (
          <span title="Webhook auto-registered — bookings and cancellations flow into your CRM automatically." className="text-[11px] px-2 py-0.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 flex-shrink-0">
            Webhook ✓
          </span>
        )}
        {canManage && (
          <>
            <button onClick={()=>{ startConnect(providerForConnect, conn.name); setAddScope(null); setAddOpen(true); }}
              className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 ml-2 rounded-md border border-border px-2.5 py-1 hover:bg-muted/50">
              Update
            </button>
            <button onClick={()=>disconnect(conn)} disabled={disconnecting===conn.id}
              title="Disconnect this integration"
              className="text-[12px] font-medium text-muted-foreground hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 rounded-md border border-border px-2.5 py-1 hover:border-red-200 disabled:opacity-40">
              {disconnecting===conn.id ? "Removing…" : "Disconnect"}
            </button>
          </>
        )}
      </div>
    );
  };

  const addButton = scope === "company" && !isManager ? null : (
    <button onClick={() => openCatalog(scope ?? null)}
      aria-label="Add an integration"
      data-tour="add-integration"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 text-[12.5px] text-foreground transition-colors duration-fast hover:bg-hover">
      <Plus className="h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={1.75} />Add
    </button>
  );

  // The connect flow itself. Hoisted so the chat's cards can render exactly this and
  // nothing else — mounting the whole page inside a dialog nested this one and dropped
  // the operator on the catalog for a provider they had already chosen.
  // The connect form for the provider being connected — key form, OAuth button, Stripe's
  // webhook panel, the Nous install tabs. One form, shown by both the list's dialog and the
  // API plan's two-pane one (GET-638).
  const connectForm = !connecting ? null : (
    connSuccess ? (
      <div className="text-center py-10">
        <Check className="h-9 w-9 text-emerald-600 mx-auto mb-2"/>
        <div className="text-[14px] font-semibold text-emerald-700">{connSuccess} connected</div>
      </div>
    ) : connecting.name === "nous" ? (
      <div className="rounded-xl border border-border p-5">
        <NousInstallTabs />
      </div>
    ) : connecting.name === "stripe" ? (
      <div className="rounded-xl border border-border p-5 space-y-4">
        <div className="text-[13px] text-foreground/90">
          Connect your Stripe so payments auto-convert accounts to <span className="font-medium">Client</span>. In your Stripe dashboard, add a webhook pointing at this URL:
        </div>
        <WebhookManualPanel displayName="Stripe" intro={null} url={`${apiUrl}/inbound/stripe/${workspaceId}`} settingsUrl="https://dashboard.stripe.com/webhooks/create" />
        <div className="text-[12px] text-muted-foreground/80">
          Select events <code className="text-foreground">payment_intent.succeeded</code> and <code className="text-foreground">invoice.paid</code>. When a customer pays, the matching account and everyone at their company flip to Client, out of the funnel onto the client health axis.
        </div>

        {/* One-time import of EXISTING payments — the webhook only catches go-forward ones. */}
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 space-y-2">
          <div className="text-[12px] font-medium text-foreground/90">Import existing customers <span className="font-normal text-muted-foreground/70">— optional, one-time</span></div>
          <div className="text-[12px] text-muted-foreground/80">
            The webhook only closes the loop for payments from here on. To also flip customers who <span className="italic">already</span> paid, paste a read-only Stripe restricted key — we run a one-time import and never store it.
          </div>
          <div className="flex items-start gap-1.5">
            <input
              value={stripeKey}
              onChange={(e) => setStripeKey(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder="rk_live_…"
              className="flex-1 min-w-0 rounded bg-background border border-border px-2 py-1 text-[12px] font-mono text-foreground"
            />
            <button
              onClick={() => runStripeBackfill(false)}
              disabled={!stripeKey.trim() || stripeBackfill.busy}
              className="inline-flex items-center gap-1 h-7 px-2 rounded border border-border bg-background hover:bg-muted/60 text-[11px] font-medium shrink-0 disabled:opacity-50"
            >
              {stripeBackfill.busy && stripeBackfill.mode === "preview" ? "Checking…" : "Preview"}
            </button>
          </div>
          <a href="https://dashboard.stripe.com/apikeys/create?name=Nous%20import" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-[11px] font-medium">
            Create a restricted key <ExternalLink className="h-3 w-3" />
          </a>
          <span className="text-[11px] text-muted-foreground/70"> — grant Read on Charges + Customers.</span>

          {stripeBackfill.error && (
            <div className="text-[12px] text-red-600">{stripeBackfill.error}</div>
          )}
          {stripeBackfill.result && stripeBackfill.mode === "preview" && (
            <div className="text-[12px] text-foreground/80 space-y-2 pt-1">
              <div>
                Found <span className="font-medium">{stripeBackfill.result.matchedPayers}</span> existing customer(s) across{" "}
                <span className="font-medium">{stripeBackfill.result.stats?.succeeded ?? 0}</span> payment(s).
                {(stripeBackfill.result.stats?.unmatched ?? 0) > 0 && (
                  <> {stripeBackfill.result.stats.unmatched} payer(s) aren’t contacts yet — skipped.</>
                )}
                {stripeBackfill.result.stats?.reachedLimit && <> (scan limit reached — some older charges not checked.)</>}
              </div>
              {(stripeBackfill.result.dealValues?.length ?? 0) > 0 && (
                <div className="text-muted-foreground/80">
                  {(() => {
                    const dvs = stripeBackfill.result.dealValues as Array<{total:number;currency:string|null;mixedCurrency:boolean}>;
                    const mixed = stripeBackfill.result.stats?.mixedCurrency || dvs.some(d => d.mixedCurrency);
                    const cur = dvs.find(d => d.currency)?.currency || "";
                    const sum = dvs.reduce((s, d) => s + (d.total || 0), 0);
                    return mixed
                      ? <>Deal value will be set per account (multiple currencies — summed per payer).</>
                      : <>Deal value to set: <span className="font-medium text-foreground">{cur} {sum.toLocaleString()}</span> across {dvs.length} account(s) — each payer’s total of their invoices.</>;
                  })()}
                </div>
              )}
              {stripeBackfill.result.matchedPayers > 0 ? (
                <button
                  onClick={() => runStripeBackfill(true)}
                  disabled={stripeBackfill.busy}
                  className="inline-flex items-center gap-1 h-7 px-3 rounded bg-foreground text-background hover:opacity-90 text-[11px] font-medium disabled:opacity-50"
                >
                  {stripeBackfill.busy && stripeBackfill.mode === "apply" ? "Importing…" : `Import ${stripeBackfill.result.matchedPayers} customer(s) → Client`}
                </button>
              ) : (
                <div className="text-muted-foreground/70">Nothing to import — no past payers match an existing contact.</div>
              )}
            </div>
          )}
          {stripeBackfill.result && stripeBackfill.mode === "apply" && (
            <div className="text-[12px] text-emerald-700 pt-1">
              ✓ Imported {stripeBackfill.result.stats?.logged ?? 0} payment(s){(stripeBackfill.result.stats?.deduped ?? 0) > 0 ? ` (${stripeBackfill.result.stats.deduped} already recorded)` : ""}. Matched customers are now Client{(stripeBackfill.result.stats?.dealValuesSet ?? 0) > 0 ? `, with deal value set on ${stripeBackfill.result.stats.dealValuesSet} account(s)` : ""}.
            </div>
          )}
        </div>
      </div>
    ) : isOAuth(connecting) ? (
      <div className="rounded-xl border border-border p-5 space-y-4">
        <div>
          <div className="text-[11px] font-medium text-muted-foreground/70 mb-1.5">Connection name</div>
          <input value={connName} onChange={e=>setConnName(e.target.value)}
            className="w-full h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground focus:border-foreground/40 outline-none"/>
        </div>
        {connTestResult && (
          <div className="text-[12px] px-3 py-2 rounded-lg border text-red-600 border-red-200 bg-red-50">
            {connTestResult.message}
          </div>
        )}
        <button onClick={handleOAuthConnect} disabled={connOAuthLoading}
          className="w-full inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40">
          {connOAuthLoading ? <><RefreshCw className="h-3.5 w-3.5 animate-spin"/>Connecting…</> : `Connect ${connecting?.display_name} via OAuth`}
        </button>
        <p className="text-[12px] text-muted-foreground/70 text-center">You'll be redirected to authorize securely</p>
      </div>
    ) : (
      <div className="min-w-0 rounded-xl border border-border p-5 space-y-4">
        <div>
          <div className="text-[11px] font-medium text-muted-foreground/70 mb-1.5">Connection name</div>
          <input value={connName} onChange={e=>setConnName(e.target.value)}
            className="w-full h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground focus:border-foreground/40 outline-none"/>
        </div>

        {isMultiField ? (
          (connecting?.auth_fields || []).map(f => (
            <div key={f.name}>
              <div className="text-[11px] font-medium text-muted-foreground/70 mb-1.5">{f.label}{f.optional ? <span className="text-muted-foreground/50 ml-1.5">(optional)</span> : null}</div>
              <input
                type={f.type === "password" ? "password" : "text"}
                value={connCreds[f.name] || ""}
                onChange={e => setConnCreds(prev => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.placeholder || ""}
                onKeyDown={e => { if (e.key === "Enter" && credsComplete()) testConnection(); }}
                className="w-full h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground focus:border-foreground/40 outline-none placeholder:text-muted-foreground/70"
              />
              {f.description && <p className="text-[12px] text-muted-foreground/70 mt-1">{f.description}</p>}
            </div>
          ))
        ) : (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-[11px] font-medium text-muted-foreground/70 min-w-0 truncate">API key</div>
              {connecting?.key_url && (
                <a href={connecting.key_url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline shrink-0 whitespace-nowrap">
                  Get your API key <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <input type="password" value={connApiKey} onChange={e=>setConnApiKey(e.target.value)}
              placeholder="Paste your key…"
              onKeyDown={e=>{if(e.key==="Enter")testConnection();}}
              className="w-full h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground focus:border-foreground/40 outline-none placeholder:text-muted-foreground/70"/>
            {/* Only when there's no deep link — the "Get your API key" button above
                replaces the written directions. Linkless providers still get them. */}
            {!connecting?.key_url && connecting?.key_hint && (
              <p className="text-[12px] text-muted-foreground/70 mt-1.5">{connecting.key_hint}</p>
            )}
          </div>
        )}

        {/* What happens to the webhook once we have the key. 'auto' is the whole
            pitch: paste the key and events wire themselves up. 'manual' is honest
            about the providers whose API can't do that. */}
        {connecting?.webhook_mode === "auto" && (
          <div className="flex items-start gap-2 text-[12px] text-emerald-700 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
            <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>We'll set up the webhook automatically from your key. Nothing else to do.</span>
          </div>
        )}
        {connecting?.webhook_mode === "manual" && (
          <WebhookManualPanel
            displayName={connecting.display_name}
            url={webhookUrls[connecting.name]}
            settingsUrl={connecting.webhook_settings_url}
          />
        )}

        {connTestResult && (
          <div className={`text-[12px] px-3 py-2 rounded-lg border ${connTestResult.verified?"text-emerald-700 border-emerald-200 bg-emerald-50":"text-red-600 border-red-200 bg-red-50"}`}>
            {connTestResult.message}
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={testConnection} disabled={connTesting||!credsComplete()}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-40">
            {connTesting?<><RefreshCw className="h-3.5 w-3.5 animate-spin"/>Testing…</>:"Test connection"}
          </button>
          <button onClick={saveConnection} disabled={connSaving||!connTestResult?.verified}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40">
            {connSaving?<><RefreshCw className="h-3.5 w-3.5 animate-spin"/>Saving…</>:"Save"}
          </button>
        </div>
      </div>
    )
  );

  const addDialog = (
  <Dialog open={addOpen} onOpenChange={(o)=>{ setAddOpen(o); if (!o) { setConnecting(null); if (chromeless) onClose?.(); } }}>
    <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
      <DialogHeader>
        <DialogTitle className="text-[18px] font-bold tracking-tight text-foreground">
          {connecting ? (
            <span className="flex items-center gap-2.5">
              <button onClick={()=>setConnecting(null)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-lg border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
                <ArrowLeft className="h-3.5 w-3.5"/>
              </button>
              <IntegrationLogo url={connecting.logo_url} name={connecting.display_name} size={24}/>
              {connecting.display_name}
            </span>
          ) : addScope === "personal" ? "Add one of your sources" : addScope === "company" ? "Add a company source" : "Add a source"}
        </DialogTitle>
      </DialogHeader>

      {connecting ? (
        connectForm
      ) : (
        catalogProviders.length === 0 ? (
          <div className="text-[13px] text-muted-foreground/70 text-center py-12">No integrations available</div>
        ) : (
          <div className="space-y-6">
            {(["personal", "company"] as SourceScope[])
              .map(scope => [scope, catalogProviders.filter(p => (p.name === "linkedin" ? "personal" : scopeOfProvider(p)) === scope)] as [SourceScope, AvailableProvider[]])
              .filter(([, list]) => list.length > 0)
              .map(([scope, list]) => (
              <div key={scope} className="space-y-4">
                {!addScope && (
                  <div>
                    <div className="text-[13px] font-semibold text-foreground">{scope === "personal" ? "Personal integrations" : "Shared integrations"}</div>
                    <div className="text-[12px] text-muted-foreground/70">{scope === "personal" ? "Each person connects their own." : "One connection for the whole team."}</div>
                  </div>
                )}
            {groupByCategory(list).map(([cat, items]) => (
              <div key={cat}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2">
                  {CATEGORY_LABEL[cat]} <span className="text-muted-foreground/50 font-normal ml-1">{items.length}</span>
                </div>
                <div className="rounded-xl border border-border overflow-hidden">
                  {items.map(p => {
                    const isSoon = (p as any).coming_soon;
                    const isSetup = !isSoon && needsSetup(p.name);
                    const isLocked = CUSTOM_ONLY_INTEGRATIONS.has(p.name) && !canEnterprise;
                    const adminOnly = scope === "company" && !isManager;
                    const already = connCountByProvider.get(p.name) ?? 0;
                    return (
                      <div key={p.id} className={`flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-fast group ${(isSoon || isSetup || isLocked || adminOnly) ? "opacity-60" : "hover:bg-hover"}`}>
                        <IntegrationLogo url={p.logo_url} name={p.display_name} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] text-foreground">{p.display_name}</div>
                          {already > 0 && (
                            <div className="text-[11.5px] text-muted-foreground/70">{already} connected</div>
                          )}
                        </div>
                        {isSoon ? (
                          <span className="text-[11px] text-muted-foreground/70 rounded-md border border-border px-2 py-0.5 flex-shrink-0 uppercase tracking-wide">
                            Coming soon
                          </span>
                        ) : isSetup ? (
                          <a href="/settings?section=instance" title="This install needs its OAuth app first. See Instance setup."
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground rounded-md border border-border px-2 py-0.5 flex-shrink-0 hover:text-foreground hover:border-foreground/30 transition-colors">
                            Needs setup
                          </a>
                        ) : isLocked ? (
                          <a href="/settings?section=billing" title="Available on Workspace"
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground rounded-md border border-border px-2 py-0.5 flex-shrink-0 hover:text-foreground hover:border-foreground/30 transition-colors">
                            <Lock className="h-3 w-3" /> Headless plan
                          </a>
                        ) : adminOnly ? (
                          <span title="Shared integrations belong to the whole team, so owners and admins connect them."
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground rounded-md border border-border px-2 py-0.5 flex-shrink-0">
                            <Lock className="h-3 w-3" /> Admins connect this
                          </span>
                        ) : (
                          <button onClick={()=>startConnect(p)}
                            className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 rounded-md border border-border px-2.5 py-1 hover:bg-muted/50">
                            {already > 0 ? "Add another" : "Connect"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
              </div>
            ))}
          </div>
        )
      )}
    </DialogContent>
  </Dialog>

  );

  // Chromeless: the connect dialog and nothing else. The dialog below is rendered by the
  // same JSX either way, so there is one connect flow, not a copy of it.
  // Chromeless: the connect form for ONE provider, and nothing else.
  //
  // The catalog must never appear here. `startConnect` only fires once the provider list has
  // loaded, so rendering the shared dialog straight away showed "Add an integration" with the
  // whole catalog for a beat — which is the selector the operator kept landing on after
  // clicking Connect on a tool they had already chosen.
  if (chromeless) {
    if (connecting) return addDialog;
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose?.(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {deepLinkMiss || openTimedOut ? "Couldn't open that one" : "Opening…"}
            </DialogTitle>
          </DialogHeader>
          {deepLinkMiss || openTimedOut ? (
            // A spinner that never resolves is the worst of both: it looks like it is working
            // and it never will. Say what happened and where to go instead.
            <p className="py-6 text-[13px] leading-relaxed text-muted-foreground/80">
              {deepLinkMiss
                ? `${deepLinkMiss} isn't in your catalogue — it may not be available on your plan.`
                : "The connect form didn't load."}{" "}
              You can connect it from Settings → Sources.
            </p>
          ) : (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground/70">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the connect form
            </div>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  // Disconnect confirmation — a real dialog in place of window.confirm().
  const disconnectDialog = (
    <Dialog open={!!confirmDisconnect} onOpenChange={o => { if (!o) setConfirmDisconnect(null); }}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Disconnect {confirmDisconnect?.provider?.display_name || confirmDisconnect?.name}?</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          This removes the stored credentials and tears down any webhook we registered.
          {" "}Data already in your graph stays. You can reconnect any time.
          {googleNative && isGoogleProduct(confirmDisconnect?.provider?.name) && (
            <>{" "}Your Google grant is revoked only when nothing else on this server uses that Google account: disconnecting Gmail while Google Calendar stays connected keeps it.</>
          )}
        </p>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={() => setConfirmDisconnect(null)}
            className="h-9 px-3.5 rounded-lg border border-border bg-background text-[13px] font-semibold text-foreground/80 hover:bg-muted/50 transition-colors">
            Cancel
          </button>
          <button onClick={doDisconnect}
            className="h-9 px-3.5 rounded-lg bg-red-600 text-white text-[13px] font-semibold hover:bg-red-700 transition-colors">
            Disconnect
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );

  // The API plan: Personal and Shared as one card grid each (GET-631). Every action the list
  // below offers stays reachable from a card's manage menu: update or reconnect, disconnect, and
  // LinkedIn's per-account add and disconnect.
  // The API plan's two-pane Add integration dialog (GET-638). Same state and flows as the list's
  // dialog: `addOpen` opens it, `connecting` is the tool in its detail step, and the connect
  // buttons call the existing OAuth / LinkedIn / key-form handlers.
  const apiAddDialog = () => {
    const scopeOfTool = (p: AvailableProvider): SourceScope => (p.name === "linkedin" ? "personal" : scopeOfProvider(p));
    const tileState = (p: AvailableProvider): TileState =>
      (p as AvailableProvider & { coming_soon?: boolean }).coming_soon ? "soon"
        : needsSetup(p.name) ? "setup"
        : CUSTOM_ONLY_INTEGRATIONS.has(p.name) && !canEnterprise ? "locked" : "open";
    const p = connecting;
    let form: ReactNode = null;
    let cta: ReactNode = null;
    let notice: ReactNode = null;
    const errorLine = (m: string) => <p className="text-[12px] leading-relaxed text-destructive">{m}</p>;
    if (p) {
      const label = googleNative && isComposio(p) ? "Connect with Google" : `Connect ${p.display_name}`;
      if (tileState(p) === "locked") {
        notice = <p className="text-[12px] text-muted-foreground">{p.display_name} is on the Workspace plan.</p>;
        cta = <Button asChild size="sm"><a href="/settings?section=billing">See plans</a></Button>;
      } else if (scopeOfTool(p) === "company" && !isManager) {
        notice = <p className="text-[12px] text-muted-foreground">Owners and admins connect shared tools.</p>;
        cta = <Button size="sm" disabled>{label}</Button>;
      } else if (p.name === "linkedin") {
        const full = linkedinStatus?.can_connect_more === false;
        if (full) notice = <p className="text-[12px] text-muted-foreground">{(linkedinStatus?.limit ?? 0) === 0 ? "LinkedIn isn't on this plan." : "Every LinkedIn seat on this plan is in use."}</p>;
        cta = (
          <Button size="sm" disabled={full || linkedinBusy} onClick={() => { setAddOpen(false); setConnecting(null); connectLinkedIn(); }}>
            {linkedinBusy ? "Connecting…" : label}
          </Button>
        );
      } else if (connSuccess) {
        form = connectForm;
      } else if (isOAuth(p)) {
        if (connTestResult && !connTestResult.verified) notice = errorLine(connTestResult.message);
        cta = (
          <Button size="sm" onClick={handleOAuthConnect} disabled={connOAuthLoading}>
            {connOAuthLoading ? <><RefreshCw className="animate-spin" />Connecting…</> : label}
          </Button>
        );
      } else {
        // Key forms, Stripe's webhook panel and the Nous install steps carry their own actions.
        form = connectForm;
      }
    }
    return (
      <AddIntegrationDialog
        open={addOpen}
        onOpenChange={(o) => { setAddOpen(o); if (!o) setConnecting(null); }}
        providers={allProviders}
        isConnected={(t) => (t.name === "linkedin" ? linkedinAccountCount > 0 : (connCountByProvider.get(t.name) ?? 0) > 0)}
        tileState={tileState}
        selected={connecting}
        onSelect={(t) => {
          // LinkedIn connects in its own popup; in this dialog it gets a detail step first.
          if (t.name === "linkedin") { setConnecting(t); setConnTestResult(null); setConnSuccess(null); return; }
          startConnect(t);
        }}
        onBack={() => setConnecting(null)}
        scopeOf={scopeOfTool}
        workspaceName={userData?.workspace?.name || "your workspace"}
        form={form}
        cta={cta}
        notice={notice}
        onOpenApi={openConnect ? () => { setAddOpen(false); setConnecting(null); openConnect("api"); } : undefined}
      />
    );
  };

  if (apiCards) {
    const side: SourceScope = scope ?? "personal";
    const workspaceName = userData?.workspace?.name ?? null;
    // One dialog for every tool (GET-638); each tool's detail step says whether it is personal
    // or shared and who may connect it.
    const addFromHere = () => { setConnecting(null); setConnTestResult(null); setAddScope(null); setAddOpen(true); };
    const connCard = (conn: IntegrationConn & { webhook_registered?: boolean; last_synced_at?: string | null; created_at?: string | null; sync_progress?: SyncProgress | null }) => {
      const canManage = conn.can_manage !== false;
      const name = conn.provider?.display_name ?? conn.name;
      const oauthish = conn.provider?.auth_type === "oauth2" || !conn.is_verified;
      const actions: (ManageAction | "separator" | { note: string })[] = !canManage ? [] : [
        { label: oauthish ? "Reconnect" : "Update credentials", onSelect: () => { startConnect(providerOf(conn), conn.name); setAddScope(null); setAddOpen(true); } },
        ...((conn.provider?.name === "calendly" || conn.provider?.name === "cal_com") && conn.webhook_registered
          ? [{ note: "Webhook registered" }] : []),
        ...(conn.provider?.name === "posthog" ? [{ label: "Edit events", onSelect: () => setPosthogEventsFor(conn.id) }] : []),
        "separator" as const,
        { label: disconnecting === conn.id ? "Removing…" : "Disconnect", destructive: true, disabled: disconnecting === conn.id, onSelect: () => disconnect(conn) },
      ];
      return (
        <SourceCard key={conn.id}
          logoUrl={conn.provider?.logo_url} name={name}
          account={accountLine(conn, workspaceName)}
          status={conn.provider?.name === "slack" && conn.is_verified ? { kind: "live", label: "Connected" } : sourceStatus(conn)}
          progress={conn.sync_progress}
          synced={syncedLabel(conn.last_synced_at, conn.created_at)}
          actions={actions}
          manageHint="Owners and admins manage shared integrations.">
          {IntegrationSetup && conn.provider?.name === "slack" && <Suspense fallback={null}><IntegrationSetup provider="slack" token={token} workspaceId={workspaceId} canManage={canManage && isManager} /></Suspense>}
          {conn.provider?.name === "posthog" && posthogEventsFor === conn.id && (
            <PostHogEventsDialog connectionId={conn.id} token={token} open onOpenChange={(o) => { if (!o) setPosthogEventsFor(null); }} />
          )}
        </SourceCard>
      );
    };
    const linkedinCards = side === "personal" && showLinkedInRow
      ? linkedinStatus!.connections!.map((c) => {
          const seats = (linkedinStatus?.limit ?? 0) > 0 ? `${linkedinStatus?.used ?? 0} of ${linkedinStatus?.limit} team seats used` : null;
          const canMore = linkedinStatus?.can_connect_more !== false;
          const actions: (ManageAction | "separator" | { note: string })[] = [
            ...(!c.linkedin_profile_url ? [{ label: "Reconnect", disabled: linkedinBusy, onSelect: () => connectLinkedIn() }] : []),
            ...(canMore ? [{ label: "Add another account", disabled: linkedinBusy, onSelect: () => connectLinkedIn() }] : []),
            ...(seats ? [{ note: seats }] : []),
            "separator" as const,
            { label: "Disconnect", destructive: true, disabled: linkedinBusy, onSelect: () => disconnectLinkedIn(c.unipile_account_id) },
          ];
          return (
            <SourceCard key={`li-${c.id}`}
              logoUrl="/provider-logos/linkedin.png" name="LinkedIn"
              account={c.linkedin_name || "LinkedIn account"}
              status={sourceStatus({ is_verified: !!c.linkedin_profile_url })}
              synced={syncedLabel(null, c.connected_at)}
              actions={actions} />
          );
        })
      : [];
    const conns = side === "personal" ? personalConns : companyConns;
    // In Settings the section already has its Personal / Shared tabs and its own scroll: just the
    // grid, with the + card to add one.
    if (embedded) return (
      <div>
        {side === "personal" && !selfHosted && workspaceId && canManageComposio && composioChecked && !composioConfigured && !googleNative && (
          <div className="mb-4">
            <ComposioConfigCard apiUrl={apiUrl} token={token} workspaceId={workspaceId} canManage={canManageComposio} onConfigured={setComposioConfigured} />
          </div>
        )}
        {connsLoaded && (
          <SourceGrid>
            {linkedinCards}
            {conns.map(connCard)}
            <AddSourceCard onClick={addFromHere} />
          </SourceGrid>
        )}
        {apiAddDialog()}
        {disconnectDialog}
      </div>
    );
    return (
      <div className="flex h-full flex-col overflow-y-auto bg-background">
        <SourcesToolbar side={side} onAdd={addFromHere} />
        <div className="flex-1 bg-muted/25 p-4 sm:p-5">
          {/* Self-host connects Google with its own OAuth app, never Composio (GET-765, GET-837); how to
              set one up is in the self-host guide, so the page shows no setup card. */}
          {side === "personal" && !selfHosted && workspaceId && canManageComposio && composioChecked && !composioConfigured && !googleNative && (
            <div className="mb-4">
              <ComposioConfigCard apiUrl={apiUrl} token={token} workspaceId={workspaceId} canManage={canManageComposio} onConfigured={setComposioConfigured} />
            </div>
          )}
          {connsLoaded && (
            <SourceGrid>
              {linkedinCards}
              {conns.map(connCard)}
              <AddSourceCard onClick={addFromHere} />
            </SourceGrid>
          )}
        </div>
        {apiAddDialog()}
        {disconnectDialog}
      </div>
    );
  }

  const pageTitle = scope === "personal" ? "Personal integrations" : scope === "company" ? "Shared integrations" : "Integrations";
  const showPersonal = scope !== "company";
  const showCompany = scope !== "personal";

  return (
    <div className={embedded ? "" : "h-full overflow-y-auto bg-background"}>
      <div className={embedded ? "" : "px-8 py-7"}>
        {/* Embedded in Settings: match the section design (22px title + divider) that
            the rest of the Settings sections use, keeping the add action on the right.
            Standalone: the page's own PageHeader. */}
        {embedded ? (
          // The settings top bar already names the section (round 2): just the add action.
          addButton && <div className="mb-3 flex justify-end">{addButton}</div>
        ) : (
          <PageHeader title={pageTitle} actions={addButton} />
        )}

        {/* Integration Engine (Composio) — the one-time setup that unlocks Gmail + Calendar.
            Only shown to a manager when it is NOT yet configured; once Composio is set up
            (server env or pasted key) there is nothing to do, so the card disappears. */}
        {showPersonal && !selfHosted && workspaceId && canManageComposio && composioChecked && !composioConfigured && !googleNative && (
          <ComposioConfigCard
            apiUrl={apiUrl}
            token={token}
            workspaceId={workspaceId}
            canManage={canManageComposio}
            onConfigured={setComposioConfigured}
          />
        )}

        {/* Personal integrations — only this person's: their mailbox, calendar, LinkedIn, booking
            page and note-takers. Teammates' personal sources never reach this page. */}
        {showPersonal && (
        <SourceSection
          bare={!!scope}
          loading={!connsLoaded}
          title="Personal integrations"
          blurb="Only you see these. What they bring in still builds your team's shared account records."
          onAdd={() => openCatalog("personal")}
          addLabel="Add"
          empty={!showLinkedInRow && personalConns.length === 0}
          emptyText="Connect your email, calendar, LinkedIn and note-taker."
        >
            {showLinkedInRow && (
              <div className="rounded-lg px-2 py-2 hover:bg-hover transition-colors duration-fast">
                <div className="flex items-center gap-4 group">
                  <IntegrationLogo url="/provider-logos/linkedin.png" name="LinkedIn" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground">LinkedIn</div>
                    <div className="text-[12px] text-muted-foreground/70 truncate">
                      {`${linkedinAccountCount} account${linkedinAccountCount === 1 ? "" : "s"} connected`}
                      {(linkedinStatus?.limit ?? 0) > 0 && ` · ${linkedinStatus?.used ?? 0} of ${linkedinStatus?.limit} team seats used`}
                    </div>
                  </div>
                  {linkedinStatus?.can_connect_more === false ? (
                    <span className="text-[11px] px-2 py-0.5 rounded-md border text-muted-foreground border-border bg-muted/30 flex-shrink-0"
                      title={(linkedinStatus?.limit ?? 0) === 0 ? "Connecting LinkedIn isn't on this plan" : "You've reached your plan's LinkedIn limit — upgrade or contact us"}>
                      {(linkedinStatus?.limit ?? 0) === 0 ? "Not on this plan" : "Limit reached"}
                    </span>
                  ) : (
                    <button onClick={() => connectLinkedIn()} disabled={linkedinBusy}
                      className="text-[12px] font-medium flex-shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1.5 hover:bg-primary/90 disabled:opacity-40">
                      {linkedinBusy ? "Connecting…" : "Add account"}
                    </button>
                  )}
                </div>
                <div className="mt-2.5 space-y-1.5 pl-[52px]">
                  {linkedinStatus!.connections!.map((c:any) => (
                    <div key={c.id} className="flex items-center gap-3 group/acct">
                      <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${c.linkedin_profile_url ? "bg-emerald-500" : "bg-amber-500"}`} />
                      <div className="flex-1 min-w-0 text-[12.5px] text-foreground truncate">
                        {c.linkedin_name || c.unipile_account_id}
                        {!c.linkedin_profile_url && <span className="text-amber-600 ml-2 text-[11px]">needs reconnect</span>}
                      </div>
                      <button onClick={() => disconnectLinkedIn(c.unipile_account_id)} disabled={linkedinBusy}
                        className="text-[11.5px] font-medium text-muted-foreground hover:text-red-500 transition-colors opacity-0 group-hover/acct:opacity-100 flex-shrink-0 rounded-md border border-border px-2 py-0.5 hover:border-red-200 disabled:opacity-40">
                        Disconnect
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {personalConns.map(renderConn)}
        </SourceSection>
        )}

        {/* Shared integrations — one connection for the whole team. Everyone sees them and who
            connected them; owners and admins change them. */}
        {showCompany && (
        <div className={showPersonal ? "mt-8" : ""}>
          <SourceSection
            bare={!!scope}
            loading={!connsLoaded}
            title="Shared integrations"
            blurb={isManager ? "Shared by the whole team." : "Shared by the whole team. Owners and admins connect and change these."}
            onAdd={isManager ? () => openCatalog("company") : undefined}
            addLabel="Add"
            empty={companyConns.length === 0}
            emptyText={isManager ? "Connect your CRM, outbound tools and Slack once for everyone." : "Nothing shared yet. An owner or admin connects these."}
          >
            {companyConns.map(renderConn)}
          </SourceSection>
        </div>
        )}
      </div>

      {/* Add an integration modal */}
      {/* The add/connect dialog. MOUNTED HERE, not only in the chromeless branch.
          `addDialog` was hoisted into a const so the chat's connect cards could render it
          alone, and the main return lost it in the same edit — so `setAddOpen(true)` flipped
          state that nothing was listening to. The + button, the Reconnect button on a broken
          connection, and provider deep links all became silent no-ops: the click registers,
          React re-renders, and the operator sees nothing move. A dialog kept in a variable
          has to be rendered on every path that can open it. */}
      {addDialog}

      {disconnectDialog}
    </div>
  );
}

function SourceSection({ title, blurb, onAdd, addLabel, empty, emptyText, children, bare = false, loading = false }: {
  title: string; blurb: string; onAdd?: () => void; addLabel: string;
  empty: boolean; emptyText: string; children: ReactNode;
  /** On its own page the header above already carries the title and the + button. */
  bare?: boolean;
  /** Still fetching: render nothing rather than a flash of the empty state. */
  loading?: boolean;
}) {
  return (
    <section>
      {!bare && (
      <div className="flex items-end justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="section-title">{title}</h3>
          <p className="text-[11.5px] text-muted-foreground/70">{blurb}</p>
        </div>
        {onAdd && (
          <button onClick={onAdd}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground flex-shrink-0 rounded-md border border-border px-2.5 py-1 hover:bg-muted/50 transition-colors">
            <Plus className="h-3.5 w-3.5" />{addLabel}
          </button>
        )}
      </div>
      )}
      {loading ? null : empty ? (
        <div className="rounded-2xl border border-dashed border-border/70 py-8 px-4 text-center text-[13px] text-muted-foreground/60">{emptyText}</div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card p-2 overflow-hidden">{children}</div>
      )}
    </section>
  );
}
