// AccountLimitWall — what the app shows once a team has been over its active-account cap
// for longer than the grace window (state 'restricted', GET-209).
//
// It replaces the page, not the app: the sidebar stays, and Billing / Usage / Settings stay
// open so the way out is always one click away. Nothing stops underneath — ingest keeps
// landing and the plugin keeps reading — so upgrading unlocks a workspace that is already
// up to date. The server enforces the part that costs us (account creation 402s in
// requireAccountsBalance); this wall is the product consequence, not a security boundary.
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import type { ActiveAccountsUsage } from "@/hooks/usePlan";

/** Routes that stay reachable while locked — the way out. */
export const ACCOUNT_LIMIT_OPEN_PATHS = ["/billing", "/usage", "/settings"];

export function isAccountLimitOpenPath(pathname: string): boolean {
  return ACCOUNT_LIMIT_OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AccountLimitWall({ accounts, planName }: { accounts: ActiveAccountsUsage; planName: string }) {
  const fmt = (n: number) => n.toLocaleString();
  const graceLabel = accounts.graceDays ? `${accounts.graceDays}-day grace window` : "grace window";

  return (
    <div className="flex h-full items-center justify-center bg-background px-6">
      <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/40">
          <Lock className="h-5 w-5 text-foreground" />
        </div>
        <h1 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
          You&rsquo;re over your account limit
        </h1>
        <p className="mx-auto mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          You have {fmt(accounts.used)} active accounts on the {planName} plan, which includes{" "}
          {fmt(accounts.included ?? 0)}. The {graceLabel} has ended, so the app is paused until you
          move to a larger plan. Your accounts, history and incoming data are untouched, and
          upgrading unlocks everything straight away.
        </p>
        <Link
          to="/billing"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          See plans
        </Link>
      </div>
    </div>
  );
}
