import { decrypt } from '../../utils/encryption.mjs';

// Push ONE evidence file out to the owning member's connected GitHub repo, if they have
// one. This is the Nous → user lane of the vault: Nous OWNS the accounts/ and people/
// folders and writes them; the user owns everything else in their repo. It's one-way by
// construction — accounts/people are not foundation folders, so the inbound sync
// (webhook/poll) ignores them, and nothing ever flows back. No conflict resolution, no
// merge: Nous is the sole writer of this subtree.
//
// Best-effort: a push failure NEVER blocks the evidence write. The row is already safe in
// Supabase (the agent reads it from there regardless); a failed push just leaves git_sha
// unset so a later push/sweep retries.

const GH = 'https://api.github.com';
const clean = (s) => String(s ?? '').replace(/^\/+|\/+$/g, '');
const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

// Nous writes evidence into its OWN top-level folder in the user's repo, never straight
// into a root `accounts/`/`people/` the user may already keep (people/ especially is a
// common PKM folder). Everything Nous writes lives under `nous/` — so "Nous owns the nous/
// folder, the user owns the rest" is literally true, zero overlap. Fixed spot:
// <base_path>/nous/<folder>/<subfolder>/<name>. Subfolder = resolved entity slug; name =
// the touch. accounts/people are never folder-mapped and never ingested back (one-way).
const NOUS_DIR = 'nous';
function repoPath(base_path, folder, subfolder, name) {
  return [base_path, NOUS_DIR, folder, subfolder, name].filter(Boolean).map(clean).join('/');
}

export async function pushEvidenceFile(supabase, {
  workspaceId, ownerUserId, fileId, folder, subfolder, name, content, gitSha,
}) {
  try {
    if (!workspaceId || !ownerUserId || !folder || !name) return;
    const { data: src } = await supabase.from('personal_workspaces')
      .select('source_type, auto_sync, github_repo, github_branch, base_path, github_token_enc')
      .eq('workspace_id', workspaceId).eq('user_id', ownerUserId).maybeSingle();
    // Only members who chose GitHub sync (and left auto-sync on) get the export. Everyone
    // else keeps their evidence in Supabase only — the push is opt-in by connecting a repo.
    if (!src || src.source_type !== 'github' || src.auto_sync === false) return;
    if (!src.github_repo || !src.github_token_enc) return;

    const token = decrypt(src.github_token_enc);
    if (!token) return;

    const path = repoPath(src.base_path, folder, subfolder, name);
    const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    const url = `${GH}/repos/${src.github_repo}/contents/${path}`;
    const put = (sha) => {
      const body = { message: `nous: evidence ${path}`, content: b64(content) };
      if (src.github_branch) body.branch = src.github_branch;
      if (sha) body.sha = sha;
      return fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
    };

    let r = await put(gitSha);
    // 409/422 = our stored sha is stale or missing (e.g. after a connect-time backfill tree
    // commit changed every blob sha). Self-heal: fetch the file's current sha and retry once.
    if (r.status === 409 || r.status === 422) {
      const ref = src.github_branch ? `?ref=${encodeURIComponent(src.github_branch)}` : '';
      const cur = await fetch(`${url}${ref}`, { headers: ghHeaders });
      if (cur.ok) { const d = await cur.json(); if (d?.sha) r = await put(d.sha); }
    }
    if (!r.ok) { console.warn(`[evidence] push ${path} failed (${r.status})`); return; }
    const d = await r.json();
    const newSha = d?.content?.sha ?? null;
    if (newSha && fileId) {
      await supabase.from('personal_files').update({ git_sha: newSha }).eq('id', fileId);
    }
  } catch (err) {
    console.warn('[evidence] pushEvidenceFile failed:', err?.message || err);
  }
}
