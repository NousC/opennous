// Whose book is this? (Phase 2 of the ownership work.)
//
// A rep opens the workspace and should see what they own — not the whole company's pipeline, and
// not a slice chosen by their job title. The CRM usually already knows: HubSpot carries an owner on
// most companies and open deals, and our sync has been writing
// `owner_name`/`owner_email` for both since the integration landed.
//
// What was missing is the join between a person signing in here and an owner record over there.
// `Odile Ferncastle` on a deal and a Supabase session are two unrelated strings until something says
// they are the same person. That is this module, and the `workspace_crm_owners` table behind it.
//
// ONE OWNER, NOT ONE PER ROLE. A second edge named after a job — a CS owner fed by a customer's
// custom property — would put a job title into the schema for one portal's field. What separates
// sales work from customer-success work is the PIPELINE a deal sits in, not a second owner: the
// same rep commonly holds both, owning deals in the sales pipeline and in the expansion one.
// Ownership answers "whose"; the pipeline answers "which motion".
//
// A customer who records ownership in a custom property is served by mapping that property onto
// `owner_name` at sync time, which every CRM customer can use, not by a column only one of them
// can fill.
//
// IT FAILS OPEN, DELIBERATELY. A viewer we cannot resolve to a CRM owner sees everything, exactly
// as they do today. Scoping that failed CLOSED would turn one unmapped account into an empty
// workspace and look identical to data loss, and the mapping is hand-checked by an admin. Every
// caller therefore treats `null` as "no filter", never as "no rows".

const ADMIN_SCOPES = new Set(['admin', 'owner']);

/**
 * Who the caller is, in CRM terms.
 * @returns {Promise<{names: string[], emails: string[]} | null>} null = unrestricted.
 */
export async function resolveViewerOwner(supabase, workspaceId, req) {
  // Admins and leadership read the whole workspace. So does an unauthenticated legacy caller.
  if (!req || ADMIN_SCOPES.has(req.viewerScope) || req.viewerScope == null) return null;
  const userId = req.internalUserId ?? req.memberUserId ?? null;
  if (!userId) return null;

  const mapped = await readMapping(supabase, workspaceId, userId);
  if (mapped) return mapped;

  // Nothing mapped yet: try the one join that cannot be wrong, the member's own email against the
  // CRM owner's. Names are never matched — two people share a name far more often than an inbox,
  // and a wrong match shows a rep somebody else's book rather than an empty one.
  return await matchByEmail(supabase, workspaceId, userId);
}

// ── scope=mine | team (the workspace redesign's My book / Team toggle) ─────────────────────────
//
// An explicit ask, layered on top of the rule above without changing it: a list that is not sent
// `scope` reads exactly what it read before.
//
//   team  the whole workspace, for anyone. The workspace is open-read; role gating is UI-only.
//   mine  the viewer's OWN book, even for an admin: a founder pressing "My book" means theirs,
//         not the company's. And here, alone in this module, scoping fails CLOSED: a viewer we
//         cannot place gets an empty book flagged `unmapped`, because answering "mine" with the
//         whole team would be a list that lies about what it is. The page says so instead.

/** The `scope` query param as the lists accept it; anything else means "not asked". */
export const readScope = (raw) => (raw === 'mine' || raw === 'team' ? raw : null);

/**
 * The viewer's own CRM owner, whatever their role. Same two joins as resolveViewerOwner (the
 * admin's hand mapping, then the member's email against an owner email on the accounts), minus
 * the admin pass. null = we could not place them.
 *
 * `withLoginEmail` also puts the viewer's sign-in address in `emails`, placed or not. That is for
 * the Customer Success book, whose rows carry the CS owner's email: a CS rep who is nobody's AE
 * owns no account row, so the email join above never finds them, yet their own inbox IS the CS
 * owner email on their customers. `placed` says whether either real join matched.
 * @returns {Promise<{names: string[], emails: string[], placed?: boolean} | null>}
 */
export async function resolveOwnOwner(supabase, workspaceId, req, { withLoginEmail = false } = {}) {
  const userId = req?.internalUserId ?? req?.memberUserId ?? null;
  if (!userId) return null;
  const mapped = await readMapping(supabase, workspaceId, userId);
  if (mapped && !withLoginEmail) return mapped;
  const { data: user } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  const owner = mapped ?? await ownerByEmail(supabase, workspaceId, user?.email);
  if (!withLoginEmail) return owner;
  const login = String(user?.email ?? '').trim().toLowerCase();
  if (!owner && !login) return null;
  return {
    names: owner?.names ?? [],
    emails: [...new Set([...(owner?.emails ?? []), ...(login ? [login] : [])])],
    placed: !!owner,
  };
}

/**
 * Whose book a list reads, from its `scope` param.
 *   absent  today's rule, untouched: resolveViewerOwner (admins all, a rep their own, unplaced open)
 *   team    owner null: no filter
 *   mine    the viewer's own owner; `unmapped` true when we could not place them, and the caller
 *           answers an empty book with `scope_unmapped: true`
 * @returns {Promise<{scope: 'mine'|'team'|null, owner: {names: string[], emails: string[]}|null, unmapped: boolean}>}
 */
export async function resolveScopedOwner(supabase, workspaceId, req, rawScope, opts = {}) {
  const scope = readScope(rawScope);
  if (scope === 'team') return { scope, owner: null, unmapped: false };
  if (scope === 'mine') {
    const owner = await resolveOwnOwner(supabase, workspaceId, req, opts).catch(() => null);
    const placed = owner ? (owner.placed ?? true) : false;
    return { scope, owner, unmapped: !placed };
  }
  return { scope: null, owner: await resolveViewerOwner(supabase, workspaceId, req), unmapped: false };
}

/**
 * Is this customer row in the viewer's Customer Success book? On the CS page ownership means the
 * CS owner, a different person from the AE on nearly every account at the first customer, so the AE
 * is only ever a stand-in, and only in the default mode.
 *
 *   default (no scope)  where the workspace records no CS owner at all, fall back to the account
 *                       owner; a row nobody owns stays visible (fail open, as above)
 *   strict (mine)       the CS owner only, never the AE; a row with no CS owner is nobody's, so
 *                       it is not mine
 *
 * `row` is the classified customer row: `health` is its cs bag, `ownerName`/`ownerEmail` the AE.
 */
export function csBookMatcher(viewer, { csOwned = false, strict = false } = {}) {
  const emails = new Set((viewer?.emails ?? []).map(e => String(e).toLowerCase()));
  const names = new Set((viewer?.names ?? []).map(n => String(n).toLowerCase()));
  return (row) => {
    const h = row?.health ?? {};
    const fallback = !strict && !csOwned;
    const e = String(h.owner_email ?? (fallback ? row?.ownerEmail : '') ?? '').toLowerCase();
    const n = String(h.owner_name ?? (fallback ? row?.ownerName : '') ?? '').toLowerCase();
    if (!e && !n) return !strict;
    return !!((e && emails.has(e)) || (n && names.has(n)));
  };
}

async function readMapping(supabase, workspaceId, userId) {
  const { data, error } = await supabase.from('workspace_crm_owners')
    .select('owner_name, owner_email')
    .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  // The table is applied by hand like the rest; until it exists, everyone is unmapped and the
  // lists stay open. An absent mapping table must never read as "this rep owns nothing".
  if (error || !data) return null;
  const names = [data.owner_name].filter(Boolean);
  const emails = [data.owner_email].filter(Boolean);
  return names.length || emails.length ? { names, emails } : null;
}

async function matchByEmail(supabase, workspaceId, userId) {
  const { data: user } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  return ownerByEmail(supabase, workspaceId, user?.email);
}

/**
 * The CRM owner behind an email, as the owner filter wants it, or null when no account row
 * carries that owner email. Used for the viewer's own book above, and by the public API's
 * `owner=` filter (/v2/accounts, /v2/deals), so both read an owner the same way.
 */
export async function ownerByEmail(supabase, workspaceId, rawEmail) {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  if (!email) return null;
  const { data: rows } = await supabase.from('entity_list_rows')
    .select('owner_name, owner_email')
    .eq('workspace_id', workspaceId).eq('kind', 'account')
    .ilike('owner_email', email)
    .limit(1);
  const hit = rows?.[0];
  if (!hit?.owner_email) return null;
  return { names: [hit.owner_name].filter(Boolean), emails: [hit.owner_email] };
}

/** PostgREST `in.()` cannot hold a bare comma or paren, and CRM names arrive with both. */
const quoteList = (values) =>
  values.map(v => `"${String(v).replace(/"/g, '')}"`).join(',');

/**
 * The owner test as one `or` group. Repeated `or` params are ANDed by PostgREST, so this composes
 * with the window and country filters already on these queries.
 * @param {{names: string[], emails: string[]}} owner
 */
export function ownerFilter(owner) {
  if (!owner) return null;
  const parts = [];
  if (owner.names?.length) parts.push(`owner_name.in.(${quoteList(owner.names)})`);
  if (owner.emails?.length) parts.push(`owner_email.in.(${quoteList(owner.emails)})`);
  return parts.length ? parts.join(',') : null;
}
