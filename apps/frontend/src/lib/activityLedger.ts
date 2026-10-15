// Activity's ledger, paged (GET-903). The server reads a small first page and hands back a cursor
// for the next; the page appends what comes after. Pure, so tests/activityLedger.test.ts pins it.

/** Rows on the first page. Small, so the ledger is on screen in a fraction of a second. */
export const FIRST_PAGE = 50;
/** Rows on every page after the first. */
export const NEXT_PAGE = 100;

/** The query string for GET /api/activity-stats/conversations. `days` null is all time. */
export function conversationsQuery(workspaceId: string, days: number | null, limit: number = FIRST_PAGE, cursor?: string | null): string {
  const q = new URLSearchParams({ workspaceId, days: days == null ? "all" : String(days), limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return q.toString().replace(/\+/g, "%20");
}

/**
 * The next page appended to what is shown. An email thread whose older messages fall past a page
 * edge comes back on the next page too; the first copy, which carries the newest message, stays.
 */
export function mergePage<T extends { id: string }>(prev: T[] | null, next: T[]): T[] {
  const out = [...(prev ?? [])];
  const seen = new Set(out.map((r) => r.id));
  for (const r of next) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
  return out;
}
