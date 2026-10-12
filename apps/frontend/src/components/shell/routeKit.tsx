// The pieces a route needs, shared by the public routes (AppRoutes) and the Workspace layer's
// routes (src/cloud/routes.tsx, GET-754): the lazy-page loader, the two loaders a page shows
// while its chunk arrives, and the plan and role gates.
//
// Its own module, not exports of AppRoutes: the cloud registry is evaluated while AppRoutes is
// still importing it (lib/cloud.ts loads it eagerly), so reaching back into AppRoutes from there
// would read its bindings before they exist.
import React from "react";
import { Navigate } from "react-router-dom";
import { FeatureUpgrade } from "@/components/FeatureUpgrade";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { roleOf, type ViewerRole } from "@/lib/roles";
import type { PlanFeatures } from "@/config/plans";
import { lazyOr, ChunkLoadFailed } from "@/lib/lazyChunk";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const lazyWithErrorBoundary = (importFn: () => Promise<any>) => lazyOr<any>(importFn, ChunkLoadFailed);

export const MinimalLoader = () => <div className="flex flex-col h-full" />;

export const TableLoader = () => (
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

/** The full-screen spinner the pages outside the app shell show while their chunk loads. */
export const PageLoader = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
  </div>
);

/**
 * Feature-gated routes. Hiding a nav item stops people STUMBLING into a page they
 * don't have; this stops them TYPING their way into one. Neither is a security
 * boundary — the API enforces the same flags — but a page that renders an empty
 * shell and a 402 is worse than a page that isn't there.
 *
 * It used to bounce to /accounts and say nothing, which read as a bug. Now the two
 * reasons you can't be here get different answers, which is what `access` is for:
 * a plan you could buy has it → sell it; nobody could buy it here (self-host) →
 * bounce, because there is nothing to upgrade TO.
 *
 * Waits for the plan before deciding. Paywalling first and correcting later would
 * flash an upgrade screen at a Custom customer on every cold load.
 */
export function RequiresFeature({
  feature,
  children,
}: {
  feature: keyof PlanFeatures;
  children: React.ReactNode;
}) {
  const { access, loading } = usePlan();
  if (loading) return <MinimalLoader />;
  const state = access(feature);
  if (state === "hidden") return <Navigate to="/accounts" replace />;
  if (state === "locked") return <FeatureUpgrade feature={feature} />;
  return <>{children}</>;
}

/**
 * Role-gated routes (Reporting is manager-only; My Studio is rep-only). Wrong
 * role is the "hidden" case, not the "locked" one — there is no plan that turns
 * a rep into a manager, so no FeatureUpgrade, just the same /accounts bounce.
 * Unknown role (null — /me doesn't carry workspace_role yet) renders children:
 * show everything, then settle, exactly like the plan gate above.
 */
export function RequiresRole({
  role,
  children,
}: {
  role: ViewerRole;
  children: React.ReactNode;
}) {
  const { userData, userDataLoading } = useAuth();
  if (userDataLoading && !userData) return <MinimalLoader />;
  const viewerRole = roleOf(userData);
  if (viewerRole !== null && viewerRole !== role) return <Navigate to="/accounts" replace />;
  return <>{children}</>;
}
