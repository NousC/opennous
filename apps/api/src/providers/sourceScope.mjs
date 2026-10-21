/**
 * Whose source is it? One rule, every caller (GET-232).
 *
 * A PERSONAL source belongs to one person: their mailbox, their calendar, their LinkedIn,
 * their booking page, their note-taker. Only its owner sees it, and each member connects
 * their own. A COMPANY source is one connection for the whole team — the CRM, the outbound
 * tool, Slack, billing. Everyone sees it; owners and admins connect and disconnect it.
 *
 * Before this, Settings → Sources listed every connection in the workspace, so a founder
 * saw "Gmail: Connected" when the only Gmail on the workspace was his co-founder's.
 *
 * The rule is per TOOL and fixed. Nobody chooses it when they connect.
 *
 * Scope decides who sees and manages a CONNECTION. It does not decide who sees the data:
 * facts from a personal mailbox still build the shared account record, under the existing
 * per-member message redaction.
 */

import { isWorkspaceAdmin } from '../lib/authz.mjs';

// Personal by name. Note-takers are personal by CATEGORY (every `meetings` provider), so a
// new one lands on the right side without an edit here.
const PERSONAL_BY_NAME = new Set(['gmail_oauth', 'google_calendar', 'smtp', 'linkedin', 'outlook', 'slack_personal']);
const PERSONAL_CATEGORIES = new Set(['meetings']);
// Company by name, ahead of the category. Fellow is a note-taker, but one Super Admin key
// reads every meeting in the Fellow workspace and a workspace-scoped webhook receives every
// call, so it is one connection for the whole team (product decision, 2026-09-15). RingCentral is the
// company phone system: one service-user JWT reads the whole company call log (GET-289).
const COMPANY_BY_NAME = new Set(['fellow', 'ringcentral']);

/** 'personal' | 'company' for a provider (name + catalogue category). */
export function sourceScope(providerName, category = null) {
  const name = String(providerName || '').toLowerCase();
  if (COMPANY_BY_NAME.has(name)) return 'company';
  if (PERSONAL_BY_NAME.has(name)) return 'personal';
  if (category && PERSONAL_CATEGORIES.has(String(category).toLowerCase())) return 'personal';
  return 'company';
}

/**
 * Can this viewer SEE a connection? Company: any member (the caller has already checked
 * membership). Personal: its owner. A personal connection with no recorded owner predates
 * owners; admins see it so it can be cleaned up.
 */
export function canSeeConnection({ scope, ownerUserId, viewerUserId, viewerIsAdmin }) {
  if (scope === 'company') return true;
  if (ownerUserId) return ownerUserId === viewerUserId;
  return !!viewerIsAdmin;
}

/** Can this viewer CHANGE a connection (update, test, disconnect)? */
export function canManageConnection({ scope, ownerUserId, viewerUserId, viewerIsAdmin }) {
  if (scope === 'company') return !!viewerIsAdmin;
  if (ownerUserId) return ownerUserId === viewerUserId;
  return !!viewerIsAdmin;
}

/**
 * Gate for CONNECTING a provider: a company source needs an owner/admin; anyone connects
 * their own personal source. Returns null when allowed, else a 403 body.
 */
export async function connectForbidden(supabase, { workspaceId, userId, providerName, category = null }) {
  if (sourceScope(providerName, category) === 'personal') return null;
  if (await isWorkspaceAdmin(supabase, workspaceId, userId)) return null;
  return {
    error: 'company_source_admin_only',
    message: 'Company sources are shared by the whole team, so only workspace owners and admins can connect or change them.',
  };
}
