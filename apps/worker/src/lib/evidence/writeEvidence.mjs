import { createHash } from 'node:crypto';
import { embed } from '@nous/core';
import { pushEvidenceFile } from './pushEvidence.mjs';

// The evidence writer — files the RAW of one touch (an email thread, a call, a Slack
// conversation) as a clean markdown file in the OWNING member's personal vault, under
// `accounts/<acct>/` (the GTM view) or `people/<person>/`. Owner-private. The folder is
// cosmetic; the frontmatter `account:`/`people:` carry the RESOLVED entity ids (the
// truth). Extracted claims are untouched — only the raw moves here.

// Evidence files land in the member's OWN vault (and their git) — that's the headless,
// API-plan data-ownership model: on API your team works through their own agents and owns
// their data. On Custom (run-it-for-you) the team works in our app, so raw stays in Nous
// and we do NOT scatter it into vault files. So the writer is gated to API-plan workspaces.
// Cached per workspace (5-min TTL) so it's not a plan lookup on every single touch.
const _planCache = new Map();   // workspaceId -> { planId, at }
export async function isApiPlanWorkspace(supabase, workspaceId) {
  const hit = _planCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.planId === 'api';
  let planId = 'free';
  try {
    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
    if (ws?.team_id) {
      const { data: sub } = await supabase.from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle();
      const dead = sub && ['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status);
      planId = (!sub || dead) ? 'free' : (sub.plan_id || 'free');
    }
  } catch { /* on any error, default free → not api → skip (fail closed) */ }
  _planCache.set(workspaceId, { planId, at: Date.now() });
  return planId === 'api';
}

const hashOf = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
const slugify = (s) => String(s ?? '').toLowerCase().trim()
  .replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
const dateSlug = (iso) => (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10);

// Slug the resolved entity from its own name/domain claim — NEVER from a folder path.
async function resolveFiling(supabase, entityId, companyId) {
  let account = null, person = null;
  if (companyId) {
    const { data } = await supabase.from('companies').select('name, domain').eq('id', companyId).maybeSingle();
    if (data) account = { id: companyId, slug: slugify(data.domain || data.name), label: data.name || data.domain };
  }
  if (entityId) {
    const { data } = await supabase.from('contacts').select('first_name, last_name, company').eq('id', entityId).maybeSingle();
    if (data) {
      const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.company || 'contact';
      person = { id: entityId, slug: slugify(name), label: name };
    }
  }
  return { account, person };
}

/**
 * Write/update one evidence file. Skips silently when there's no owner (a system/shared
 * touch, not a private conversation) or no resolved entity (never file under a guess).
 * Idempotent on (source, dedupKey) — re-running the backfill updates the same file.
 */
export async function writeEvidenceFile(supabase, {
  workspaceId, ownerUserId, entityId, companyId,
  type, source, dedupKey, sourceRef, occurredAt, title, markdown,
}) {
  try {
    if (!workspaceId || !ownerUserId || !entityId || !markdown || !dedupKey) return;
    // API plan only (headless data-ownership). Custom keeps raw in Nous — skip the file.
    if (!(await isApiPlanWorkspace(supabase, workspaceId))) return;
    const { account, person } = await resolveFiling(supabase, entityId, companyId);
    const target = account ? { folder: 'accounts', slug: account.slug } : person ? { folder: 'people', slug: person.slug } : null;
    if (!target) return;   // unresolved → no file

    const name = `${dateSlug(occurredAt)}-${String(type).replace(/[^a-z0-9]+/gi, '-')}-${slugify(title).slice(0, 40)}.md`;
    const front = [
      '---',
      `type: ${type}`,
      source ? `source: ${source}` : null,
      sourceRef ? `source_ref: ${sourceRef}` : null,
      `occurred_at: ${occurredAt || new Date().toISOString()}`,
      account ? `account: ${account.id}` : null,
      person ? `people: [${person.id}]` : null,
      `owner: ${ownerUserId}`,
      'ingested_by: nous-sync',
      '---',
      '',
    ].filter((l) => l != null).join('\n');
    const content = front + markdown;
    const extId = `${source}:${dedupKey}`;

    const patch = { folder: target.folder, subfolder: target.slug, name, content, content_hash: hashOf(content), updated_at: new Date().toISOString() };
    const { data: existing } = await supabase.from('personal_files')
      .select('id, git_sha').eq('workspace_id', workspaceId).eq('user_id', ownerUserId).eq('external_id', extId).maybeSingle();
    let id;
    if (existing) { await supabase.from('personal_files').update(patch).eq('id', existing.id); id = existing.id; }
    else {
      const { data: ins } = await supabase.from('personal_files')
        .insert({ workspace_id: workspaceId, user_id: ownerUserId, source: 'sync', status: 'synced', external_id: extId, created_by: ownerUserId, ...patch })
        .select('id').single();
      id = ins?.id;
    }
    // Embed so the owning member's agent can retrieve it (best-effort).
    if (id) {
      const vec = await embed(`${target.folder}\n${target.slug}\n${name}\n${content.slice(0, 8000)}`).catch(() => null);
      if (vec) await supabase.from('personal_files').update({ embedding: JSON.stringify(vec) }).eq('id', id);
    }
    // Export to the owning member's connected GitHub repo — the Nous → user lane. Nous owns
    // accounts/ + people/; one-way, best-effort (never blocks the write above).
    if (id) {
      await pushEvidenceFile(supabase, {
        workspaceId, ownerUserId, fileId: id,
        folder: target.folder, subfolder: target.slug, name, content,
        gitSha: existing?.git_sha ?? null,
      });
    }
  } catch (err) {
    console.warn('[evidence] writeEvidenceFile failed:', err?.message || err);
  }
}

export const evidenceHelpers = { slugify, hashOf };
