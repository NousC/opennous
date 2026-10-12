// Automations — the work that runs without being asked. WHEN · MAKE · SEND, plus the custom
// kind (your own prompt on your own trigger). The content lives in AutomationsPanel so this
// page and the Settings section stay identical.
//
// Interface refresh (GET-616): the top bar names the page; the panel draws its own toolbar row
// (Automations / Run history, New automation) under it.
import { AutomationsPanel } from "@/components/AutomationsPanel";

export default function Workflows() {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <AutomationsPanel />
    </div>
  );
}
