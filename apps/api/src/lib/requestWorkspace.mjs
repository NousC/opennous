// The workspace a request names (GET-247). Auth checks one value and handlers read their own, in
// their own order, so a request naming two workspaces could have one checked and the other used.
// The auth middlewares refuse that here, once, instead of every route having to be careful.

/** Every workspace the query and body name, in the order auth reads them. */
export function claimedWorkspaces(req) {
  return [req.query?.workspaceId, req.query?.workspace_id, req.body?.workspaceId, req.body?.workspace_id]
    .filter(Boolean);
}

/** Refuse a request naming anything but `workspaceId`. Returns whether it answered. */
export function refuseForeignWorkspace(req, res, workspaceId) {
  if (claimedWorkspaces(req).every((w) => w === workspaceId)) return false;
  res.status(403).json({ error: 'workspace_mismatch', detail: 'This key belongs to a different workspace.' });
  return true;
}

/** Refuse a request whose workspace fields disagree. Returns whether it answered. */
export function refuseAmbiguousWorkspace(req, res) {
  const named = claimedWorkspaces(req);
  if (named.every((w) => typeof w === 'string' && w === named[0])) return false;
  res.status(400).json({ error: 'workspace_mismatch', detail: 'This request names more than one workspace.' });
  return true;
}
