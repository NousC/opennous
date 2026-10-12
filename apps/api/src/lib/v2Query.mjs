// Query-string conventions for the public /v2 routes.
//
// Strict allow-list: a filter the API does not support fails loudly (400 unknown_query_param
// + the supported list), the same rule GET /v2/people set — otherwise a caller believes it
// filtered when it didn't. Paging: limit (default 50, max 200) + offset; lists answer
// { <items>, limit, offset, has_more }.

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Express middleware: reject any query param not in `allowed`. */
export function allowQueryParams(allowed) {
  const list = [...allowed];
  return (req, res, next) => {
    const unknown = Object.keys(req.query || {}).filter(k => !list.includes(k));
    if (unknown.length) {
      return res.status(400).json({
        error: 'unknown_query_param',
        detail: `unsupported query param(s): ${unknown.join(', ')}`,
        supported: list,
      });
    }
    return next();
  };
}

/**
 * limit/offset from a query, or { error } when either is not a non-negative integer.
 * limit is clamped to [1, MAX_LIMIT].
 */
export function parsePaging(query = {}) {
  const intOf = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
  const l = intOf(query.limit);
  const o = intOf(query.offset);
  if (l != null && (!Number.isInteger(l) || l < 1)) return { error: 'invalid_limit' };
  if (o != null && (!Number.isInteger(o) || o < 0)) return { error: 'invalid_offset' };
  return { limit: Math.min(l ?? DEFAULT_LIMIT, MAX_LIMIT), offset: o ?? 0 };
}

/** Express middleware: only an admin-scoped key may go on. Member-scoped keys get 403. */
export function requireAdminKey(req, res, next) {
  if (req.viewerScope !== 'admin') {
    return res.status(403).json({ error: 'admin_key_required', detail: 'This action needs a workspace admin API key; this key is member-scoped.' });
  }
  return next();
}
