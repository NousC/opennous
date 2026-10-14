// Accounts — the companies list, the same on every plan. On the workspace plans the deal views
// moved to their own pages (Pipeline, Customers), so this page is the record list only; the API
// plan used to render a list of its own (GET-634) and now gets this one too.
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ScopedAccounts } from "@/components/revboxes/ScopedAccounts";
import AccountsList from "@/components/account/AccountsList";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { recordNavState } from "@/components/record/listOrder";
import { HAS_CLOUD } from "@/lib/cloud";

// Where an old /accounts?view=… bookmark lives now. Those pages are the Workspace layer's.
const MOVED: Record<string, string> = {
  sales_pipeline: "/pipeline",
  handoff: "/pipeline?view=handoff",
  customer_success: "/customers",
};

export default function AccountsIndex() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { plan } = usePlan();
  const api = isApiTier(plan);
  const moved = !api && HAS_CLOUD ? MOVED[params.get("view") ?? ""] : undefined;
  if (params.get("revbox")) return <ScopedAccounts revboxId={params.get("revbox")!} />;
  if (moved) return <Navigate to={moved} replace />;

  const openCompany = (id: string, name?: string, order?: string[]) => {
    if (!id) return;
    const path = `/accounts/${id}`;
    navigate(path, { state: { ...(name ? { accountName: name } : {}), ...recordNavState(order ?? [], path) } });
  };
  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <AccountsList onOpen={openCompany} only={["accounts"]} />
    </div>
  );
}
