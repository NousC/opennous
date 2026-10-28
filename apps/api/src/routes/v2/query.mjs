import { roleTags, THEME_ROLES, objectionReaches } from '../../lib/roleProfiles.mjs';
import { Router } from 'express';
import { getSupabaseClient, runQuery, readContextFromReq, resolveFocus, listFlags } from '@nous/core';
import { readIcp } from '../../lib/icp.mjs';
import { getVisibilityScope } from '../../lib/visibility.mjs';
import { expandRoles } from '../../lib/agentDirectives.mjs';
import { getMeetings } from '../../lib/calendar.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const queryV2Router = Router();

// ── Role reporting (rides on query; scope.reporting = "company" | "role") ─────────
// The same distilled objection handlers + insight themes the Reporting page shows,
// routed SERVER-SIDE to the caller's GTM role so a rep gets their seat's view and the
// founder gets the whole-company lens. No 8th primitive — reporting rides on query.
// Roles come from the canonical table (lib/roleProfiles.mjs). This used to be a hand-kept
// copy of the frontend's, with a "keep the two in sync" comment on it — which is a second
// source of truth with a sticky note attached. Both now read the same file.
const ROLE_TAGS = roleTags();
const TECH_RX = /\b(integrat|api|feature|export|import|bulk|capabilit|technical|platform|limit|sso|security|compliance|data|automat|workflow|migrat|report|dashboard|scal)\b/i;
const MSG_RX  = /\b(differen|competitor|position|messag|brand|understand|unclear|value|pric|expensiv|cost|market)\b/i;

// Both filters now read the canonical table, so adding a role is ONE edit in one file rather
// than a hardcoded list here that a new role silently falls out of — which would have shown
// a CRO an empty report while looking like it worked.
function objectionRelevant(h, role) {
  return objectionReaches(role, `${h.title || ''} ${h.objection_summary || ''}`, { TECH_RX, MSG_RX });
}
function themeRelevant(category, role) {
  const roles = THEME_ROLES[String(category || '').toLowerCase()] ?? ['account_executive', 'founder'];
  return roles.includes(role) || role === 'founder';
}

async function runReporting(supabase, workspaceId, req, { reporting, role }) {
  const isAdmin = (req.viewerScope || 'admin') === 'admin';
  // The caller's own GTM role(s) — a member key is scoped to these; it can never widen
  // to the company view or a role it doesn't hold.
  let callerRoles = [];
  if (req.memberUserId) {
    // GTM roles live on workspace_members (per workspace + member), not users.
    const { data: wm } = await supabase.from('workspace_members')
      .select('job_roles, job_role').eq('workspace_id', workspaceId).eq('user_id', req.memberUserId).maybeSingle();
    // 'ambassador' is one role meaning every lens — see agentDirectives.expandRoles.
    callerRoles = expandRoles(Array.isArray(wm?.job_roles) && wm.job_roles.length ? wm.job_roles : (wm?.job_role ? [wm.job_role] : []));
  }
  const isFounder = isAdmin || callerRoles.includes('founder');

  let targetRole, effReporting = 'role';
  if (reporting === 'company' && isFounder) {
    targetRole = 'founder';
    effReporting = 'company';
  } else {
    const requested = role && ROLE_TAGS[role] ? role : null;
    targetRole = isFounder
      ? (requested || callerRoles[0] || 'account_executive')
      : ((requested && callerRoles.includes(requested)) ? requested : (callerRoles[0] || 'account_executive'));
  }
  const tag = ROLE_TAGS[targetRole] || ROLE_TAGS.account_executive;

  // Objection handlers (deal blockers) ranked by how many accounts raised each, routed to the role.
  const { data: hData } = await supabase.from('objection_handlers')
    .select('id, title, objection_summary, account_count')
    .eq('workspace_id', workspaceId)
    .order('account_count', { ascending: false })
    .limit(40);
  const handlers = (hData || [])
    .filter((h) => objectionRelevant(h, targetRole))
    .slice(0, 12)
    .map((h) => ({ id: h.id, title: h.title, objection_summary: h.objection_summary || null, account_count: h.account_count || 0, framing: tag.objectionTag }));

  // Distilled themes, routed to the role.
  const { data: tData } = await supabase.from('insight_themes')
    .select('title, takeaway, category, rank')
    .eq('workspace_id', workspaceId)
    .eq('source', 'external')
    .order('rank', { ascending: true });
  const themes = (tData || [])
    .filter((t) => themeRelevant(t.category, targetRole))
    .slice(0, 12)
    .map((t) => ({ title: t.title, takeaway: t.takeaway || null, category: t.category || null, framing: tag.signalTag }));

  return { reporting: effReporting, role: targetRole, role_label: tag.label, handlers, themes };
}

// ── Daily worklist (rides on query; scope.attention = "mine") ─────────────────────
// The engine-curated Studio worklist the /studio homepage shows — upcoming meetings,
// the follow-ups you owe, and the accounts to focus on (open attention flags) — scoped
// to the caller: a MEMBER key sees only its owned book; an ADMIN/founder key (no bound
// user) sees the whole workspace. Ownership = relationship_owner.primary === the caller.
// Ported from apps/frontend/src/pages/Focus.tsx + /api/tasks — keep the three in sync.
async function runWorklist(supabase, workspaceId, req) {
  const me = req.memberUserId ?? null;

  // 1. Upcoming meetings (next 14 days) — same source the Studio page uses.
  let meetings = [];
  try {
    meetings = ((await getMeetings(supabase, workspaceId, { fromDays: 0, toDays: 14, upcomingOnly: true })) || [])
      .filter((m) => m.status !== 'cancelled')
      .map((m) => ({ entity_id: m.entity_id, account: m.name || m.company || null, when: m.when ?? m.observed_at ?? null }));
  } catch (e) { console.error('[worklist] meetings:', e.message); }

  // 2. Open action items — the follow-ups you owe (action_item.* claims).
  const { data: aiRows } = await supabase.from('claims')
    .select('entity_id, value').eq('workspace_id', workspaceId)
    .like('property', 'action_item.%').is('invalid_at', null).limit(200);
  let followUps = (aiRows || [])
    .map((r) => ({ entity_id: r.entity_id, title: r.value?.title || null, due: r.value?.due_phrase || null, status: r.value?.status || 'open' }))
    .filter((i) => i.title && i.status === 'open');

  // 3. Accounts to focus on — the engine's open attention flags.
  let flags = [];
  try {
    flags = ((await listFlags(supabase, workspaceId, { statuses: ['open'], limit: 60 })) || [])
      .map((f) => ({ entity_id: f.entity_id, flag_type: f.flag_type, reason: f.reason || null }));
  } catch (e) { console.error('[worklist] flags:', e.message); }

  // Personal scope — a member sees only accounts they own; an admin/founder key sees all.
  if (me) {
    const ids = [...new Set([...meetings, ...followUps, ...flags].map((x) => x.entity_id).filter(Boolean))];
    const owned = new Set();
    if (ids.length) {
      const { data: oc } = await supabase.from('claims').select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('property', 'relationship_owner').in('entity_id', ids);
      for (const c of oc || []) if (c.value?.primary === me) owned.add(c.entity_id);
    }
    meetings  = meetings.filter((m) => owned.has(m.entity_id));
    followUps = followUps.filter((i) => owned.has(i.entity_id));
    flags     = flags.filter((f) => owned.has(f.entity_id));
  }

  // Name the accounts behind the follow-ups + flags (meetings already carry a name).
  const nameIds = [...new Set([...followUps, ...flags].map((x) => x.entity_id).filter(Boolean))];
  if (nameIds.length) {
    const { data: nameClaims } = await supabase.from('claims')
      .select('entity_id, property, value').eq('workspace_id', workspaceId)
      .in('entity_id', nameIds).in('property', ['first_name', 'last_name', 'name', 'company']);
    const byId = new Map();
    for (const c of nameClaims || []) { const m = byId.get(c.entity_id) ?? {}; m[c.property] = c.value; byId.set(c.entity_id, m); }
    const nameOf = (id) => { const m = byId.get(id) ?? {}; return (m.name && String(m.name)) || [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || (m.company && String(m.company)) || null; };
    followUps.forEach((i) => { i.account = nameOf(i.entity_id); });
    flags.forEach((f) => { f.account = nameOf(f.entity_id); });
  }

  return {
    attention: 'mine',
    scope: me ? 'member' : 'workspace',
    upcoming_meetings: meetings.slice(0, 20),
    follow_ups: followUps.slice(0, 30),
    accounts_to_focus: flags.slice(0, 20),
  };
}

// POST /v2/query — retrieve and summarise a corpus of observations.
// Body: {
//   scope:    { kind?, property?, source?, entity_id?, since_days?, limit? },
//   without?: { ...same shape as scope },        // entities IN scope minus entities IN without
//   return?:  'observations' | 'entities',       // default 'observations'
//   question?: string,                            // analytical question — echoed back; enables semantic mode
//   budget_tokens?: number
// }
// The API retrieves + compacts; the agent does the pattern-finding.
//
// Use cases the new params unlock:
//   • "Hottest leads"             — return:'entities' over recent replies
//   • "Didn't reply in 5 days"    — without: replies in same 5d window
//   • "Cooled in 5 days"          — without: any activity in last 5d
//   • "Funnel by stage"           — scope.kind='state', property='stage' → rollups.by_value
//   • "Which accounts want off X" — scope.facts:true + question → hybrid search (GET-1056) over the
//                                   FACTS corpus (note.* claims); return:'entities' = best
//                                   matching fact per account. Per-account facts come back
//                                   inline with get_account, so this is for cross-account lookup.
queryV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    let { scope = {}, without, return: returnMode, question } = req.body;

    // Reporting rides on query: scope.reporting = "company" | "role" returns the
    // already-distilled themes/handlers routed to the caller's role, server-side.
    if (scope?.reporting) {
      return res.json(await runReporting(supabase, req.workspaceId, req, { reporting: scope.reporting, role: scope.role }));
    }

    // The ICP rides on query the same way, for the same reason there is no 8th primitive.
    // scope.foundation = 'icp' returns the definition itself — what we are scoring against —
    // rather than another number derived from it. The plugin could set_icp and read scores and
    // never read the standard, which left a skill unable to explain or argue with its own
    // judgement.
    if (scope?.foundation === 'icp') {
      const icp = await readIcp(supabase, req.workspaceId);
      if (!icp) {
        return res.json({
          foundation: 'icp', defined: false,
          message: 'No ICP defined for this workspace yet. set_icp establishes one — see the onboard skill.',
        });
      }
      return res.json({ foundation: 'icp', defined: true, ...icp });
    }

    // The daily worklist rides on query too: scope.attention = "mine" returns the
    // engine-curated Studio worklist (meetings, follow-ups, accounts to focus on),
    // scoped to the caller. Powers the `focus` skill.
    if (scope?.attention) {
      return res.json(await runWorklist(supabase, req.workspaceId, req));
    }

    // scope.entity_id is documented as a pre-resolved id, but callers (and agents)
    // routinely pass a bare name. Resolve it here so a name scopes the query instead
    // of silently matching nothing. An ambiguous name returns its candidates rather
    // than picking one arbitrarily.
    if (scope?.entity_id && !UUID_RE.test(String(scope.entity_id))) {
      const r = await resolveFocus(supabase, req.workspaceId, String(scope.entity_id)).catch(() => null);
      if (r?.status === 'ambiguous') {
        return res.json({ status: 'ambiguous', candidates: r.candidates, question: question ?? null });
      }
      if (r?.entity_id) scope = { ...scope, entity_id: r.entity_id };
    }

    // Open workspace (default) → claims are team-readable. Honour an explicit close by
    // passing the resolved flag into the read context.
    const { open } = await getVisibilityScope(supabase, req.workspaceId, req);
    req.openVisibility = open;

    const result = await runQuery(supabase, req.workspaceId, scope, question, {
      return: returnMode,
      without,
      excludeInternal: true,
    }, readContextFromReq(req));
    return res.json({ ...result, question: question ?? null });
  } catch (err) {
    console.error('[POST /v2/query]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
