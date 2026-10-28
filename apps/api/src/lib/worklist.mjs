// The daily worklist: upcoming meetings, the follow-ups owed and the accounts to focus on (open
// attention flags). Read once per workspace, then scoped to one person by relationship_owner.
// Used by POST /v2/query (scope.attention = "mine") and by the daily digest email.

import { listFlags } from '@nous/core';
import { getMeetings } from './calendar.mjs';

/** Every name we know for these entities: a person's full name, else the name, else the company. */
export async function entityNames(supabase, workspaceId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { data: rows } = await supabase.from('claims')
    .select('entity_id, property, value').eq('workspace_id', workspaceId)
    .in('entity_id', ids).in('property', ['first_name', 'last_name', 'name', 'company']);
  const byId = new Map();
  for (const c of rows || []) { const m = byId.get(c.entity_id) ?? {}; m[c.property] = c.value; byId.set(c.entity_id, m); }
  for (const [id, m] of byId) {
    const name = (m.name && String(m.name)) || [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || (m.company && String(m.company)) || null;
    if (name) out.set(id, name);
  }
  return out;
}

/** entity_id → the user who owns it (relationship_owner.primary), for these entities. */
export async function ownersOf(supabase, workspaceId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { data: rows } = await supabase.from('claims').select('entity_id, value')
    .eq('workspace_id', workspaceId).eq('property', 'relationship_owner').in('entity_id', ids);
  for (const c of rows || []) if (c.value?.primary) out.set(c.entity_id, c.value.primary);
  return out;
}

/**
 * The whole workspace's worklist, named, with each entity's owner. `meetingDays`: how far ahead
 * meetings are read (0 = today only).
 */
export async function loadWorklist(supabase, workspaceId, { meetingDays = 14 } = {}) {
  // 1. Upcoming meetings — same source the Studio page uses.
  let meetings = [];
  try {
    meetings = ((await getMeetings(supabase, workspaceId, { fromDays: 0, toDays: meetingDays, upcomingOnly: true })) || [])
      .filter((m) => m.status !== 'cancelled')
      .map((m) => ({ entity_id: m.entity_id, account: m.name || m.company || null, when: m.when ?? m.observed_at ?? null }));
  } catch (e) { console.error('[worklist] meetings:', e.message); }

  // 2. Open action items — the follow-ups owed (action_item.* claims).
  const { data: aiRows } = await supabase.from('claims')
    .select('entity_id, value').eq('workspace_id', workspaceId)
    .like('property', 'action_item.%').is('invalid_at', null).limit(200);
  const followUps = (aiRows || [])
    .map((r) => ({ entity_id: r.entity_id, title: r.value?.title || null, due: r.value?.due_phrase || null, status: r.value?.status || 'open' }))
    .filter((i) => i.title && i.status === 'open');

  // 3. Accounts to focus on — the engine's open attention flags.
  let flags = [];
  try {
    flags = ((await listFlags(supabase, workspaceId, { statuses: ['open'], limit: 60 })) || [])
      .map((f) => ({ entity_id: f.entity_id, flag_type: f.flag_type, reason: f.reason || null }));
  } catch (e) { console.error('[worklist] flags:', e.message); }

  const ids = [...new Set([...meetings, ...followUps, ...flags].map((x) => x.entity_id).filter(Boolean))];
  const owners = await ownersOf(supabase, workspaceId, ids);

  // Name the accounts behind the follow-ups + flags (meetings already carry a name).
  const names = await entityNames(supabase, workspaceId, [...new Set([...followUps, ...flags].map((x) => x.entity_id).filter(Boolean))]);
  followUps.forEach((i) => { i.account = names.get(i.entity_id) ?? null; });
  flags.forEach((f) => { f.account = names.get(f.entity_id) ?? null; });

  return { meetings, followUps, flags, owners };
}

/** One person's share: only what they own. `me` null = the whole workspace. Pure. */
export function scopeWorklist(w, me) {
  if (!me) return { meetings: w.meetings, followUps: w.followUps, flags: w.flags };
  const mine = (x) => w.owners.get(x.entity_id) === me;
  return { meetings: w.meetings.filter(mine), followUps: w.followUps.filter(mine), flags: w.flags.filter(mine) };
}
