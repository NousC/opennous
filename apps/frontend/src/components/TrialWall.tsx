// After a trial ends the app is this screen until they subscribe (GET-1087). Billing, settings and
// admin stay open behind it. Nothing is deleted, and it all comes back the moment they pay.
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function TrialWall() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-[420px]">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Your trial has ended</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">Everything has stopped. Your data is kept and comes back the moment you subscribe.</p>
        <Button className="mt-5" onClick={() => navigate("/billing?upgrade=1")}>Subscribe</Button>
      </div>
    </div>
  );
}
