// The Automations content, shared by the standalone page and the Settings section.
//
// "Built-in | Sequences" is gone (GET-426). It split the list by WHERE A THING CAME FROM —
// ours or yours — which is a fact about us, not about the work. You do not care which shelf
// an automation was taken off; you care what runs and what it did. So the one list holds
// both, and the switch on the right is Automations | History: what runs, and what ran.
import { useState } from "react";
import { BuiltInAutomations } from "@/components/BuiltInAutomations";

export function AutomationsPanel() {
  // ?view=approvals opens straight on Approvals (from a test run's "Review", GET-724).
  const initial = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("view");
  const [view, setView] = useState<"automations" | "history" | "approvals">(initial === "approvals" || initial === "history" ? initial : "automations");
  return <BuiltInAutomations view={view} onView={setView} />;
}
