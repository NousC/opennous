// Compound keyset cursors for newest-first logs (GET-620 review). Paging on the timestamp alone
// skips rows that share the boundary timestamp (`lt` drops the rest of a same-millisecond burst),
// so the cursor is `<timestamp>|<id>` and the next page is
//   ts < X  OR  (ts = X AND id < Y)     ordered by ts desc, id desc.
// The timestamp is kept exactly as Postgres sent it (microseconds included): round-tripping it
// through Date would truncate to milliseconds and skip rows. A bare timestamp is still accepted
// (the old cursor), paging on the timestamp only. Clients treat the cursor as opaque.

/**
 * Parse `before`. → { at, id } | { at, id: null } | { at: null, id: null } (absent) | { error }.
 * `idPattern` validates the id half (digits for bigint ids, a uuid for uuid ids).
 */
export function parseCursor(raw, { idPattern }) {
  if (raw == null || raw === '') return { at: null, id: null };
  const s = String(raw);
  const bar = s.lastIndexOf('|');
  if (bar === -1) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return { error: 'invalid_before' };
    // The legacy bare-timestamp cursor, normalised as before.
    return { at: new Date(t).toISOString(), id: null };
  }
  const at = s.slice(0, bar);
  const id = s.slice(bar + 1);
  if (Number.isNaN(Date.parse(at)) || /["(),\\]/.test(at) || !idPattern.test(id)) return { error: 'invalid_before' };
  return { at, id };
}

/** The PostgREST `or` filter for the page after (at, id). Values quoted: timestamps carry ':' and '+'. */
export function afterCursorFilter(tsCol, at, id) {
  return `${tsCol}.lt."${at}",and(${tsCol}.eq."${at}",id.lt."${id}")`;
}

/** next_before for a page: null when the page is short (nothing more), else `<ts>|<id>` of the last row. */
export function nextCursor(rows, limit, tsCol) {
  if (!rows?.length || rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return `${last[tsCol]}|${last.id}`;
}

export const BIGINT_ID = /^\d{1,19}$/;
export const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
