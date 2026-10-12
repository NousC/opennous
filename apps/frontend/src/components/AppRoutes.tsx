import { Routes, Route, Navigate, useParams, useLocation, useNavigate } from "react-router-dom";

// Old docs URL (/docs/:id) → /pages/:id, keeping the id and the section anchor.
function RedirectToPage() {
  const { id } = useParams();
  const { hash } = useLocation();
  return <Navigate to={`/pages/${id ?? ""}${hash}`} replace />;
}
// Old company URL (/companies/:id) → the new /accounts/:id, keeping the id.
function RedirectToAccount() {
  const { id } = useParams();
  return <Navigate to={`/accounts/${id ?? ""}`} replace />;
}
// The space's old Admin URLs (/workspace/:tab) → the same panel in Settings › Workspace (GET-430).
// Usage kept its own page there as `spend`, because `usage` was already an alias for Billing.
function WorkspaceToSettings({ tab: fixed }: { tab?: string }) {
  const { tab } = useParams();
  const t = fixed ?? tab ?? "general";
  return <Navigate to={`/settings?section=${t === "usage" ? "spend" : t}`} replace />;
}
import React, { Suspense } from "react";
import { ApiTopBarProvider } from "@/components/shell/ApiTopBar";
import { AppTopBar, TopBarProvider } from "@/components/shell/topBar";
import { AppShortcuts } from "@/components/shell/Shortcuts";
import { SystemBanner } from "@/components/shell/SystemBanner";
import { AppSidebar } from "@/components/AppSidebar";
import { OpsLimitBanner } from "@/components/OpsLimitBanner";
import { AccountLimitWall, isAccountLimitOpenPath } from "@/components/AccountLimitWall";
import { TabsProvider } from "@/contexts/TabsContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { useOnboarding } from "@/hooks/useOnboarding";
import { isCorePlan, isApiTier } from "@/config/plans";
import { cloud } from "@/lib/cloud";
import { lazyWithErrorBoundary, MinimalLoader, TableLoader, RequiresFeature } from "@/components/shell/routeKit";

/**
 * "/" means different things to the two audiences. With the in-app agent it's
 * Threads, the front door. Without it — an operator living in Claude Code — there
 * is no chat to land on, so home is the graph itself.
 *
 * DELIBERATE EXCEPTION to the rule above: this redirects, it does not render
 * FeatureUpgrade. "/" is the post-login landing route, so paywalling it means every
 * Free and Start login opens on an upgrade card with nothing behind it — the most
 * punitive placement available — and it makes "/" un-bookmarkable for most of the
 * user base. The Threads NAV ITEM still renders locked with its tooltip, which is
 * where the discovery actually happens. Don't "fix" this.
 */
/** One document: the reading page on self-serve, the wiki on Workspace (GET-426). The wiki is
 *  the Workspace layer's (cloud.variants.doc); without it every plan gets the reading page. */
function DocRoute() {
  const { plan, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  const Wiki = cloud.variants?.doc;
  const Page = isCorePlan(plan) || !Wiki ? DocPage : Wiki;
  return <Suspense fallback={<MinimalLoader />}><Page /></Suspense>;
}

/** The Pages index: the library on Workspace, and Home everywhere else (GET-426). */
function PagesIndexRoute() {
  const { plan, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  const Library = cloud.variants?.docIndex;
  if (isCorePlan(plan) || !Library) return <Navigate to="/" replace />;
  return <Suspense fallback={<MinimalLoader />}><Library /></Suspense>;
}

// Self-host bills nothing, so it has no Usage and billing page (GET-839).
function UsageRoute() {
  const { selfHosted, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  if (selfHosted) return <Navigate to="/" replace />;
  return <Suspense fallback={<MinimalLoader />}><UsageBilling /></Suspense>;
}

function HomeRoute() {
  const { plan, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  // Self-serve (Starter · Pro · Scale) is agent-in-your-coding-agent, so there is no in-app
  // conversation to put here. Home is the FEED of what the engine wrote (GET-426) — it used
  // to be the install page, which meant the plan whose promise is "it runs without you"
  // opened on a list of things you still had to do, and had nothing to say the day you
  // finished them. The checklist now rides on top of the feed until setup completes.
  // /get-started still resolves, for the links and bookmarks that point at it.
  // Home is one page on every plan (GET-476). The plugin and API plans have no in-app agent,
  // so theirs comes without the ask box; the engine's documents stay one click away in the brain.
  // API plan: home IS the activity ledger (GET-481). That plan has no worklist, no
  // insights and no tasks — what it has is a set of connected tools and a record of what
  // we read from them, so that is what opening the product should show.
  //
  // `/` renders it rather than redirecting to /activity: a redirect gives one surface two
  // URLs and leaves the logo pointing at a page the plan does not have.
  // The workspace plans' Home — the conversation or the worklist — is the Workspace layer's
  // (cloud.variants.home, GET-754). Without it, every plan lands on the activity ledger.
  const CloudHome = cloud.variants?.home;
  if (isApiTier(plan) || !CloudHome) {
    return <Suspense fallback={<TableLoader />}><Activity /></Suspense>;
  }
  return <CloudHome />;
}

// Chat is the in-app conversational agent — Custom plan only. On Core the agent lives in
// the operator's own coding tool, so /chat redirects to Workflows.
function ChatRoute() {
  const { plan, loading } = usePlan();
  const location = useLocation();
  if (loading) return <MinimalLoader />;
  if (isCorePlan(plan)) return <Navigate to="/automations" replace />;
  // Kept only so old links and open tabs still work. The query string carries over, so
  // /chat?thread=abc lands on /?thread=abc rather than dropping someone into an empty page.
  return <Navigate to={`/${location.search}`} replace />;
}

const Settings        = lazyWithErrorBoundary(() => import("@/pages/Settings"));
const Shared          = lazyWithErrorBoundary(() => import("@/pages/Shared"));
const Activity        = lazyWithErrorBoundary(() => import("@/pages/Activity"));
const Workflows       = lazyWithErrorBoundary(() => import("@/pages/Workflows"));
const AutomationEditor = lazyWithErrorBoundary(() => import("@/pages/AutomationEditor"));
const DocPage         = lazyWithErrorBoundary(() => import("@/pages/DocPage"));
const IntegrationsPage = lazyWithErrorBoundary(() => import("@/pages/Integrations"));
const WebhooksPage = lazyWithErrorBoundary(() => import("@/pages/Webhooks"));
const ApiKeys         = lazyWithErrorBoundary(() => import("@/pages/ApiKeys"));
const KeyDetail       = lazyWithErrorBoundary(() => import("@/pages/KeyDetail"));
const People          = lazyWithErrorBoundary(() => import("@/pages/People"));
const Companies       = lazyWithErrorBoundary(() => import("@/pages/Companies"));
const Deal            = lazyWithErrorBoundary(() => import("@/pages/Deal"));
const Accounts        = lazyWithErrorBoundary(() => import("@/pages/Accounts"));
const AccountsIndex   = lazyWithErrorBoundary(() => import("@/pages/AccountsIndex"));
const GraphPage       = lazyWithErrorBoundary(() => import("@/pages/GraphPage"));
const UsageBilling    = lazyWithErrorBoundary(() => import("@/pages/UsageBilling"));
// Lists / triggers / reports / tasks / skills are headless — backends live, no pages.
// The Vault retired 2026-07-31: only the ICP survived, and it lives on /icp now.
const Note            = lazyWithErrorBoundary(() => import("@/pages/Note"));
const NotFound        = lazyWithErrorBoundary(() => import("@/pages/NotFound"));

const EmptyWorkspace        = lazyWithErrorBoundary(() => import("@/pages/EmptyWorkspace"));

// Sources as two standalone pages (GET-239). A connect link for a tool that belongs on the
// other page forwards there, so the new connection shows up in the list being looked at.
function SourcesPage({ side }: { side: "personal" | "company" }) {
  const navigate = useNavigate();
  return (
    <IntegrationsPage
      scope={side}
      onWrongScope={(other, slug) =>
        navigate(`${other === "company" ? "/company-sources" : "/integrations"}?connect=${encodeURIComponent(slug)}`, { replace: true })}
    />
  );
}

// App shell — persistent sidebar + scrollable main pane. One shared layout for every
// plan (the API plan used to be a sidebar-less control plane; it now shares this shell).
function StandardLayout({ children }: { children: React.ReactNode }) {
  // Over the active-account cap past the grace window → the page is replaced by the
  // upgrade wall; Billing / Usage / Settings stay open as the way out (GET-209).
  const { activeAccounts, plan, selfHosted } = usePlan();
  const { pathname } = useLocation();
  const locked = !selfHosted && activeAccounts?.state === "restricted" && !isAccountLimitOpenPath(pathname);
  return (
    // Grey app frame; the content lives in a rounded panel floating on it, flush
    // beside the (same-grey) sidebar. The panel is where every page renders.
    // The panel carries the top bar (GET-598): breadcrumb left, Priorities + Ask Nous right.
    <TopBarProvider>
    <div className="flex h-screen w-full overflow-hidden bg-frame">
      <AppSidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden p-2 pl-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-card">
          <AppTopBar />
          <SystemBanner />
          <OpsLimitBanner />
          {/* The API plan's pages share one top bar (GET-621); the provider draws it. */}
          {isApiTier(plan) && !locked ? (
            <ApiTopBarProvider>
              <div className="flex-1 overflow-auto">{children}</div>
            </ApiTopBarProvider>
          ) : (
            <div className="flex-1 overflow-auto">
              {locked && activeAccounts ? <AccountLimitWall accounts={activeAccounts} planName={plan.name} /> : children}
            </div>
          )}
        </div>
      </main>
      {/* The Workspace layer's overlays: the page agent, opened from the top bar's Ask Nous or
          ⌘J; not on Chat / Settings. */}
      {!locked && cloud.shell?.overlays?.map((Overlay, i) => <Overlay key={i} />)}
      {/* G-then-letter, C, ? (GET-601). */}
      <AppShortcuts />
    </div>
    </TopBarProvider>
  );
}

export function AppRoutes() {
  // First-run gate: until the workspace is ACTIVATED — the user has connected a data
  // source and >=3 sources in the wizard and clicked Get Started — the whole app, sidebar
  // and all, is replaced by the full-screen connect wizard. The ICP is written AFTER this
  // gate opens, by the in-app agent, so the gate is activation, not "has an ICP".
  //
  // The answer comes from /api/onboarding/status and NOWHERE else. `activated` is true once
  // the wizard is done OR the workspace already has an ICP (so existing users never regress).
  // One question, one answer, one endpoint.
  const { isAuthenticated, userData } = useAuth();
  const location = useLocation();
  const wsId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const { activated, shouldGreet, loading } = useOnboarding();
  const { plan, loading: planLoading } = usePlan();
  // "Skip for now" is scoped to THIS workspace, so a different/new account in the
  // same browser still gets the gate.
  let skipped = false;
  try { skipped = !!wsId && localStorage.getItem(`nous_connect_skipped:${wsId}`) === "1"; } catch { /* ignore */ }
  // Wait for the answer before gating. Bouncing first and correcting later would flash the
  // setup screen at an activated user on every cold load.
  if (isAuthenticated && wsId && (loading || planLoading)) return <MinimalLoader />;
  // Setup is a CONVERSATION now, not a wizard.
  //
  // The four-step split screen asked for a company name, a website, a CRM, three more
  // sources and an attribution answer before it would let anyone in — and two of those
  // questions (the ICP, the pipeline stages) were things nobody can answer accurately on
  // day one and the data already knows. So an unactivated seat lands in the chat, where the
  // agent runs the `welcome` skill: it asks who they are, puts the right tools on screen as
  // cards, and agrees what gets written when the backfill lands. Same connect flows, same
  // modals — just reached from the conversation instead of instead of it.
  //
  // Core plans were never gated here (their setup happens in their own coding agent) and
  // still aren't.
  //
  // It fires ONCE per browser session, not on every navigation. A wizard could hold someone
  // because it was the whole screen; a redirect that re-fires would trap them — they connect
  // a source, land on Sources, and get thrown back to the chat. One nudge, then they are free
  // to move around and come back to the conversation from Recents.
  let nudged = false;
  try { nudged = !!wsId && sessionStorage.getItem(`nous_setup_nudged:${wsId}`) === "1"; } catch { /* private mode */ }
  // Nudge only someone who actually has a setup conversation waiting: a new team member always
  // does (their own sources), an owner in V1 does not — an operator set their workspace up
  // before they ever signed in.
  // The conversation it lands in is the Workspace layer's Home, so no nudge without it.
  if (isAuthenticated && wsId && shouldGreet && !activated && !skipped && !nudged && !isCorePlan(plan)
      && location.pathname === "/" && cloud.variants?.home) {
    try { sessionStorage.setItem(`nous_setup_nudged:${wsId}`, "1"); } catch { /* private mode */ }
    return <Navigate to="/?setup=1" replace />;
  }
  // ONE gate: is the workspace activated. Past it, EVERY plan lands in its own home —
  // api users route to the /connect control plane (HomeRoute), which already carries the
  // CLI/MCP install + ICP surfaces. There is no second full-screen "CLI handoff" blocker:
  // it duplicated /connect and re-trapped activated api users on a new browser (their
  // agent may never write the ICP, so the old `!hasIcp` gate never cleared).

  return (
    <TabsProvider>
    <Routes>
      {/* The Workspace layer's full-screen pages (the admin tools), when this build has it. */}
      {cloud.fullScreenRoutes}

      {/* The Playground became the agent on Home — it's the product now, not a
          sandbox, so it lives inside the app shell like every other surface. */}
      <Route path="/playground" element={<Navigate to="/" replace />} />

      {/* The graph — two tabs (GET-472): GTM (the brain) and Relationships (accounts and people),
          inside the app shell so the sidebar stays on the left. */}
      <Route path="/graph" element={
        <StandardLayout>
          <div className="relative h-full w-full overflow-hidden">
            <Suspense fallback={<MinimalLoader />}><GraphPage /></Suspense>
          </div>
        </StandardLayout>
      } />

      {/* Settings — the Attio-style full-screen takeover. Renders its own sidebar
          and replaces the app shell, so it lives OUT here with /graph rather than
          inside StandardLayout. The active section is driven by ?section=… */}
      <Route path="/settings" element={<Suspense fallback={<MinimalLoader />}><Settings /></Suspense>} />

      {/* Standalone note + report pages — opened in a new tab, clean full-page markdown. */}
      <Route path="/note/:id" element={<Suspense fallback={<MinimalLoader />}><Note /></Suspense>} />

      {/* Standard layout — sidebar + conditional header */}
      <Route path="*" element={
        <StandardLayout>
          <Routes>
            {/* Admin lives in Settings › Workspace (GET-430). Every URL it had before — the
                /workspace root and the older /company/… ones — lands on the same panel there. */}
            <Route path="/workspace"      element={<WorkspaceToSettings />} />
            <Route path="/workspace/:tab" element={<WorkspaceToSettings />} />
            <Route path="/company/usage"    element={<WorkspaceToSettings tab="usage" />} />
            <Route path="/company/adoption" element={<WorkspaceToSettings tab="adoption" />} />
            <Route path="/company/general"  element={<WorkspaceToSettings tab="general" />} />
            <Route path="/company/members"  element={<WorkspaceToSettings tab="members" />} />
            <Route path="/company/billing"  element={<WorkspaceToSettings tab="billing" />} />
            {/* Personal workspace — the member's private vault (settings + folders),
                in the app shell like RevBox. The sidebar item shows the first name. */}
            {/* The personal workspace surface is retired — its config panes moved into
                Settings (Connections group). Send any old /connect link there. */}
            <Route path="/connect"       element={<Navigate to="/settings" replace />} />
            <Route path="/connect/:tab"  element={<Navigate to="/settings" replace />} />
            {/* The in-app Install / CLI-setup page lives at /get-started. It must NOT be at
                /install: nginx proxies /install to the API's curl-script endpoint, so a browser
                loading /install gets the raw shell script instead of this page. Old /install
                links bounce here (client-side); a hard reload of /install is caught by the API,
                which redirects browsers to /get-started. */}
            <Route path="/get-started" element={<Navigate to="/?getstarted=1" replace />} />
            <Route path="/install"    element={<Navigate to="/get-started" replace />} />
            <Route path="/integrations" element={<Suspense fallback={<MinimalLoader />}><SourcesPage side="personal" /></Suspense>} />
            <Route path="/company-sources" element={<Suspense fallback={<MinimalLoader />}><SourcesPage side="company" /></Suspense>} />
            {/* /playground and /graph are mounted above as full-screen routes — no sidebar */}
            {/* Skills stays hidden (2026-07-31); the engine is live for the agent and the
                page redirects so old links don't 404. */}
            <Route path="/skills"     element={<Navigate to="/accounts" replace />} />
            {/* Automations — trigger, artifact, destination. /workflows was its address while
                it was an agent-only surface; it keeps resolving so nothing in the wild 404s. */}
            <Route path="/automations" element={<RequiresFeature feature="automations"><Suspense fallback={<MinimalLoader />}><Workflows /></Suspense></RequiresFeature>} />
            {/* One automation, drawn as its flow (GET-523). "new" is the unsaved one. */}
            <Route path="/automations/:id" element={<RequiresFeature feature="automations"><Suspense fallback={<MinimalLoader />}><AutomationEditor /></Suspense></RequiresFeature>} />
            <Route path="/workflows"  element={<Navigate to="/automations" replace />} />
            <Route path="/keys"       element={<Suspense fallback={<MinimalLoader />}><ApiKeys /></Suspense>} />
            <Route path="/keys/:id"   element={<Suspense fallback={<MinimalLoader />}><KeyDetail /></Suspense>} />
            {/* Integrations + Webhooks live inside Settings now (2026-07-31). The old
                standalone paths redirect into their section so nothing 404s. */}
            <Route path="/webhooks"   element={<Suspense fallback={<MinimalLoader />}><WebhooksPage /></Suspense>} />
            {/* Triggers are headless (2026-07-14): the engine and MCP tools stay live, but
                there's no page. Old links redirect so nothing 404s. */}
            <Route path="/triggers"   element={<Navigate to="/accounts" replace />} />

            <Route path="/billing" element={<Suspense fallback={<MinimalLoader />}><UsageBilling /></Suspense>} />
            {/* Open on self-host too. There's no bill there, but "how big has my
                graph grown" is a real question, and the page answers it — plus it's
                where we say WHY it's free (your own model key, your own extraction
                bill). Redirecting them away left that unsaid. */}
            <Route path="/usage" element={<UsageRoute />} />
            {/* Adoption — how the team actually uses the agents. Pro+ on Cloud;
                open on self-host (usePlan grants self-host the 'pro' feature set,
                and adoption is not in SELF_HOST_BLOCKED). */}
            <Route path="/adoption"  element={<WorkspaceToSettings tab="adoption" />} />
            {/* Pages — every brief, plan and report the agent has written, as a wiki (GET-197).
                Was /docs; old links redirect so a copied link keeps working. */}
            {/* On self-serve, Home is this list. /pages keeps resolving — a document's own
                link is /pages/:id and nothing should 404 — but the index redirects home. */}
            <Route path="/pages" element={<PagesIndexRoute />} />
            {/* One document: the reading page on self-serve, the wiki on Workspace. The
                three-column tree is right when you are looking FOR something and wrong when
                you already clicked the thing you wanted, which is how you arrive from Home. */}
            <Route path="/pages/:id" element={<DocRoute />} />
            <Route path="/docs" element={<Navigate to="/pages" replace />} />
            <Route path="/docs/:id" element={<RedirectToPage />} />
            {/* Studio (formerly "Focus") — the account-grouped "needs attention"
                worklist. Open to all. The old My Studio rep queue is retired; its
                /studio URL now belongs to this page, and /focus redirects here so
                existing links survive. */}
            {/* Studio is folded into Home (GET-476): its worklist became Needs attention, and each
                recommendation opens at /home/:id (GET-478). The address still lands. */}
            <Route path="/studio" element={<Navigate to="/" replace />} />
            {/* Legacy /focus links → /studio. */}
            <Route path="/focus" element={<Navigate to="/" replace />} />
            <Route path="/focus/draft" element={<Navigate to="/studio/draft" replace />} />

            {/* Home is the agent — for whoever bought the agent. Everyone else
                lands on Accounts (see HomeRoute). */}
            <Route path="/" element={<HomeRoute />} />
            {/* Chat = the same agent (Custom plan only). Core has no in-app agent —
                it lands on Workflows instead. */}
            <Route path="/chat" element={<ChatRoute />} />
            {/* Shared with me — accounts, notes and threads teammates have shared. */}
            <Route path="/shared" element={<Suspense fallback={<MinimalLoader />}><Shared /></Suspense>} />
            {/* Activity — the member's own observation stream (footer icon). */}
            <Route path="/activity" element={<Suspense fallback={<MinimalLoader />}><Activity mine /></Suspense>} />
            {/* /settings is a full-screen takeover mounted OUTSIDE StandardLayout
                (next to /graph) — it is not routed here. */}

            {/* Accounts = the deal board + companies; People = the contacts list + people.
                URLs match the nav names: /accounts, /accounts/:id, /people, /people/:id. */}
            <Route path="/accounts"      element={<RequiresFeature feature="accounts"><Suspense fallback={<MinimalLoader />}><AccountsIndex /></Suspense></RequiresFeature>} />
            <Route path="/accounts/:id"  element={<RequiresFeature feature="accounts"><Suspense fallback={<MinimalLoader />}><Companies /></Suspense></RequiresFeature>} />
            {/* One deal, inside its account (GET-262) — opened from the account's Deals tab. */}
            <Route path="/accounts/:id/deals/:dealId" element={<RequiresFeature feature="accounts"><Suspense fallback={<MinimalLoader />}><Deal /></Suspense></RequiresFeature>} />
            <Route path="/people"        element={<Suspense fallback={<MinimalLoader />}><Accounts /></Suspense>} />
            <Route path="/people/:id"    element={<Suspense fallback={<MinimalLoader />}><People /></Suspense>} />
            {/* Back-compat redirects for the old paths. (/pipeline is now the Pipeline
                page itself — see below — so it no longer redirects to the board.) */}
            <Route path="/companies"     element={<Navigate to="/accounts" replace />} />
            <Route path="/companies/:id" element={<RedirectToAccount />} />
            <Route path="/integrations"  element={<Navigate to="/settings?section=integrations" replace />} />
            <Route path="/company-sources" element={<Navigate to="/settings?section=company-sources" replace />} />
            {/* Lists (lead database) now lives in Partner OS — routes removed from the graph app. */}
            <Route path="/settings/*" element={<Navigate to="/settings" replace />} />

            {/* Where closing the last tab lands you — nothing open, a few ways back in.
                Deliberately not a tabbable route, so it never becomes a tab itself. */}
            <Route path="/empty" element={<Suspense fallback={<MinimalLoader />}><EmptyWorkspace /></Suspense>} />

            {/* The Workspace layer's pages, when this build has it (GET-754). */}
            {cloud.routes}

            <Route path="*" element={<Suspense fallback={<MinimalLoader />}><NotFound /></Suspense>} />
          </Routes>
        </StandardLayout>
      } />
    </Routes>
    </TabsProvider>
  );
}
