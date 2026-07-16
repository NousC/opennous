import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Zap } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type OpsState = "ok" | "warn" | "grace" | "restricted";

type BannerData = {
  state: OpsState;
  used: number;
  included: number;
  percentUsed: number;
  graceUntil: string | null;
  planName: string;
};

function daysLeft(graceUntil: string | null): number {
  if (!graceUntil) return 0;
  const ms = new Date(graceUntil).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Top-of-app banner reflecting the team's monthly ops state. Shows nothing in the
 * 'ok' state; nudges at 'warn' (>=80%), 'grace' (over limit, N days left), and
 * blocks-visually at 'restricted' (grace expired). Mirrors the backend
 * requireOpsBalance gate — the actual enforcement happens server-side.
 */
export function OpsLimitBanner() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<BannerData | null>(null);

  const load = useCallback(async () => {
    const token = session?.access_token;
    if (!token) return;
    try {
      const r = await fetch(`${apiUrl}/api/billing/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.self_hosted || !d?.ops) return; // self-host is unmetered
      setData({
        state: (d.ops.state ?? "ok") as OpsState,
        used: d.ops.used ?? 0,
        included: d.ops.included ?? 0,
        percentUsed: d.ops.percentUsed ?? 0,
        graceUntil: d.ops.graceUntil ?? null,
        planName: d.planName ?? "your",
      });
    } catch {
      /* non-fatal — banner just won't show */
    }
  }, [session?.access_token]);

  useEffect(() => {
    load();
    // Re-check every 5 min so a crossing surfaces without a reload.
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  if (!data || data.state === "ok") return null;

  const fmt = (n: number) => n.toLocaleString();
  const restricted = data.state === "restricted";
  const grace = data.state === "grace";

  const tone = restricted
    ? "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300"
    : grace
      ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
      : "bg-muted border-border text-muted-foreground";

  const Icon = restricted ? AlertTriangle : Zap;

  const message = restricted
    ? `Operations are paused. You've used all ${fmt(data.included)} monthly operations on the ${data.planName} plan and the 3-day grace window has ended. Incoming signal is still being captured — upgrade to resume agent and outbound operations.`
    : grace
      ? `You're over your monthly operations limit (${fmt(data.used)} / ${fmt(data.included)}). Everything keeps working for ${daysLeft(data.graceUntil)} more day${daysLeft(data.graceUntil) === 1 ? "" : "s"} — upgrade before then to avoid interruption.`
      : `You've used ${data.percentUsed}% of your ${fmt(data.included)} monthly operations on the ${data.planName} plan.`;

  return (
    <div className={`flex items-center gap-3 border-b px-5 py-2.5 text-[13px] ${tone}`}>
      <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={2.2} />
      <span className="flex-1 leading-snug">{message}</span>
      <button
        onClick={() => navigate("/usage")}
        className={`flex-shrink-0 h-7 px-3 rounded-md text-[12.5px] font-semibold transition-opacity hover:opacity-90 ${
          restricted ? "bg-red-600 text-white" : grace ? "bg-amber-600 text-white" : "bg-foreground text-background"
        }`}
      >
        {restricted ? "Upgrade to resume" : "Upgrade"}
      </button>
    </div>
  );
}
