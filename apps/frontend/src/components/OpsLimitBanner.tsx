import { useNavigate } from "react-router-dom";
import { usePlan } from "@/hooks/usePlan";
import { Banner } from "@/components/shell/SystemBanner";
import { num } from "@/lib/format";

function daysLeft(graceUntil: string | null): number {
  if (!graceUntil) return 0;
  const ms = new Date(graceUntil).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Top-of-app banner reflecting the team's ACTIVE-ACCOUNT state — the one metered
 * unit. Shows nothing at 'ok'; nudges at 'warn' (>=80%), counts down at 'grace'
 * (over the cap, N days left before the app locks), and at 'restricted' sits above
 * the AccountLimitWall on the pages that stay open (Billing / Usage / Settings).
 *
 * Reads usePlan — the same /api/usage answer the wall and the route guards use. It
 * used to fetch /api/billing/state on its own and read `accounts` off a response that
 * only ever carried `activeAccounts`, so it never rendered (GET-209).
 */
export function OpsLimitBanner() {
  const navigate = useNavigate();
  const { activeAccounts: data, plan } = usePlan();

  // included: null = unlimited (Custom, self-host).
  if (!data || data.included == null || data.state === "ok") return null;

  const fmt = (n: number) => num(n);
  const restricted = data.state === "restricted";
  const grace = data.state === "grace";
  const left = daysLeft(data.graceUntil);

  const tone = restricted ? "risk" : grace ? "warning" : "neutral";

  const message = restricted
    ? `You're over your ${fmt(data.included)} active-account limit on the ${plan.name} plan and the grace window has ended. The app is paused until you upgrade. Your accounts and incoming data are untouched.`
    : grace
      ? `You're over your ${fmt(data.included)} active-account limit (${fmt(data.used)} / ${fmt(data.included)}). Everything keeps working for ${left} more day${left === 1 ? "" : "s"}, then the app pauses until you upgrade.`
      : `You've used ${data.percentUsed}% of your ${fmt(data.included)} active accounts on the ${plan.name} plan.`;

  // The same strip as the CRM banners (GET-618), so every app-level problem looks alike.
  return <Banner tone={tone} action={{ label: "Upgrade", onClick: () => navigate("/billing") }}>{message}</Banner>;
}
