// The Automations content, shared by the standalone page and the Settings section.
//
// "Built-in | Sequences" is gone (GET-426). It split the list by WHERE A THING CAME FROM —
// ours or yours — which is a fact about us, not about the work. You do not care which shelf
// an automation was taken off; you care what runs and what it did. So the one list holds
// both, and the switch on the right is Automations | History: what runs, and what ran.
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { BuiltInAutomations } from "@/components/BuiltInAutomations";

export function AutomationsPanel() {
  const query = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const initial = query.get("view");
  const [view, setView] = useState<"automations" | "history">(initial === "history" ? initial : "automations");
  // Approvals are the Inbox's now (GET-1084): an old link lands there.
  if (initial === "approvals") {
    const run = query.get("run");
    return <Navigate to={run ? `/inbox?item=${encodeURIComponent(`run:${run}`)}` : "/inbox?tab=workflows"} replace />;
  }
  return <BuiltInAutomations view={view} onView={setView} />;
}
