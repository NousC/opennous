// The API plan Home's stat cards (GET-628), shaped from real payloads. Pure, so
// tests/apiHome.test.ts pins them. A failed or missing read is null — the card shows a dash,
// never a zero we did not count.

/** GET /api/usage/by-key?days=1 → { days, keys: [{ calls, credits, … }] } (GET-623). */
export type UsageByKey = { days?: number; keys?: { api_key_id: string; calls: number; credits?: number }[] } | null | undefined;

/** Calls today: every key's calls over the current UTC day, summed. */
export function callsToday(d: UsageByKey): number | null {
  if (!d || !Array.isArray(d.keys)) return null;
  return d.keys.reduce((n, k) => n + (Number(k.calls) || 0), 0);
}

/**
 * The card's label. by-key shows an owner/admin every key, but a member only their own keys, so
 * for them the sum is their calls, not the workspace's.
 */
export function callsTodayLabel(isWorkspaceAdmin: boolean): string {
  return isWorkspaceAdmin ? "Calls today" : "Your calls today";
}

/** GET /api/activity-stats/read → the connected tools, deduped by the server. */
export type ReadTools = { tools?: { name: string; label: string; logo_url: string | null }[] } | null | undefined;
export type Source = { name: string; label: string; logo: string | null };

export function connectedSources(d: ReadTools): Source[] | null {
  if (!d || !Array.isArray(d.tools)) return null;
  return d.tools.map((t) => ({ name: t.name, label: t.label || t.name, logo: t.logo_url ?? null }));
}
