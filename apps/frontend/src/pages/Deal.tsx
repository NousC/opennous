// /accounts/:id/deals/:dealId — one deal, inside its account (GET-262). The account page's
// Deals tab opens this; Back returns to the account. `account` is the implied deal of an
// account with no CRM deal.
import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTabs } from "@/contexts/TabsContext";
import { useAccountDeal } from "@/components/deals/AccountDeals";
import DealDetailView from "@/components/deals/DealDetailView";

export default function Deal() {
  const { id, dealId } = useParams<{ id: string; dealId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { openTab } = useTabs();
  const { data, isPending, isError } = useAccountDeal(id, dealId);

  // Name the workspace tab after the deal, the way the account page names its tab.
  const tabName = data?.deal?.name ?? null;
  useEffect(() => {
    if (tabName) openTab(location.pathname, tabName);
  }, [tabName, location.pathname, openTab]);

  if (isPending) return <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground/60">Loading deal…</div>;
  if (isError || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground/70">
        <span>This deal isn't on this account, or you can't see it.</span>
        {id && <button onClick={() => navigate(`/accounts/${id}`)} className="text-sky-600 dark:text-sky-400 hover:underline">Back to the account</button>}
      </div>
    );
  }
  return (
    <DealDetailView
      dd={data}
      onOpenAccount={() => navigate(`/accounts/${data.account.id}`)}
      onOpenPerson={(pid) => navigate(`/people/${pid}`)}
    />
  );
}
