// Which onboarding steps are done (GET-517), from /api/onboarding/checklist. `complete` is every
// step: CRM, email and meeting notes, the backfill started, an API key, and an agent connected. Once it is,
// the Get started page and its sidebar link go away.
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type OnboardingChecklist = {
  crm: { done: boolean; provider: string | null; imported: boolean; accounts: number };
  mail: { done: boolean; providers?: string[] };
  notes: { done: boolean; providers?: string[] };
  backfill: { state: "none" | "waiting" | "running" | "done"; started: boolean; start_on_payment?: boolean };
  /** live = may backfill (paid or comped); free = on the Free plan (GET-682). */
  plan?: { live: boolean; free?: boolean };
  /** An invited member onboards their own sources and backfill, not the CRM (GET-571). */
  seat?: "founder" | "member";
  api_key: { created: boolean; used: boolean };
};

export function checklistComplete(c: OnboardingChecklist | null): boolean {
  return !!c && (c.seat === "member" || c.crm.done) && c.mail.done && c.notes.done
    && (c.backfill.state === "running" || c.backfill.state === "done") && c.api_key.used;
}

export function useOnboardingChecklist(pollMs = 0) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [checklist, setChecklist] = useState<OnboardingChecklist | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!token || !workspaceId) return;
    let alive = true;
    fetch(`${apiUrl}/api/onboarding/checklist?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) { if (d) setChecklist(d); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [token, workspaceId, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => setTick((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  return { checklist, loaded, complete: checklistComplete(checklist), reload: () => setTick((n) => n + 1) };
}
