// The Accounts table's per-account overview (GET-894, GET-910, GET-924): each account's deal count
// and its latest signal, read in one call (the account_overview RPC,
// supabase/migrations/2026_10_15_account_overview.sql) for the accounts on screen. A latest signal
// the team may not read (its fact came from a private message) is left out.

async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }

// A database that predates account_overview has the same read under another name: a deployment can
// register it here, and it is used only while account_overview is missing (PostgREST PGRST202).
let fallbackRpc = null;
/** Name an older RPC with account_overview's signature to call while the database lacks it. */
export function registerAccountOverviewFallback(name) { fallbackRpc = name || null; }

async function overviewRows(sb, ws, ids) {
  const args = { p_workspace_id: ws, p_ids: ids };
  const { data, error } = await sb.rpc('account_overview', args);
  if (!error) return data ?? [];
  if (error.code === 'PGRST202' && fallbackRpc) return rows(sb.rpc(fallbackRpc, args));
  throw error;
}

/** [{ id, deal_count, latest_signal }] for these account ids, in the RPC's order. */
export async function accountOverview(sb, ws, ids) {
  if (!ids.length) return [];
  const accounts = await overviewRows(sb, ws, ids);
  const signals = accounts.map(a => a.latest_signal).filter(Boolean);
  if (!signals.length) return accounts;
  // Loaded here, not at the top: this module is also imported straight from src (tests), where the
  // privacy module's TypeScript imports do not resolve.
  const { filterDerivedForViewer, TEAM_VIEWER } = await import('../privacy/messagePrivacy.mjs');
  const facts = await rows(sb.from('claims').select('entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id', ws).in('entity_id', [...new Set(signals.map(s => s.entity_id).filter(Boolean))]).in('property', [...new Set(signals.map(s => s.claim_property).filter(Boolean))]).is('invalid_at', null));
  const readable = new Set((await filterDerivedForViewer(sb, ws, facts, TEAM_VIEWER, { isDerived: () => true })).map(f => `${f.entity_id}|${f.property}`));
  return accounts.map(a => ({ ...a, latest_signal: a.latest_signal && readable.has(`${a.latest_signal.entity_id}|${a.latest_signal.claim_property}`) ? a.latest_signal : null }));
}

/** Throws 401/403 unless `uid` is a member of `ws`. */
export async function requireWorkspaceMember(sb, ws, uid) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (!ws || !uid) fail(401, 'Sign in to continue.');
  const { data, error } = await sb.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', uid).maybeSingle();
  if (error) throw error;
  if (!data) fail(403, 'You are not a member of this workspace.');
}
