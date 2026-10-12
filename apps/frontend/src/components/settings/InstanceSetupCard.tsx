// The one nudge a self-hosted owner gets on Home (GET-837): there is no setup pop-up on
// self-host, so this card points at Settings → Instance setup until it is dismissed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { usePlan } from "@/hooks/usePlan";

const KEY = "instance-setup-card.dismissed";

export function InstanceSetupCard() {
  const { selfHosted } = usePlan();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } });
  if (!selfHosted || hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ } };
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 sm:mx-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">Finish setting up your instance</p>
        <p className="text-[12.5px] text-muted-foreground">Choose your AI models and see which integrations are ready.</p>
      </div>
      <Link to="/settings?section=instance" className="inline-flex h-7 shrink-0 items-center rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background hover:opacity-90">
        Instance setup
      </Link>
      <button onClick={dismiss} aria-label="Dismiss" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
