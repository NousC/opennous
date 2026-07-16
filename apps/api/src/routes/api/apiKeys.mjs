import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient, isUUID } from '@nous/core';
import { apiKeyScopeFor } from '../../lib/apiKeyScope.mjs';

export const apiKeysRouter = Router();

// GET /api/workspace/api-keys
apiKeysRouter.get('/', async (req, res) => {
  try {
    const { data, error } = await getSupabaseClient()
      .from('api_keys')
      .select('id, name, last_used_at, created_at, revoked_at, owner_user_id, scope')
      .eq('workspace_id', req.workspaceId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      // Table may not exist yet — return empty rather than 500
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return res.json({ api_keys: [] });
      }
      throw error;
    }
    return res.json({ api_keys: data || [] });
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

    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const supabase = getSupabaseClient();
    const baseName = name.trim();

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
      ({ data, error } = await supabase
        .from('api_keys')
        .insert({
          workspace_id: req.workspaceId,
          name: attemptName,
          key_hash: hashedKey,
          created_by_user_id: req.internalUserId ?? null,
          ...scopeFields,
        })
        .select('id, name, created_at')
        .single());
      if (!error) break;
      if (error.code !== '23505') break;
      attemptName = `${baseName} ${i + 2}`;
    }

    if (error) { console.error('[API_KEYS_CREATE] supabase error:', JSON.stringify(error)); throw error; }
    // Raw key only returned once — never stored in plaintext
    return res.status(201).json({ ...data, key: rawKey });
  } catch (err) {
    console.error('[POST /api/workspace/api-keys]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});

// DELETE /api/workspace/api-keys/:id
apiKeysRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'invalid_id' });

    await getSupabaseClient()
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('workspace_id', req.workspaceId);

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/workspace/api-keys/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
