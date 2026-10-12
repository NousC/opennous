import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const integrationsRouter = Router();

// GET /api/workflow-providers
integrationsRouter.get('/workflow-providers', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { category, search } = req.query;

    let query = supabase.from('workflow_providers').select('*').eq('is_active', true).order('display_name');
    if (category) query = query.eq('category', category);
    if (search) query = query.or(`display_name.ilike.%${search}%,description.ilike.%${search}%`);

    const { data: providers, error } = await query;
    if (error) throw error;
    return res.json({ providers });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workflow-providers/connections
integrationsRouter.get('/workflow-providers/connections', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, provider_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    let query = supabase.from('workflow_provider_connections')
      .select('id, workspace_id, provider_id, name, created_at, last_used_at, is_verified, last_test_at, provider:workflow_providers(id, name, display_name, logo_url, auth_type, category)')
      .eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (provider_id) query = query.eq('provider_id', provider_id);

    const { data: connections, error } = await query;
    if (error) throw error;
    return res.json({ connections: connections || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
