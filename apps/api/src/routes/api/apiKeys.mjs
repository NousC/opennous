import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient, isUUID } from '@nous/core';
import { apiKeyScopeFor } from '../../lib/apiKeyScope.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { canSeeKey } from '../../lib/apiKeyUsage.mjs';

export const apiKeysRouter = Router();

// A short, non-secret handle shown next to the key's name ("pk_3f9a1c"): 6 of 48 hex characters.
export const keyPrefixOf = (rawKey) => rawKey.slice(0, 9);

// key_prefix (GET-623) arrives with a hand-applied migration. Until it exists, PostgREST rejects
// the column, and minting a key must not break over a display field: retry without it.
const isMissingPrefixColumn = (e) =>
  (e?.code === 'PGRST204' || e?.code === '42703') && /key_prefix/.test(e?.message ?? '');

async function insertApiKey(supabase, row, columns) {
  let r = await supabase.from('api_keys').insert(row).select(columns).single();
  if (r.error && isMissingPrefixColumn(r.error)) {
    const { key_prefix: _omit, ...rest } = row;
    r = await supabase.from('api_keys').insert(rest).select(columns).single();
  }
  return r;
}

/**
 * Who may rotate or revoke a key: workspace owners/admins, the person the key acts as, and the
 * person who minted it. The same rule as who may see a key's usage (canSeeKey), so the list's
 * can_manage and the key detail page agree.
 */
export const canManageKey = canSeeKey;

/** The list row as the page gets it: plus can_manage, so it hides what the viewer can't do. */
export const withCanManage = (req, rows) => (rows ?? []).map((k) => ({ ...k, can_manage: canManageKey(req, k) }));

/**
 * Loads an active key of this workspace and checks the requester may change it.
 * → { key } | { status: 404 | 403, error }. A read error throws.
 */
export async function keyForChange(supabase, req, id) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, scope, owner_user_id, created_by_user_id, capability')
    .eq('id', id)
    .eq('workspace_id', req.workspaceId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 404, error: 'not_found' };
  if (!canManageKey(req, data)) return { status: 403, error: 'forbidden' };
  return { key: data };
}

export const KEY_NAME_MAX = 60;

/** A key's name as stored: trimmed, 1 to 60 characters. → { name } | { error }. */
export function normalizeKeyName(raw) {
  if (typeof raw !== 'string') return { error: 'name_required' };
  const name = raw.trim();
  if (!name) return { error: 'name_required' };
  if (name.length > KEY_NAME_MAX) return { error: 'name_too_long' };
  return { name };
}

/**
 * PATCH /:id {name}. Pure over the Supabase client so tests can drive it.
 * → { status, body, audit? }; the route writes `audit` (fire-and-forget) and sends the rest.
 */
export async function renameKey(supabase, req, id, body) {
  if (!isUUID(id)) return { status: 400, body: { error: 'invalid_id' } };
  const n = normalizeKeyName(body?.name);
  if (n.error) return { status: 400, body: { error: n.error } };
  const found = await keyForChange(supabase, req, id);
  if (!found.key) return { status: found.status, body: { error: found.error } };
  const from = found.key.name;
  if (from === n.name) return { status: 200, body: { id, name: from } };

  const { data, error } = await supabase
    .from('api_keys')
    .update({ name: n.name })
    .eq('id', id)
    .eq('workspace_id', req.workspaceId)
    .is('revoked_at', null)
    .select('id, name')
    .maybeSingle();
  // Names are unique among a workspace's active keys (api_keys_workspace_name_active).
  if (error?.code === '23505') return { status: 409, body: { error: 'name_taken' } };
  if (error) throw error;
  if (!data) return { status: 404, body: { error: 'not_found' } };
  return {
    status: 200,
    body: data,
    audit: {
      action: 'apikey.renamed', target_type: 'api_key', target_id: id,
      target_workspace_id: req.workspaceId, metadata: { from, to: data.name },
    },
  };
}

/**
 * A key of this workspace in any state (revoked included), for the changes that care about its
 * state: → { key } | { status: 404 | 403, error }. A read error throws.
 */
async function anyKeyForChange(supabase, req, id) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, owner_user_id, created_by_user_id, revoked_at, expires_at')
    .eq('id', id)
    .eq('workspace_id', req.workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 404, error: 'not_found' };
  if (!canManageKey(req, data)) return { status: 403, error: 'forbidden' };
  return { key: data };
}

/** How long after a revoke it can still be undone. */
export const UNDO_REVOKE_MS = 10 * 60_000;

/**
 * POST /:id/restore: undo a revoke (E2). Only within 10 minutes of the revoke, only for a key that
 * hasn't expired meanwhile, never for a key a rotation replaced (its successor holds the name and
 * the job), and only for someone who may manage it. The API key middleware reads revoked_at on
 * every request (no cache), so the restored secret works again from the next call.
 */
export async function restoreKey(supabase, req, id, now = Date.now()) {
  if (!isUUID(id)) return { status: 400, body: { error: 'invalid_id' } };
  const found = await anyKeyForChange(supabase, req, id);
  if (!found.key) return { status: found.status, body: { error: found.error } };
  const key = found.key;
  if (!key.revoked_at) return { status: 409, body: { error: 'not_revoked' } };
  const revokedAt = Date.parse(key.revoked_at);
  if (!Number.isFinite(revokedAt) || now - revokedAt > UNDO_REVOKE_MS) {
    return { status: 409, body: { error: 'undo_window_passed' } };
  }
  if (key.expires_at && Date.parse(key.expires_at) <= now) return { status: 409, body: { error: 'key_expired' } };

  const { data: rotations, error: rotErr } = await supabase
    .from('audit_log')
    .select('id')
    .eq('action', 'apikey.rotated')
    .eq('target_workspace_id', req.workspaceId)
    .eq('metadata->>replaced', id)
    .limit(1);
  if (rotErr) throw rotErr;
  if (rotations?.length) return { status: 409, body: { error: 'key_rotated' } };

  const { data, error: updErr } = await supabase
    .from('api_keys')
    .update({ revoked_at: null })
    .eq('id', id)
    .eq('workspace_id', req.workspaceId)
    .not('revoked_at', 'is', null)
    .select('id, name, last_used_at, created_at, owner_user_id, created_by_user_id, scope, capability, expires_at')
    .maybeSingle();
  // Another active key took the name while this one was revoked.
  if (updErr?.code === '23505') return { status: 409, body: { error: 'name_taken' } };
  if (updErr) throw updErr;
  if (!data) return { status: 409, body: { error: 'not_revoked' } };
  return {
    status: 200,
    body: { ...data, can_manage: true },
    audit: {
      action: 'apikey.restored', target_type: 'api_key', target_id: id,
      target_workspace_id: req.workspaceId, metadata: { name: data.name, revoked_at: key.revoked_at },
    },
  };
}

export const EXTEND_DAYS = [30, 90, 365];
const DAY_MS = 86_400_000;

/**
 * POST /:id/extend {days: 30|90|365} (E3): expires_at = max(now, current expires_at) + days, so an
 * expired key gets a fresh window from today and a live one keeps the time it had. Not for a
 * revoked key, and not for one that never expires (there is nothing to extend).
 */
export async function extendKey(supabase, req, id, body, now = Date.now()) {
  if (!isUUID(id)) return { status: 400, body: { error: 'invalid_id' } };
  const days = Number(body?.days);
  if (!EXTEND_DAYS.includes(days)) return { status: 400, body: { error: 'invalid_days', allowed: EXTEND_DAYS } };
  const found = await anyKeyForChange(supabase, req, id);
  if (!found.key) return { status: found.status, body: { error: found.error } };
  const key = found.key;
  if (key.revoked_at) return { status: 409, body: { error: 'key_revoked' } };
  const current = key.expires_at ? Date.parse(key.expires_at) : NaN;
  if (!Number.isFinite(current)) return { status: 409, body: { error: 'no_expiry' } };
  const expiresAt = new Date(Math.max(now, current) + days * DAY_MS).toISOString();

  const { data, error } = await supabase
    .from('api_keys')
    .update({ expires_at: expiresAt })
    .eq('id', id)
    .eq('workspace_id', req.workspaceId)
    .is('revoked_at', null)
    .select('id, name, expires_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 409, body: { error: 'key_revoked' } };
  return {
    status: 200,
    body: data,
    audit: {
      action: 'apikey.extended', target_type: 'api_key', target_id: id,
      target_workspace_id: req.workspaceId,
      metadata: { name: data.name, days, from: key.expires_at, to: data.expires_at },
    },
  };
}

/** Sends a handler's { status, body, audit } and writes its audit row. */
function send(req, res, out) {
  if (out.audit) auditFromReq(req, out.audit);
  return res.status(out.status).json(out.body);
}

// GET /api/workspace/api-keys
apiKeysRouter.get('/', async (req, res) => {
  try {
    // key_prefix lets the page show "pk_3f9a1c••••" instead of a bare name. Same fallback as the
    // insert: until the hand-applied column exists, list without it rather than fail.
    const list = (columns) => getSupabaseClient()
      .from('api_keys')
      .select(columns)
      .eq('workspace_id', req.workspaceId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    const base = 'id, name, last_used_at, created_at, revoked_at, owner_user_id, created_by_user_id, scope, capability, expires_at';
    let { data, error } = await list(`${base}, key_prefix`);
    if (error && isMissingPrefixColumn(error)) ({ data, error } = await list(base));

    if (error) {
      // Table may not exist yet — return empty rather than 500
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return res.json({ api_keys: [] });
      }
      throw error;
    }
    return res.json({ api_keys: withCanManage(req, data) });
  } catch (err) {
    console.error('[GET /api/workspace/api-keys]', err);
    return res.json({ api_keys: [] });
  }
});

// POST /api/workspace/api-keys
apiKeysRouter.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });

    // A shared workspace key is admin-scoped (sees all raw). Only owners/admins
    // may mint one — otherwise a member could self-escalate to read every other
    // member's private raw content. apiKeyScopeFor also enforces this defensively.
    if (req.body?.workspace_key === true && !(req.workspaceRole === 'owner' || req.workspaceRole === 'admin')) {
      return res.status(403).json({ error: 'admin_required', detail: 'Only workspace owners or admins can create a shared workspace key.' });
    }

    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const supabase = getSupabaseClient();
    const baseName = name.trim();

    // Capability: read_only (can read/compute context, can't record/modify/send) or the
    // default read_write. Optional expiry in days → a short-lived key for an untrusted agent.
    const capability = req.body?.capability === 'read_only' ? 'read_only' : 'read_write';
    const expiresInDays = Number(req.body?.expires_in_days);
    const expiresAt = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : null;

    // The key acts AS the member who minted it: a regular member gets a
    // member-scoped key (their agent sees only their own raw + shared), an
    // owner/admin gets an admin key (sees all). Pass workspace_key:true for a
    // shared automation key not tied to a person. See PRIVACY_MODEL.md.
    const scopeFields = apiKeyScopeFor(req, { workspaceKey: req.body?.workspace_key === true });

    console.log('[API_KEYS_CREATE] workspaceId=', req.workspaceId, 'bodyWorkspaceId=', req.body?.workspace_id);

    // (workspace_id, name) is UNIQUE. If the user already has a key with this
    // name (common when re-running onboarding), pick the next free " N" suffix
    // so the create still succeeds instead of 500ing.
    let attemptName = baseName;
    let data, error;
    for (let i = 0; i < 25; i++) {
      ({ data, error } = await insertApiKey(supabase, {
        workspace_id: req.workspaceId,
        name: attemptName,
        key_hash: hashedKey,
        key_prefix: keyPrefixOf(rawKey),
        created_by_user_id: req.internalUserId ?? null,
        capability,
        expires_at: expiresAt,
        ...scopeFields,
      }, 'id, name, created_at, capability, expires_at, scope'));
      if (!error) break;
      if (error.code !== '23505') break;
      attemptName = `${baseName} ${i + 2}`;
    }

    if (error) { console.error('[API_KEYS_CREATE] supabase error:', JSON.stringify(error)); throw error; }
    auditFromReq(req, {
      action: 'apikey.created',
      target_type: 'api_key',
      target_id: data.id,
      target_workspace_id: req.workspaceId,
      metadata: { name: data.name },
    });
    // Raw key only returned once — never stored in plaintext
    return res.status(201).json({ ...data, key: rawKey });
  } catch (err) {
    if (err?.code === 'no_resolved_user') {
      return res.status(403).json({ error: 'no_resolved_user', detail: 'Could not resolve who this key would act as. Sign in again and retry.' });
    }
    console.error('[POST /api/workspace/api-keys]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});

// POST /api/workspace/api-keys/:id/rotate
// Real rotation: mint a NEW secret carrying the SAME name, scope, owner and capability,
// and revoke the old one. Returns the new key once. (The old "Rotate" button only revoked
// — it never issued a replacement, so it silently killed the key.) The active-only name
// uniqueness lets the new key reuse the name once the old is revoked.
apiKeysRouter.post('/:id/rotate', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'invalid_id' });
    const supabase = getSupabaseClient();

    const found = await keyForChange(supabase, req, id);
    if (!found.key) return res.status(found.status).json({ error: found.error });
    const old = found.key;

    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const expiresInDays = Number(req.body?.expires_in_days);
    const expiresAt = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : null;

    // Revoke the old key first to free its active name, then mint the replacement.
    await supabase.from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', old.id).eq('workspace_id', req.workspaceId);

    const { data: created, error } = await insertApiKey(supabase, {
      workspace_id: req.workspaceId,
      name: old.name,
      key_hash: hashedKey,
      key_prefix: keyPrefixOf(rawKey),
      created_by_user_id: req.internalUserId ?? null,
      owner_user_id: old.owner_user_id,
      scope: old.scope,
      capability: old.capability || 'read_write',
      expires_at: expiresAt,
    }, 'id, name, created_at, capability, expires_at, scope');

    if (error) {
      // Roll back the revoke so the caller isn't left with no working key.
      await supabase.from('api_keys').update({ revoked_at: null }).eq('id', old.id).eq('workspace_id', req.workspaceId);
      console.error('[API_KEYS_ROTATE] insert failed:', error.message);
      return res.status(500).json({ error: 'rotate_failed', detail: error.message });
    }

    auditFromReq(req, {
      action: 'apikey.rotated', target_type: 'api_key', target_id: created.id,
      target_workspace_id: req.workspaceId, metadata: { name: created.name, replaced: old.id },
    });
    return res.status(201).json({ ...created, key: rawKey });
  } catch (err) {
    console.error('[POST /api/workspace/api-keys/:id/rotate]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/workspace/api-keys/:id
apiKeysRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'invalid_id' });

    const supabase = getSupabaseClient();
    const found = await keyForChange(supabase, req, id);
    if (!found.key) return res.status(found.status).json({ error: found.error });

    const { data: revoked, error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('workspace_id', req.workspaceId)
      .select('name')
      .maybeSingle();
    if (error) throw error;

    auditFromReq(req, {
      action: 'apikey.revoked',
      target_type: 'api_key',
      target_id: id,
      target_workspace_id: req.workspaceId,
      metadata: { name: revoked?.name ?? null },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/workspace/api-keys/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/workspace/api-keys/:id  {name}
apiKeysRouter.patch('/:id', async (req, res) => {
  try {
    return send(req, res, await renameKey(getSupabaseClient(), req, req.params.id, req.body));
  } catch (err) {
    console.error('[PATCH /api/workspace/api-keys/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/workspace/api-keys/:id/restore — undo a revoke within 10 minutes
apiKeysRouter.post('/:id/restore', async (req, res) => {
  try {
    return send(req, res, await restoreKey(getSupabaseClient(), req, req.params.id));
  } catch (err) {
    console.error('[POST /api/workspace/api-keys/:id/restore]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/workspace/api-keys/:id/extend  {days: 30|90|365}
apiKeysRouter.post('/:id/extend', async (req, res) => {
  try {
    return send(req, res, await extendKey(getSupabaseClient(), req, req.params.id, req.body));
  } catch (err) {
    console.error('[POST /api/workspace/api-keys/:id/extend]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
