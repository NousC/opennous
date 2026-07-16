import { getSupabaseClient } from '@nous/core';
import { isAdminEmail } from '../utils/adminAccess.js';

/**
 * Middleware to verify admin access.
 * Requires verifySupabaseAuth to run first (attaches req.user).
 */
export async function requireAdmin(req, res, next) {
  try {
    const supabase = getSupabaseClient();
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: 'auth_required' });
    }

    // Deliberate, open-source-safe lock: the platform-operator surface is gated
    // on an env allowlist (ADMIN_EMAILS) that is EMPTY by default. Self-hosted
    // deployments set no ADMIN_EMAILS, so this denies everyone — no users.is_admin
    // flag in a self-hosted database can unlock it. Only Nous Cloud sets it.
    if (!isAdminEmail(user.email)) {
      return res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
    }

    // Defense in depth: also require the users.is_admin field. req.user is the
    // Supabase auth user, whose
    // id is the auth UUID — that lives in users.supabase_user_id, NOT users.id.
    // verifySupabaseAuth already resolved the internal users.id into
    // req.internalUserId; use that for the lookup.
    const { data: userData, error } = await supabase
      .from('users')
      .select('is_admin, id, email, name, team_id')
      .eq('id', req.internalUserId || user.id)
      .single();

    if (error || !userData || !userData.is_admin) {
      return res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
    }

    req.adminUser = userData;
    next();
  } catch (err) {
    console.error('[REQUIRE_ADMIN]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
