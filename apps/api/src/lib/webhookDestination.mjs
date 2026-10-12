// Where a webhook delivers (GET-670), read the same way by /v2/webhooks and the app's /api/triggers.
//
//   { "url": "https://…" }                                              a URL, as before
//   { "destination": { "type": "url", "url": "https://…" } }            the same, spelled out
//   { "destination": { "type": "github", "repo": "owner/name", "token": "github_pat_…" } }
//   { "destination": { "type": "github", "connected_repo": true } }    the caller's repo from Settings →
//       Repo, with the token already stored there: nothing secret travels in the request (GET-672)
//   { "destination": { "type": "github", "connected_repo": "company" } } the workspace's company repo;
//       admins only, since its token is the workspace's, not the caller's (GET-674)
//
// The GitHub token is encrypted here, before it reaches core or the database, and is never read
// back: a webhook's JSON shows the repo, never the token.
import { getSupabaseClient, connectedRepoDestination, connectedRepos } from '@nous/core';
import { encryptValue, decrypt } from '../providers/crypto.mjs';

/**
 * Body → a core TriggerDestination, or undefined when the body names none. Throws a short code.
 * `req` resolves connected_repo to the caller's own seat (a member key, or the signed-in person).
 */
export async function destinationFromBody(body, req) {
  const d = body?.destination;
  if (d == null) return body?.url ? { type: 'url', url: String(body.url) } : undefined;
  if (typeof d !== 'object') throw new Error('invalid_destination');
  if (d.type === 'url') {
    if (!d.url) throw new Error('url_required');
    return { type: 'url', url: String(d.url) };
  }
  if (d.type === 'github' && d.connected_repo != null && d.connected_repo !== false) {
    const source = d.connected_repo === 'company' ? 'company' : 'personal';
    const userId = req?.memberUserId ?? req?.internalUserId ?? null;
    if (source === 'personal' && !userId) throw new Error('connected_repo_needs_a_person');
    if (source === 'company' && !isAdmin(req)) throw new Error('company_repo_needs_admin');
    const dest = await connectedRepoDestination(getSupabaseClient(), req.workspaceId, userId, source);
    if (!dest) throw new Error('no_connected_repo');
    return dest;
  }
  if (d.type === 'github') {
    if (!d.repo) throw new Error('github_repo_required');
    if (!d.token || typeof d.token !== 'string') throw new Error('github_token_required');
    return { type: 'github', repo: String(d.repo), tokenEnc: encryptValue(d.token.trim()) };
  }
  throw new Error('invalid_destination_type');
}

// The company repo's token belongs to the workspace: an owner or admin may point a webhook at it.
const isAdmin = (req) => req?.viewerScope === 'admin';

/** GET …/github-repos: the connected repos this caller may pick, never their tokens. */
export async function githubReposFor(req) {
  const userId = req?.memberUserId ?? req?.internalUserId ?? null;
  const repos = await connectedRepos(getSupabaseClient(), req.workspaceId, userId);
  return repos.map(r => ({ ...r, usable: r.source === 'personal' || isAdmin(req) }));
}

/** A webhook as the API returns it: the destination spelled out, the token and secret never. */
export function webhookOut(sub) {
  if (!sub) return null;
  // eslint-disable-next-line no-unused-vars
  const { signing_secret, github_token_enc, workspace_id, ...rest } = sub;
  const destination = rest.destination_type === 'github'
    ? { type: 'github', repo: rest.github_repo }
    : { type: 'url', url: rest.url };
  return { ...rest, destination };
}

/** A webhook the Settings → Automations toggle owns is changed there, not here. */
export function managedRefusal(sub) {
  if (!sub?.managed_by) return null;
  return {
    error: 'managed_by_automation',
    detail: 'This webhook belongs to "After every call". Turn it on or off in Settings → Automations; it follows your connected repo.',
  };
}

/** The decrypt a send needs for a GitHub destination's token. */
export const decryptToken = (enc) => decrypt(enc);
