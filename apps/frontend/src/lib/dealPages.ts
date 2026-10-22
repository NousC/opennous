// Whether a deal opens as its own page (GET-1008). Deal pages are a Workspace-plan surface and
// live in src/cloud/: on the API plan, and in the open-source build (no src/cloud/), an account
// still lists its deals with their stage and value, but a deal never opens. The server's deal
// endpoints are unchanged; this only decides what the app links to.
//
// Pure, so the rule is pinned by tests/dealPages.test.ts. Components ask hooks/useDealPages.
import { isApiTier } from "../config/plans.ts";

/** Deal pages exist when this build carries them (cloud.dealPages) and the plan is not the API plan. */
export function dealPagesOn({ cloudDealPages, plan }: { cloudDealPages: boolean | undefined; plan: unknown }): boolean {
  return cloudDealPages === true && !isApiTier(plan);
}

/** The deal page's address. */
export const dealPagePath = (companyId: string, dealId: string) => `/accounts/${companyId}/deals/${dealId}`;

/** Where a deal row on its own account goes: its page, or nowhere (a plain row). */
export function dealRowHref(on: boolean, companyId: string, dealId: string): string | null {
  return on ? dealPagePath(companyId, dealId) : null;
}

/** Where a deal named anywhere else goes: its page, or the account it sits on. */
export function dealOrAccountPath(on: boolean, companyId: string, dealId: string): string {
  return on ? dealPagePath(companyId, dealId) : `/accounts/${companyId}`;
}
