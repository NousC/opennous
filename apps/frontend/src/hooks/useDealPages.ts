// Whether this viewer's deals open as pages (GET-1008): Cloud carries the deal page
// (cloud.dealPages) and the plan is a workspace plan. False on the API plan and in the
// open-source build, where a deal is listed on its account and never opens. See lib/dealPages.
import { cloud } from "@/lib/cloud";
import { dealPagesOn } from "@/lib/dealPages";
import { usePlan } from "@/hooks/usePlan";

export function useDealPages(): boolean {
  const { planId } = usePlan();
  return dealPagesOn({ cloudDealPages: cloud.dealPages, plan: planId });
}
