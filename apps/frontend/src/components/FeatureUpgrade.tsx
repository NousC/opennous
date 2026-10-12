// FeatureUpgrade — the one paywall in the app.
//
// Rendered when someone reaches a route their plan doesn't include: by typing the URL,
// by an old bookmark, or by a server 403 on a surface they nominally have. It replaces
// the silent <Navigate to="/accounts"> that used to happen instead, which told the user
// nothing and looked like a bug.
//
// The markup is the UpgradeState that lived inside Insights, lifted verbatim so that
// surface looks exactly as it did. The copy and the plan name are now derived, not
// hardcoded — upsellCopy() for the sentence, lowestPlanWith() for the plan — so this one
// component covers every gated feature and a repricing doesn't leave stale text behind.
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { lowestPlanWith, type PlanFeatures } from "@/config/plans";
import { upsellCopy } from "@/config/upsell";

export function FeatureUpgrade({ feature }: { feature: keyof PlanFeatures }) {
  const { name, pitch } = upsellCopy(feature);
  const plan = lowestPlanWith(feature);
  const planName = plan?.name ?? "Workspace";
  // Headless is sales-led and unpriced. "Upgrade to Headless" implies a button that charges
  // a card, and there isn't one — it's a conversation.
  const cta = plan?.monthlyPriceUsd === null ? `See ${planName}` : `Upgrade to ${planName}`;

  return (
    <div className="flex h-full items-center justify-center bg-background px-6">
      <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/40">
          <Lock className="h-5 w-5 text-foreground" />
        </div>
        <h1 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
          {name} is a {planName} feature
        </h1>
        <p className="mx-auto mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          {pitch} It&rsquo;s included on {planName}.
        </p>
        <Link
          to="/billing"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          {cta}
        </Link>
      </div>
    </div>
  );
}
