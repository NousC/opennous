import { Routes, Route, Navigate } from "react-router-dom";
import React, { lazy, Suspense } from "react";
import { AdminRoute } from "@/components/AdminRoute";
import { AppSidebar } from "@/components/AppSidebar";
import { OpsLimitBanner } from "@/components/OpsLimitBanner";
import { GlobalTabBar } from "@/components/GlobalTabBar";
import { TabsProvider } from "@/contexts/TabsContext";
import ComingSoon from "@/pages/ComingSoon";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { useOnboarding } from "@/hooks/useOnboarding";
import type { PlanFeatures } from "@/config/plans";

/**
 * Feature-gated routes. Hiding a nav item stops people STUMBLING into a page they
 * don't have; this stops them TYPING their way into one. Neither is a security
 * boundary — the API enforces the same flags — but a page that renders an empty
 * shell and a 402 is worse than a page that isn't there.
 *
 * Waits for the plan before redirecting. Bouncing first and correcting later would
 * throw a Custom customer off their own page on every cold load.
 */
function RequiresFeature({
  feature,
  children,
  fallback = "/accounts",
}: {
  feature: keyof PlanFeatures;
  children: React.ReactNode;
  fallback?: string;
}) {
  const { can, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  if (!can(feature)) return <Navigate to={fallback} replace />;
  return <>{children}</>;
}

/**
 * "/" means different things to the two audiences. With the in-app agent it's
 * Threads, the front door. Without it — an operator living in Claude Code — there
 * is no chat to land on, so home is the graph itself.
 */
function HomeRoute() {
  const { can, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  if (!can("inAppAgent")) return <Navigate to="/accounts" replace />;
  return (
    <Suspense fallback={<MinimalLoader />}>
      <Home />
    </Suspense>
  );
}

const lazyWithErrorBoundary = (importFn: () => Promise<any>) => {
  return lazy(() =>
    importFn().catch((error) => {
      console.error('Failed to load chunk:', error);
      return {
        default: () => (
          <div className="flex flex-col items-center justify-center min-h-screen p-8">
            <h2 className="text-2xl font-semibold mb-2">Failed to load page</h2>
            <p className="text-muted-foreground mb-4">Please refresh the page and try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Reload Page
            </button>
          </div>
        ),
      };
    })
  );
};

const Settings        = lazyWithErrorBoundary(() => import("@/pages/Settings"));
const Home            = lazyWithErrorBoundary(() => import("@/pages/Home"));
const Tasks           = lazyWithErrorBoundary(() => import("@/pages/Tasks"));
const Skills          = lazyWithErrorBoundary(() => import("@/pages/Skills"));
const Adoption        = lazyWithErrorBoundary(() => import("@/pages/Adoption"));
const ApiKeys         = lazyWithErrorBoundary(() => import("@/pages/ApiKeys"));
const Webhooks        = lazyWithErrorBoundary(() => import("@/pages/Webhooks"));
const Ops             = lazyWithErrorBoundary(() => import("@/pages/Ops"));
const People          = lazyWithErrorBoundary(() => import("@/pages/People"));
const Companies       = lazyWithErrorBoundary(() => import("@/pages/Companies"));
const Accounts        = lazyWithErrorBoundary(() => import("@/pages/Accounts"));
const Galaxy          = lazyWithErrorBoundary(() => import("@/pages/Galaxy"));
const Integrations    = lazyWithErrorBoundary(() => import("@/pages/Integrations"));
const UsageBilling    = lazyWithErrorBoundary(() => import("@/pages/UsageBilling"));
const Inbox           = lazyWithErrorBoundary(() => import("@/pages/Inbox"));
const Intelligence    = lazyWithErrorBoundary(() => import("@/pages/Intelligence"));
// Lists / triggers / reports are headless (2026-07-14) — backends live, no pages.
const Vault           = lazyWithErrorBoundary(() => import("@/pages/Vault"));
const Note            = lazyWithErrorBoundary(() => import("@/pages/Note"));
const NotFound        = lazyWithErrorBoundary(() => import("@/pages/NotFound"));
const ConnectGate     = lazyWithErrorBoundary(() => import("@/pages/ConnectGate"));

const AdminCMS              = lazyWithErrorBoundary(() => import("@/pages/AdminCMS"));
const AdminResources        = lazyWithErrorBoundary(() => import("@/pages/AdminResources"));
const AdminChangelog        = lazyWithErrorBoundary(() => import("@/pages/AdminChangelog"));
const AdminRoadmap          = lazyWithErrorBoundary(() => import("@/pages/AdminRoadmap"));
const AdminUpdates          = lazyWithErrorBoundary(() => import("@/pages/AdminUpdates"));
const AdminMedia            = lazyWithErrorBoundary(() => import("@/pages/AdminMedia"));
const AdminSupportDashboard = lazyWithErrorBoundary(() => import("@/pages/AdminSupportDashboard"));
const AdminAffiliates       = lazyWithErrorBoundary(() => import("@/pages/AdminAffiliates"));
const EmptyWorkspace        = lazyWithErrorBoundary(() => import("@/pages/EmptyWorkspace"));

const MinimalLoader = () => <div className="flex flex-col h-full" />;

const TableLoader = () => (
  <div className="flex flex-col h-full">
    <div className="border-b border-border/40">
      <div className="container mx-auto px-6 py-4 flex items-center gap-4">
        <div className="h-6 w-32 bg-muted/40 rounded animate-pulse" />
        <div className="flex-1" />
        <div className="h-9 w-24 bg-muted/20 rounded-md animate-pulse" />
      </div>
    </div>
    <div className="container mx-auto px-6 py-6 flex-1">
      <div className="space-y-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-14 bg-muted/30 rounded-lg animate-pulse" />
        ))}
      </div>
    </div>
  </div>
);

function AdminFullScreen({ children }: { children: React.ReactNode }) {
  return (
    <AdminRoute>
      <div className="min-h-screen bg-background">
        {children}
      </div>
    </AdminRoute>
  );
}

// App shell — persistent sidebar + scrollable main pane
function StandardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <AppSidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <OpsLimitBanner />
        {/* Workspace tabs — every page you open lands here as a closable tab. */}
        <GlobalTabBar />
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
      {/* Guided tour intentionally not mounted — new users land straight in the app after
          setting their ICP, no three-step overlay. Re-add <GuidedTour /> to bring it back. */}
    </div>
  );
}

export function AppRoutes() {
  // First-run gate: until the workspace has an ICP, the whole app — sidebar and all —
  // is replaced by the full-screen setup screen.
  //
  // The answer comes from /api/onboarding/status and NOWHERE else. This used to read
  // `workspace.business_type` off /api/me, which the in-app road never writes — so a user
  // could finish setup, watch it say "you're all set", and get thrown straight back here on
  // the next render, forever. One question, one answer, one endpoint.
  const { isAuthenticated, userData } = useAuth();
  const wsId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const { onboarded, loading } = useOnboarding();
  // "Skip for now" is scoped to THIS workspace, so a different/new account in the
  // same browser still gets the gate.
  let skipped = false;
  try { skipped = !!wsId && localStorage.getItem(`nous_connect_skipped:${wsId}`) === "1"; } catch { /* ignore */ }
  // Wait for the answer before gating. Bouncing first and correcting later would flash the
  // setup screen at an onboarded user on every cold load.
  if (isAuthenticated && wsId && loading) return <MinimalLoader />;
  if (isAuthenticated && wsId && !onboarded && !skipped) {
    return <Suspense fallback={<MinimalLoader />}><ConnectGate /></Suspense>;
  }

  return (
    <TabsProvider>
    <Routes>
      {/* Full-screen admin pages — no sidebar/header */}
      <Route path="/admin/cms" element={<AdminFullScreen><Suspense fallback={<MinimalLoader />}><AdminCMS /></Suspense></AdminFullScreen>} />
      <Route path="/admin/resources" element={<AdminFullScreen><Suspense fallback={<MinimalLoader />}><AdminResources /></Suspense></AdminFullScreen>} />
      <Route path="/admin/support" element={<AdminFullScreen><Suspense fallback={<MinimalLoader />}><AdminSupportDashboard /></Suspense></AdminFullScreen>} />

      {/* The Playground became the agent on Home — it's the product now, not a
          sandbox, so it lives inside the app shell like every other surface. */}
      <Route path="/playground" element={<Navigate to="/" replace />} />

      {/* Context graph — its own immersive full-viewport surface, no app sidebar. */}
      <Route path="/graph" element={
        <div className="h-screen w-full bg-background overflow-hidden">
          <Suspense fallback={<MinimalLoader />}><Galaxy /></Suspense>
        </div>
      } />

      {/* Standalone note + report pages — opened in a new tab, clean full-page markdown. */}
      <Route path="/note/:id" element={<Suspense fallback={<MinimalLoader />}><Note /></Suspense>} />

      {/* Standard layout — sidebar + conditional header */}
      <Route path="*" element={
        <StandardLayout>
          <Routes>
            {/* Activities — the live log of what the agents actually did.
                Renamed from Ops; the old paths still resolve. */}
            {/* Activities is hidden on self-host (frontend-only gate — the API stays open).
                See SELF_HOST_BLOCKED in config/plans.ts. */}
            <Route path="/activities" element={<RequiresFeature feature="activities"><Suspense fallback={<MinimalLoader />}><Ops /></Suspense></RequiresFeature>} />
            <Route path="/ops"        element={<Navigate to="/activities" replace />} />
            <Route path="/operations" element={<Navigate to="/activities" replace />} />
            <Route path="/requests"   element={<Navigate to="/activities" replace />} />
            {/* Setup lives in the docs now — the in-app Install page is gone. Old links
                bounce to the first-run gate, which does the setup. */}
            <Route path="/install"    element={<Navigate to="/" replace />} />
            {/* /playground and /graph are mounted above as full-screen routes — no sidebar */}
            {/* Skills — the procedures the agent knows. Read them here; the agent
                reaches for them itself. Pointless without our agent, so: Custom. */}
            <Route path="/skills"     element={<RequiresFeature feature="skills"><Suspense fallback={<MinimalLoader />}><Skills /></Suspense></RequiresFeature>} />
            <Route path="/keys"       element={<Suspense fallback={<MinimalLoader />}><ApiKeys /></Suspense>} />
            {/* Main nav */}
            <Route path="/webhooks"   element={<Suspense fallback={<MinimalLoader />}><Webhooks /></Suspense>} />
            {/* Triggers are headless (2026-07-14): the engine and MCP tools stay live, but
                there's no page. Old links redirect so nothing 404s. */}
            <Route path="/triggers"   element={<Navigate to="/accounts" replace />} />

            <Route path="/billing" element={<Suspense fallback={<MinimalLoader />}><UsageBilling /></Suspense>} />
            {/* Open on self-host too. There's no bill there, but "how big has my
                graph grown" is a real question, and the page answers it — plus it's
                where we say WHY it's free (your own model key, your own extraction
                bill). Redirecting them away left that unsaid. */}
            <Route path="/usage" element={<Suspense fallback={<MinimalLoader />}><UsageBilling /></Suspense>} />
            {/* Adoption — how the team actually uses the agents. Pro+ on Cloud;
                open on self-host (usePlan grants self-host the 'pro' feature set,
                and adoption is not in SELF_HOST_BLOCKED). */}
            <Route path="/adoption" element={<RequiresFeature feature="adoption"><Suspense fallback={<MinimalLoader />}><Adoption /></Suspense></RequiresFeature>} />

            {/* Home is the agent — for whoever bought the agent. Everyone else
                lands on Accounts (see HomeRoute). */}
            <Route path="/" element={<HomeRoute />} />
            {/* Tasks — what's coming up, and what you said you'd do. Every item
                hands its work to the agent via /?ask=, so without the agent it is
                a to-do list that cannot do anything. Custom. */}
            <Route path="/tasks" element={<RequiresFeature feature="tasks"><Suspense fallback={<MinimalLoader />}><Tasks /></Suspense></RequiresFeature>} />
            <Route path="/settings" element={<Suspense fallback={<MinimalLoader />}><Settings /></Suspense>} />

            {/* Standalone pages — extracted from Mind */}
            <Route path="/accounts"      element={<Suspense fallback={<MinimalLoader />}><Accounts /></Suspense>} />
            <Route path="/people"        element={<Navigate to="/accounts?tab=people" replace />} />
            <Route path="/people/:id"    element={<Suspense fallback={<MinimalLoader />}><People /></Suspense>} />
            <Route path="/companies"     element={<Navigate to="/accounts?tab=companies" replace />} />
            <Route path="/companies/:id" element={<Suspense fallback={<MinimalLoader />}><Companies /></Suspense>} />
            <Route path="/integrations"  element={<Suspense fallback={<MinimalLoader />}><Integrations /></Suspense>} />
            {/* Lists (lead database) now lives in Partner OS — routes removed from the graph app. */}
            {/* Split: the ICP model (numbers, what predicts a win) and the
                playbooks (prose the agent obeys) are different objects. */}
            <Route path="/icp"           element={<Suspense fallback={<MinimalLoader />}><Intelligence /></Suspense>} />
            {/* The Vault — the four documents every agent reads before it acts.
                Replaces the Playbooks page: same records, same API, but they are
                files now instead of settings rows, because that is what they are.
                The old /playbooks paths redirect so nothing 404s. */}
            {/* The Vault is ungated: it holds the ICP, which is the one thing setup exists
                to produce, so every plan can see and edit it. See internal/ONBOARDING.md §1. */}
            {/* Each Vault document is its own URL, so it rides the workspace tab bar
                like any other page instead of a second row of tabs. Bare /vault opens
                the first doc. */}
            <Route path="/vault"         element={<Navigate to="/vault/positioning" replace />} />
            <Route path="/vault/:doc"    element={<Suspense fallback={<MinimalLoader />}><Vault /></Suspense>} />
            <Route path="/playbooks"     element={<Navigate to="/vault/positioning" replace />} />
            <Route path="/playbook"      element={<Navigate to="/vault/positioning" replace />} />
            <Route path="/intelligence"  element={<Navigate to="/icp" replace />} />
            <Route path="/settings/*" element={<Navigate to="/settings" replace />} />

            <Route path="/inbox" element={<Suspense fallback={<TableLoader />}><Inbox /></Suspense>} />
            {/* Where closing the last tab lands you — nothing open, a few ways back in.
                Deliberately not a tabbable route, so it never becomes a tab itself. */}
            <Route path="/empty" element={<Suspense fallback={<MinimalLoader />}><EmptyWorkspace /></Suspense>} />

            <Route path="/admin/changelog" element={<AdminRoute><Suspense fallback={<MinimalLoader />}><AdminChangelog /></Suspense></AdminRoute>} />
            <Route path="/admin/roadmap" element={<AdminRoute><Suspense fallback={<MinimalLoader />}><AdminRoadmap /></Suspense></AdminRoute>} />
            <Route path="/admin/updates" element={<AdminRoute><Suspense fallback={<MinimalLoader />}><AdminUpdates /></Suspense></AdminRoute>} />
            <Route path="/admin/media" element={<AdminRoute><Suspense fallback={<MinimalLoader />}><AdminMedia /></Suspense></AdminRoute>} />
            <Route path="/admin/affiliates" element={<AdminRoute><Suspense fallback={<MinimalLoader />}><AdminAffiliates /></Suspense></AdminRoute>} />

            <Route path="*" element={<Suspense fallback={<MinimalLoader />}><NotFound /></Suspense>} />
          </Routes>
        </StandardLayout>
      } />
    </Routes>
    </TabsProvider>
  );
}
