/**
 * Admin Access - Check admin status and provide Pro plan access
 */

// Operator email allowlists are sourced from the environment and are EMPTY by
// default. This is the deliberate, open-source-safe lock that keeps self-hosters
// out of the platform-operator surface (CMS, Roadmap, Changelog, Updates,
// Resources, VIP plan access): with no env set, no account is ever an operator,
// regardless of any users.is_admin flag in a self-hosted database. Only the Nous
// Cloud deployment sets ADMIN_EMAILS / VIP_EMAILS in its own environment.
//
// Format: comma-separated, e.g. ADMIN_EMAILS=founder@example.com,ops@example.com
function parseEmailList(raw) {
  if (!raw) return [];
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

// VIP emails always get full Consultancies / Pro plan access.
const VIP_EMAILS = parseEmailList(process.env.VIP_EMAILS);

// Admin emails are the only accounts allowed into the platform-operator surface.
const ADMIN_EMAILS = parseEmailList(process.env.ADMIN_EMAILS);

/**
 * Check if user email is in the VIP list
 * @param {string} email - User email address
 * @returns {boolean} True if email is in VIP list
 */
export function isVIPEmail(email) {
  if (!email) return false;
  return VIP_EMAILS.includes(email.toLowerCase());
}

/**
 * Check if user email is on the platform-operator (admin) allowlist.
 * Empty by default — self-hosted deployments set no ADMIN_EMAILS, so this
 * returns false for everyone and the admin surface stays locked.
 * @param {string} email - User email address
 * @returns {boolean} True if email is an allowlisted operator
 */
export function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Check if user is admin (matches server.mjs pattern)
 * @param {Object} user - User object with id
 * @param {Object} supabase - Supabase client
 * @returns {Promise<boolean>} True if user is admin
 */
export async function checkAdmin(user, supabase) {
  if (!supabase) {
    console.error('[ADMIN_ACCESS] checkAdmin called without supabase client');
    return false;
  }
  if (!user || !user.id) {
    return false;
  }

  try {
    // Check users.is_admin field (matches server.mjs checkAdmin function)
    const { data: userData, error } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', user.id)
      .single();

    if (error || !userData) {
      return false;
    }
    
    return userData.is_admin === true;
  } catch (error) {
    console.error('[ADMIN_ACCESS] Error checking admin:', error);
    return false;
  }
}

/**
 * Check if user has VIP access
 * @param {Object} user - User object with id
 * @param {Object} supabase - Supabase client
 * @returns {Promise<boolean>} True if user is VIP
 */
export async function checkVIPAccess(user, supabase) {
  if (!supabase) {
    console.error('[ADMIN_ACCESS] checkVIPAccess called without supabase client');
    return false;
  }
  if (!user || !user.id) {
    return false;
  }

  try {
    // Check users.is_vip field
    const { data: userData, error } = await supabase
      .from('users')
      .select('is_vip')
      .eq('id', user.id)
      .single();

    if (error || !userData) {
      return false;
    }
    
    return userData.is_vip === true;
  } catch (error) {
    console.error('[ADMIN_ACCESS] Error checking VIP access:', error);
    return false;
  }
}

/**
 * Check if user should get Pro plan access (admin in team or VIP)
 * @param {Object} user - User object with id
 * @param {string} teamId - Team ID
 * @param {Object} supabase - Supabase client
 * @returns {Promise<boolean>} True if user is admin in team or VIP
 */
export async function checkAdminScaleAccess(user, teamId, supabase) {
  if (!user || !user.id || !teamId) {
    return false;
  }

  try {
    // Check if user email is in hardcoded VIP list (for specific admin accounts)
    if (user.email && isVIPEmail(user.email)) {
      console.log('[ADMIN_ACCESS] VIP email detected:', user.email);
      return true;
    }

    // Check admin + VIP status and team membership in parallel (single query for user flags)
    const [userFlagsResult, teamMemberResult] = await Promise.all([
      supabase.from('users').select('is_admin, is_vip').eq('id', user.id).single(),
      supabase.from('team_members').select('role').eq('team_id', teamId).eq('user_id', user.id).maybeSingle(),
    ]);

    // Check admin/VIP flags
    if (userFlagsResult.data) {
      if (userFlagsResult.data.is_admin === true) return true;
      if (userFlagsResult.data.is_vip === true) return true;
    }

    // Check team membership role
    const { data: teamMember, error } = teamMemberResult;
    if (error && error.code !== 'PGRST116') {
      console.error('[ADMIN_ACCESS] Error checking team membership:', error);
      return false;
    }

    // Only explicit admin/owner roles get Pro access (NOT founders - they get Standard plan)
    return teamMember && ['owner', 'admin'].includes(teamMember.role);
  } catch (error) {
    console.error('[ADMIN_ACCESS] Error checking admin scale access:', error);
    return false;
  }
}

