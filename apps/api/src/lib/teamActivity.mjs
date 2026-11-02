// Settings > Team (GET-1120): for each person, which agents they have connected and when those agents
// last did anything, from api_request_log (one row per API-key call, GET-623). Usage only: who, which
// client, when and how much. Never what was asked, never an IP. A workspace key has no person, so it
// counts for no one here.
import { readableContextFiles } from '@nous/core';
import { loadCalls } from './apiActivity.mjs';

const DAY = 86_400_000;
const WINDOW = 30 * DAY;
const SAMPLE = 500;   // a key's latest calls: enough to name the agents behind it

/** An agent's name from its client string: "claude-code/2.1.0" -> "claude-code". Pure. */
export const agentOf = (client) => String(client ?? '').split('/')[0].trim();

/**
 * One person's row. `rows`: [{ at, client }], any order, over any of their keys. Pure.
 * -> { last_active_at, calls_7d, agents: [{ name, last_at }] }, agents newest first.
 */
export function summarize(rows, now) {
  const latest = new Map();
  let last = null, week = 0;
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    if (now - at <= 7 * DAY) week++;
    if (last === null || at > last) last = at;
    const name = agentOf(r.client);
    if (name && at > (latest.get(name) ?? 0)) latest.set(name, at);
  }
  return {
    last_active_at: last === null ? null : new Date(last).toISOString(),
    calls_7d: week,
    agents: [...latest].sort((a, b) => b[1] - a[1]).map(([name, at]) => ({ name, last_at: new Date(at).toISOString() })),
  };
}

/** -> { members: { [userId]: summary } }. A person with no key or no calls isn't in it. */
export async function loadTeamActivity(sb, { workspaceId, now = Date.now() }) {
  const { data: keys, error } = await sb.from('api_keys').select('id, owner_user_id').eq('workspace_id', workspaceId).not('owner_user_id', 'is', null);
  if (error) throw error;
  const since = new Date(now - WINDOW).toISOString();
  const byPerson = new Map();
  await Promise.all((keys ?? []).map(async (k) => {
    const { data, error: e } = await sb.from('api_request_log').select('at, client').eq('workspace_id', workspaceId).eq('api_key_id', k.id)
      .gte('at', since).order('at', { ascending: false }).limit(SAMPLE);
    if (e) throw e;
    byPerson.set(k.owner_user_id, [...(byPerson.get(k.owner_user_id) ?? []), ...(data ?? [])]);
  }));
  return { members: Object.fromEntries([...byPerson].filter(([, rows]) => rows.length).map(([id, rows]) => [id, summarize(rows, now)])) };
}

/** What someone's agents do most: routes by calls this period, biggest first. Pure. */
export function topTools(rows, limit = 6) {
  const counts = new Map();
  for (const r of rows) if (r.route) counts.set(r.route, (counts.get(r.route) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([route, calls]) => ({ route, calls }));
}

/** The accounts and people their agents worked on, newest first, once each. Pure. */
export function touched(calls, limit = 8) {
  const seen = new Map();
  for (const c of calls) if (c.about?.id && !seen.has(c.about.id)) seen.set(c.about.id, { ...c.about, at: c.at });
  return [...seen.values()].slice(0, limit);
}

/**
 * One person in depth (GET-1120), for an admin: their keys, agents, what the agents did and worked
 * on, and the documents this person can read. Usage only, no content. -> null when not a member.
 */
export async function loadTeamMember(sb, { workspaceId, userId, now = Date.now() }) {
  const { data: seat } = await sb.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (!seat) return null;
  const { data: keys, error } = await sb.from('api_keys').select('id, name, created_at, revoked_at, expires_at, last_used_at').eq('workspace_id', workspaceId).eq('owner_user_id', userId);
  if (error) throw error;
  const since = new Date(now - WINDOW).toISOString();
  const rows = (await Promise.all((keys ?? []).map(async (k) => {
    const { data, error: e } = await sb.from('api_request_log').select('at, client, route').eq('workspace_id', workspaceId).eq('api_key_id', k.id)
      .gte('at', since).order('at', { ascending: false }).limit(SAMPLE);
    if (e) throw e;
    return data ?? [];
  }))).flat();
  const pages = await Promise.all((keys ?? []).map(k => loadCalls(sb, { workspaceId, window: '30d', limit: 20, keyId: k.id, now })));
  const calls = pages.flatMap(p => p.calls).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
  const admin = seat.role === 'owner' || seat.role === 'admin';
  const documents = (await readableContextFiles(sb, workspaceId, { userId, admin })).filter(f => f.folder)
    .map(f => ({ id: f.id, title: f.title, folder: f.folder, shared: f.visibility, updated_at: f.updated_at }));
  return {
    ...summarize(rows, now), calls_30d: rows.length, tools: topTools(rows), accounts: touched(calls), calls, documents,
    keys: (keys ?? []).map(k => ({ id: k.id, name: k.name, created_at: k.created_at, revoked: !!k.revoked_at, expires_at: k.expires_at ?? null })),
  };
}
