// The user's meetings, and who each one is actually with.
//
// Meetings live as observations dated at the meeting time, hung off the person
// they're with. That makes "who is tomorrow's call with" a range query — which
// is what lets the agent resolve "Ottoline" itself instead of interrogating the user,
// and what lets the Tasks page show what's coming.
//
// Shared by the agent's `calendar` tool and /api/tasks. One implementation.
//
// ⭐ ONE MEETING PER EVENT (GET-230). A calendar invite is written as one observation per
// external attendee, so reading rows back gave the product four one-person meetings where
// Google showed one call with four guests. The invite itself rides along on every row
// (`raw.attendee_emails`, `organizer_email`, `event_id`), so the rows are folded back into
// the event and every guest is named — both sides, with the ones not in the graph kept by
// email. Sources that carry no guest list (HubSpot, Fireflies, Cal.com …) fold on
// source + start + title instead.

import { getInternalIdentities, getInternalEntityIds } from '@nous/core';

const DAY = 86_400_000;

const MEETING_PROPS = [
  'interaction.meeting_scheduled',
  'interaction.meeting_held',
  'interaction.meeting_cancelled',
];

// A meeting's NAME, never its content (GET-238).
//
// Every source files the call's content under `value.summary` — a Fireflies or Granola AI summary,
// a Fathom transcript excerpt, a HubSpot note — and the name under `value.description`, dressed
// as "Meeting: Harborline/Theo", "Booked: Connect with Nous" or "Weekly Partners Sync Call
// (Scheduled)". Reading `summary` first titled a meeting with a 2,700-character call summary. So:
// the source's own title field on the raw payload first (Google's `summary` IS the title),
// then `description`, `title`, with the dressing stripped. `summary` on the value, never.
const RAW_TITLE = ['title', 'meeting_name', 'summary'];
const VALUE_TITLE = ['description', 'title'];
function cleanTitle(t) {
  if (typeof t !== 'string') return null;
  const line = t.split('\n').map(x => x.trim()).find(Boolean) ?? '';
  const clean = line
    .replace(/^(meeting|booked|call)\s*:\s*/i, '')
    .replace(/\s*\((scheduled|held)\)\s*$/i, '')
    .trim();
  if (!clean || /^interaction\.|^meeting_(scheduled|held|cancelled)$/i.test(clean)) return null;
  return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}
function meetingTitle(value, raw = null) {
  if (raw && typeof raw === 'object') {
    for (const f of RAW_TITLE) { const t = cleanTitle(raw[f]); if (t) return t; }
  }
  if (typeof value === 'string') return cleanTitle(value);
  if (!value || typeof value !== 'object') return null;
  for (const f of VALUE_TITLE) { const t = cleanTitle(value[f]); if (t) return t; }
  return null;
}

const normEmail = (e) => (typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase() : null);
const minuteOf = (iso) => new Date(iso).toISOString().slice(0, 16);

/**
 * Meetings in a window, soonest first — one per event, each naming everyone on it.
 *
 * Each meeting: { when, title, status, source, event_id, organizer_email, attendees[],
 * entity_ids[] } plus the legacy single-person fields (`entity_id`, `with`, `company`,
 * `job_title`), which point at the LEAD external attendee so older callers keep working.
 *
 * An attendee: { email, name, title, company, entity_id, side: 'internal' | 'external',
 * user_id (internal only), organizer, response_status }.
 *
 * @param {object}  opts
 * @param {number}  opts.fromDays  window start, days from now (0 = today, negative looks back)
 * @param {number}  opts.toDays    window end, days from now
 * @param {string}  opts.name      optional — only meetings where an attendee matches (partial, case-insensitive)
 * @param {boolean} opts.upcomingOnly  drop anything already in the past
 * @param {string[]} opts.entityIds   optional — only meetings hung off these people (an account's)
 */
export async function getMeetings(supabase, workspaceId, opts = {}) {
  const fromDays = opts.fromDays ?? 0;
  const toDays   = opts.toDays ?? 7;

  const from = new Date(Date.now() + fromDays * DAY);
  const to   = new Date(Date.now() + (toDays + 1) * DAY);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  let query = supabase
    .from('observations')
    .select('entity_id, property, value, observed_at, source, raw')
    .eq('workspace_id', workspaceId)
    .in('property', MEETING_PROPS)
    .gte('observed_at', from.toISOString())
    .lt('observed_at', to.toISOString());
  if (Array.isArray(opts.entityIds) && opts.entityIds.length) query = query.in('entity_id', opts.entityIds.slice(0, 500));
  const { data: obs, error } = await query
    .order('observed_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  if (!obs?.length) return [];

  const now = Date.now();

  // A cancellation at the same slot supersedes the scheduled row.
  const cancelled = new Set(
    obs.filter(o => o.property === 'interaction.meeting_cancelled')
       .map(o => `${o.entity_id}|${minuteOf(o.observed_at)}`),
  );

  // ── Fold rows into events ───────────────────────────────────────────────────
  const groups = new Map();
  for (const o of obs) {
    if (o.property === 'interaction.meeting_cancelled') continue;
    if (opts.upcomingOnly && new Date(o.observed_at).getTime() < now) continue;
    const raw = o.raw && typeof o.raw === 'object' ? o.raw : null;
    const title = meetingTitle(o.value, raw);
    const minute = minuteOf(o.observed_at);
    // The event id alone is not enough: a moved meeting keeps its id, and the old slot is
    // a different (cancelled) meeting.
    const key = raw?.event_id
      ? `${o.source}|${raw.event_id}|${minute}`
      : `${o.source}|${minute}|${(title ?? '').toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { when: o.observed_at, title, source: o.source ?? null, event_id: raw?.event_id ?? null, organizer: null, emails: new Set(), rows: [] };
      groups.set(key, g);
    }
    g.title ??= title;
    const org = normEmail(raw?.organizer_email);
    if (org) g.organizer ??= org;
    for (const e of Array.isArray(raw?.attendee_emails) ? raw.attendee_emails : []) {
      const n = normEmail(e);
      if (n) g.emails.add(n);
    }
    g.rows.push({ entity_id: o.entity_id, property: o.property, response_status: raw?.response_status ?? null, cancelled: cancelled.has(`${o.entity_id}|${minute}`) });
  }

  // One call reported by two connectors (a Cal.com booking AND its Google event) is still one
  // meeting: a group with no event id folds into any group holding the same person at the
  // same minute — the calendar event when there is one, since it carries the guest list.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => (b.event_id ? 1 : 0) - (a.event_id ? 1 : 0));
  const owner = new Map();   // `${entity}|${minute}` → group key
  for (const [key, g] of ordered) {
    const minute = minuteOf(g.when);
    const into = !g.event_id && g.rows.map(r => owner.get(`${r.entity_id}|${minute}`)).find(k => k && k !== key);
    if (into) {
      const target = groups.get(into);
      target.rows.push(...g.rows.filter(r => !target.rows.some(t => t.entity_id === r.entity_id)));
      target.title ??= g.title;
      groups.delete(key);
      continue;
    }
    for (const r of g.rows) if (r.entity_id) owner.set(`${r.entity_id}|${minute}`, key);
  }
  if (!groups.size) return [];

  // ── Resolve every guest in one pass ─────────────────────────────────────────
  const allEmails = [...new Set([...groups.values()].flatMap(g => [...g.emails, g.organizer].filter(Boolean)))];

  // Our own people. An identity lookup that fails must not take the meetings down with it —
  // the guests just go unlabelled.
  const internalByEmail = new Map();   // email → { user_id, name }
  let internalEntityIds = new Set();
  try {
    const [identities, entIds] = await Promise.all([
      getInternalIdentities(supabase, workspaceId),
      getInternalEntityIds(supabase, workspaceId),
    ]);
    for (const idy of identities) {
      if (idy.kind !== 'email') continue;
      const prev = internalByEmail.get(idy.value);
      internalByEmail.set(idy.value, { user_id: idy.ownerUserId, name: prev?.name ?? idy.label ?? null });
    }
    internalEntityIds = new Set(entIds);
  } catch (e) {
    console.warn('[calendar] internal identities unavailable:', e.message);
  }

  // Which guests are already people in the graph.
  const entityByEmail = new Map();
  for (let i = 0; i < allEmails.length; i += 200) {
    const { data } = await supabase.from('entity_identifiers')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active')
      .in('value', allEmails.slice(i, i + 200));
    for (const r of data ?? []) {
      const v = normEmail(r.value);
      if (v && !entityByEmail.has(v)) entityByEmail.set(v, r.entity_id);
    }
  }

  const entityIds = [...new Set([
    ...[...groups.values()].flatMap(g => g.rows.map(r => r.entity_id)),
    ...entityByEmail.values(),
  ].filter(Boolean))];
  const byEntity = new Map();
  for (let i = 0; i < entityIds.length; i += 200) {
    const { data: nameClaims } = await supabase
      .from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('entity_id', entityIds.slice(i, i + 200))
      .in('property', ['first_name', 'last_name', 'name', 'company', 'job_title', 'email'])
      .is('invalid_at', null);
    for (const c of nameClaims ?? []) {
      const m = byEntity.get(c.entity_id) ?? {};
      m[c.property] = c.value;
      byEntity.set(c.entity_id, m);
    }
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const nameOf = (id) => {
    const m = byEntity.get(id) ?? {};
    return str(m.name) ?? ([str(m.first_name), str(m.last_name)].filter(Boolean).join(' ') || null);
  };

  // ── Build each meeting ──────────────────────────────────────────────────────
  const meetings = [];
  for (const g of groups.values()) {
    const attendees = [];
    const seenEntity = new Set();
    const rowFor = (entityId) => g.rows.find(r => r.entity_id === entityId);

    const addPerson = (email, entityId) => {
      if (entityId && seenEntity.has(entityId)) return;
      const internal = (email && internalByEmail.get(email)) || null;
      const isInternal = !!internal || (entityId ? internalEntityIds.has(entityId) : false);
      const m = entityId ? byEntity.get(entityId) ?? {} : {};
      const row = entityId ? rowFor(entityId) : null;
      attendees.push({
        email: email ?? normEmail(m.email),
        name: (entityId ? nameOf(entityId) : null) ?? internal?.name ?? null,
        title: str(m.job_title),
        company: str(m.company),
        entity_id: entityId ?? null,
        side: isInternal ? 'internal' : 'external',
        user_id: internal?.user_id ?? null,
        organizer: !!email && email === g.organizer,
        response_status: row?.response_status ?? null,
      });
      if (entityId) seenEntity.add(entityId);
    };

    // Everyone on the invite, in the order it lists them…
    for (const email of g.emails) addPerson(email, entityByEmail.get(email) ?? null);
    if (g.organizer && !g.emails.has(g.organizer)) addPerson(g.organizer, entityByEmail.get(g.organizer) ?? null);
    // …then anyone the rows name that the invite didn't (sources with no guest list).
    for (const r of g.rows) if (r.entity_id && !seenEntity.has(r.entity_id)) addPerson(null, r.entity_id);

    // Their side first, people we can name first; our side after.
    attendees.sort((a, b) =>
      (a.side === b.side ? 0 : a.side === 'external' ? -1 : 1)
      || (a.entity_id && a.name ? 0 : 1) - (b.entity_id && b.name ? 0 : 1));

    if (opts.name) {
      const q = String(opts.name).toLowerCase();
      if (!attendees.some(a => (a.name ?? '').toLowerCase().includes(q) || (a.email ?? '').includes(q))) continue;
    }

    const external = attendees.filter(a => a.side === 'external');
    const lead = external.find(a => a.entity_id && a.name) ?? external.find(a => a.entity_id) ?? external[0] ?? null;
    const live = g.rows.filter(r => !r.cancelled);
    const status = !live.length ? 'cancelled'
      : live.some(r => r.property === 'interaction.meeting_held') && new Date(g.when).getTime() <= now ? 'held'
      : 'scheduled';

    meetings.push({
      when: g.when,
      title: g.title,
      status,
      source: g.source,
      event_id: g.event_id,
      organizer_email: g.organizer,
      attendees,
      entity_ids: external.map(a => a.entity_id).filter(Boolean),
      // Legacy single-person shape — the lead external attendee.
      with: lead?.name ?? null,
      company: lead?.company ?? external.find(a => a.company)?.company ?? null,
      job_title: lead?.title ?? null,
      entity_id: lead?.entity_id ?? g.rows[0]?.entity_id ?? null,
    });
  }

  return meetings.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());
}

/** A meeting as the agent reads it: who, when, what — nothing it would have to sift past. */
export function slimMeeting(m) {
  if (!m) return null;
  return {
    when: m.when, title: m.title, status: m.status, organizer_email: m.organizer_email,
    attendees: (m.attendees ?? []).map(a => ({
      name: a.name, email: a.email, title: a.title, company: a.company,
      entity_id: a.entity_id, side: a.side, ...(a.organizer ? { organizer: true } : {}),
    })),
  };
}

/**
 * The meetings on ONE ACCOUNT — found on the record, never in a calendar (GET-231).
 *
 * A meeting hangs off each external person on it, so "the account's meetings" are the
 * meetings of everyone who works there: a person resolves to their company, a company to its
 * people. Returns the next meeting (one that started up to 90 minutes ago still counts — the
 * operator preps a call they are about to join), the last one before it, and the next few
 * upcoming so a prep for a later call can be picked by title or date.
 */
export async function accountMeetings(supabase, workspaceId, entityId, { lookbackDays = 90, aheadDays = 30 } = {}) {
  const ids = new Set([entityId]);
  const { data: ent } = await supabase.from('entities').select('type')
    .eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();

  let companyId = ent?.type === 'company' ? entityId : null;
  if (!companyId) {
    const { data: rel } = await supabase.from('relationships').select('to_entity_id')
      .eq('workspace_id', workspaceId).eq('from_entity_id', entityId).eq('type', 'works_at')
      .is('valid_to', null).limit(1);
    companyId = rel?.[0]?.to_entity_id ?? null;
  }
  if (companyId) {
    ids.add(companyId);
    const { data: people } = await supabase.from('relationships').select('from_entity_id')
      .eq('workspace_id', workspaceId).eq('to_entity_id', companyId).eq('type', 'works_at')
      .is('valid_to', null).limit(500);
    for (const r of people ?? []) ids.add(r.from_entity_id);
  }

  const meetings = (await getMeetings(supabase, workspaceId, {
    fromDays: -lookbackDays, toDays: aheadDays, entityIds: [...ids],
  })).filter(m => m.status !== 'cancelled');

  const now = Date.now();
  const upcoming = meetings.filter(m => new Date(m.when).getTime() > now - 90 * 60_000);
  const next = upcoming[0] ?? null;
  const cutoff = next ? new Date(next.when).getTime() : now;
  const last = meetings.filter(m => new Date(m.when).getTime() < cutoff).at(-1) ?? null;

  return {
    next: slimMeeting(next),
    last: slimMeeting(last),
    upcoming: upcoming.slice(1, 5).map(m => ({ when: m.when, title: m.title })),
  };
}
