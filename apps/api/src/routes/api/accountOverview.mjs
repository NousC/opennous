// The Accounts table's per-account overview (GET-894): POST /api/account-overview { ids } ->
// { accounts: [{ id, deal_count, latest_signal }] } for the accounts on screen, the ones the viewer
// may not see left out. Each latest signal carries its kind's label, tone and the line that says what
// was said. Its own router since GET-910.
import { Router } from 'express';
import { getSupabaseClient, accountOverview, requireWorkspaceMember, latestSignalView } from '@nous/core';
import { viewerVisibleAccountSet } from '../../lib/visibility.mjs';

export const accountOverviewRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

accountOverviewRouter.post('/', async (req, res) => {
  try {
    if (!req.workspaceId || !req.internalUserId) return res.status(400).json({ error: 'Workspace and signed-in member are required.' });
    const sb = getSupabaseClient();
    await requireWorkspaceMember(sb, req.workspaceId, req.internalUserId);
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose up to 200 account identifiers.');
    const set = await viewerVisibleAccountSet(sb, req.workspaceId, req.internalUserId, { isAdmin: req.viewerScope === 'admin' });
    const visible = set.unrestricted ? null : set.ids;
    res.json({ accounts: accountOverviewRows(await accountOverview(sb, req.workspaceId, visible ? ids.filter(id => visible.has(id)) : ids)) });
  } catch (e) {
    if (e.code === '42P01' || e.code === 'PGRST205' || /schema cache/i.test(e.message ?? '')) return res.status(409).json({ error: 'The database migration has not been applied.' });
    if (!e.status) console.error('[account-overview]', e);
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Could not load the accounts.' });
  }
});

/** The Accounts table's rows (GET-894): the latest signal gains its kind's label, tone and the line that says what was said. */
export function accountOverviewRows(accounts) {
  return accounts.map(a => ({ ...a, latest_signal: latestSignalView(a.latest_signal) }));
}
