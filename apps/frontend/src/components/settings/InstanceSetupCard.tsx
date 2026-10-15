// The one nudge a self-hosted owner gets on Home (GET-837, GET-846): there is no setup pop-up on
// self-host, so this card names the next step of getting data in (connect the CRM, then run the
// revenue backfill) and points at Settings → Instance setup. It goes away once the backfill has
// run, or when dismissed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { usePlan } from "@/hooks/usePlan";
import { useOnboardingChecklist } from "@/hooks/useOnboardingChecklist";

const KEY = "instance-setup-card.dismissed";

export function InstanceSetupCard() {
  const { selfHosted } = usePlan();
  const { checklist: c } = useOnboardingChecklist(selfHosted ? 15_000 : 0);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } });
  if (!selfHosted || hidden || c?.backfill.state === "done") return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ } };

  const [title, line] = !c
    ? ["Finish setting up your instance", "Choose your AI models and see which integrations are ready."]
    : !c.crm.done && !c.mail.done && !c.notes.done
      ? ["Connect your CRM and tools", "Start with your CRM so every conversation lands on the right account, then email and meeting notes."]
      : c.backfill.state === "running"
        ? ["Your revenue backfill is running", "Every account fills in as your history is read."]
        : ["Run your revenue backfill", "Read the history of your connected tools onto every account."];

  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 sm:mx-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-[12.5px] text-muted-foreground">{line}</p>
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
