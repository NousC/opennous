// FeatureUpgrade — the one paywall in the app.
//
// Rendered when someone reaches a route their plan doesn't include: by typing the URL,
// by an old bookmark, or by a server 403 on a surface they nominally have. It replaces
// the silent <Navigate to="/accounts"> that used to happen instead, which told the user
// nothing and looked like a bug.
//
import { Lock } from "lucide-react";
import { contactUrl } from "@/config/contact";
import type { PlanFeatures } from "@/config/plans";
import { upsellCopy } from "@/config/upsell";

export function FeatureUpgrade({ feature }: { feature: keyof PlanFeatures }) {
  const { name } = upsellCopy(feature);

  // Self-serve is one plan at four volumes, and nothing above it is sold from here (GET-1087):
  // this names no other plan and offers no upgrade, only a conversation.
  return (
    <div className="flex h-full items-center justify-center bg-background px-6">
      <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/40">
          <Lock className="h-5 w-5 text-foreground" />
        </div>
        <h1 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
          {name} isn&rsquo;t on your plan
        </h1>
        <a
          href={contactUrl()}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          Talk to us
        </a>
      </div>
    </div>
  );
}
