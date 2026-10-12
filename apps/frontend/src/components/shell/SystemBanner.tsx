// Real failures, said plainly (standard 14, GET-618, interface refresh). One strip under the
// top bar when something outside the page is wrong and the user can act on it:
//   - the CRM is disconnected (it was syncing, and the connection is gone): nothing new arrives;
//   - the CRM sync is stale (auto-sync on, last sync over 24 hours ago): records may be old.
// Shows the most serious one only. A warning can be hidden for the session; a disconnection
// can't, because everything downstream of it is quietly wrong until it's fixed.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useCrm } from "@/hooks/useCrm";
import { when } from "@/lib/format";
import { toolLogo } from "@/lib/toolLogo";
import { ListTile } from "@/components/ui/list";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const STALE_MS = 24 * 3_600_000;

export function Banner({ tone, children, action, onDismiss, lead }: {
  tone: "risk" | "warning" | "neutral";
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  /** A leading mark, e.g. the CRM's logo in the palette's 24px tile (GET-658, round 2). */
  lead?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "risk" ? "alert" : "status"}
      className={cn(
        // The tint carries the tone; no dot on top of it (polish pass, GET-657).
        "flex items-center gap-2.5 border-b px-4 py-2 text-[13px]",
        tone === "risk" ? "border-risk/20 bg-risk/[0.06]" : tone === "warning" ? "border-warning-dot/25 bg-warning-dot/[0.08]" : "border-hairline bg-hover",
      )}
    >
      {lead}
      <span className="min-w-0 flex-1 leading-snug text-foreground">{children}</span>
      {action && (
        <button
          onClick={action.onClick}
          className="h-7 flex-shrink-0 rounded-lg border border-border/70 bg-card px-2.5 text-[12.5px] text-foreground transition-colors duration-fast hover:bg-hover"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors duration-fast hover:bg-black/[0.05] hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

const DISMISS_KEY = "nous.banner.stale.dismissed";

export function SystemBanner() {
  const navigate = useNavigate();
  const { userData, session } = useAuth();
  const ws = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const crm = useCrm();
  const [hidden, setHidden] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  const sync = useQuery({
    queryKey: ["crm-sync-banner", ws, crm.provider],
    enabled: !!ws && !!crm.provider,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/crm/sync-config?workspaceId=${ws}&provider=${crm.provider}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return (d?.config ?? null) as { auto_sync?: boolean; last_synced_at?: string | null } | null;
    },
  });

  const toSources = () => navigate("/settings?section=company-sources");
  const logo = toolLogo(crm.provider);
  const lead = logo ? <ListTile><img src={logo} alt="" className="h-3.5 w-3.5 object-contain" /></ListTile> : undefined;
  const config = sync.data;
  if (!crm.provider || !config) return null;

  if (!crm.connected) {
    return (
      <Banner tone="risk" lead={lead} action={{ label: `Reconnect ${crm.label}`, onClick: toSources }}>
        {crm.label} is disconnected. Nothing new is syncing until it's reconnected.
      </Banner>
    );
  }

  const last = config.last_synced_at ? Date.parse(config.last_synced_at) : NaN;
  if (config.auto_sync && !Number.isNaN(last) && Date.now() - last > STALE_MS && !hidden) {
    return (
      <Banner
        tone="warning"
        lead={lead}
        action={{ label: "Check connection", onClick: toSources }}
        onDismiss={() => { setHidden(true); try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ } }}
      >
        {crm.label} last synced {when(last)}. Records may be out of date.
      </Banner>
    );
  }
  return null;
}
