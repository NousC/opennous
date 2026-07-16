import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';

export const usersRouter = Router();

// PATCH /api/users/me
usersRouter.patch('/me', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { name, profile_picture_url, first_name, last_name, how_heard_about_us, use_cases, product_email_consent } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    const updateData = {};
    if (name !== undefined) {
      if (!name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      updateData.name = name.trim();
    }
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url || null;
    if (first_name !== undefined) updateData.first_name = first_name?.trim() || null;
    if (last_name !== undefined) updateData.last_name = last_name?.trim() || null;
    if (how_heard_about_us !== undefined) {
      const valid = ['youtube', 'linkedin', 'x', 'google', 'referral', 'email', 'other', null];
      if (!valid.includes(how_heard_about_us)) return res.status(400).json({ error: 'invalid how_heard_about_us value' });
      updateData.how_heard_about_us = how_heard_about_us;
    }
    if (use_cases !== undefined) {
      if (!Array.isArray(use_cases)) return res.status(400).json({ error: 'use_cases must be an array' });
      updateData.use_cases = use_cases;
    }
    if (product_email_consent !== undefined) updateData.product_email_consent = Boolean(product_email_consent);
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'no_updates_provided' });

    const { data: updatedUser, error } = await supabase.from('users').update(updateData).eq('id', user.id).select().single();
    if (error) throw error;
    return res.json({ user: updatedUser });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/users/me/default-signature
usersRouter.post('/me/default-signature', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { default_signature, default_signature_type } = req.body;
    const { user } = await ensureUserAndTeam(req.user);
    if (!default_signature) return res.status(400).json({ error: 'default_signature is required' });

    const { data: updatedUser, error } = await supabase.from('users')
      .update({ default_signature, default_signature_type: default_signature_type || 'type' })
      .eq('id', user.id).select().single();
    if (error) throw error;
    return res.json({ user: updatedUser });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/users/me/export (GDPR)
usersRouter.get('/me/export', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { user } = await ensureUserAndTeam(req.user);

    const exportData = { export_date: new Date().toISOString(), user_id: user.id, personal_data: {} };

    const { data: userData } = await supabase.from('users').select('id, email, name, profile_picture_url, created_at').eq('id', user.id).single();
    exportData.personal_data = userData || {};

    res.setHeader('Content-Disposition', `attachment; filename="nous-export-${user.id}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
