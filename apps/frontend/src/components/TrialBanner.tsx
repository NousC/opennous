// The no-card trial, said at the top of the app (GET-1087): days left, then "Trial ended", when the
// rest of the app gives way to the subscribe screen (TrialWall).
import { useNavigate } from "react-router-dom";
import { Banner } from "@/components/shell/SystemBanner";
import { useBillingState } from "@/hooks/useCredits";
import { trialBanner } from "@/lib/trial";

export function TrialBanner() {
  const navigate = useNavigate();
  const banner = trialBanner(useBillingState());
  if (!banner) return null;
  return (
    <Banner tone={banner.tone} action={{ label: "Choose a plan", onClick: () => navigate("/billing?upgrade=1") }}>
      {banner.text}
    </Banner>
  );
}
