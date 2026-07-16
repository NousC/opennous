// The user's meetings, and who each one is actually with.
//
// Meetings live as observations dated at the meeting time, hung off the person
// they're with. That makes "who is tomorrow's call with" a range query — which
// is what lets the agent resolve "Vik" itself instead of interrogating the user,
// and what lets the Tasks page show what's coming.
//
// Shared by the agent's `calendar` tool and /api/tasks. One implementation.

const DAY = 86_400_000;

const MEETING_PROPS = [
  'interaction.meeting_scheduled',
  'interaction.meeting_held',
  'interaction.meeting_cancelled',
];

// Pull the readable line out of a calendar payload without ever dumping JSON.
const PROSE = ['summary', 'description', 'title', 'text'];
function meetingTitle(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value !== 'object') return null;
  for (const f of PROSE) {
    const v = value[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Meetings in a window, newest-relevant first, each naming the person it's with.
 *
 * @param {object}  opts
 * @param {number}  opts.fromDays  window start, days from now (0 = today, negative looks back)
 * @param {number}  opts.toDays    window end, days from now
 * @param {string}  opts.name      optional — only meetings whose attendee matches (partial, case-insensitive)
 * @param {boolean} opts.upcomingOnly  drop anything already in the past
 */
export async function getMeetings(supabase, workspaceId, opts = {}) {
  const fromDays = opts.fromDays ?? 0;
  const toDays   = opts.toDays ?? 7;

  const from = new Date(Date.now() + fromDays * DAY);
  const to   = new Date(Date.now() + (toDays + 1) * DAY);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  const { data: obs, error } = await supabase
    .from('observations')
    .select('entity_id, property, value, observed_at')
    .eq('workspace_id', workspaceId)
    .in('property', MEETING_PROPS)
    .gte('observed_at', from.toISOString())
    .lt('observed_at', to.toISOString())
    .order('observed_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  if (!obs?.length) return [];

  // Name the attendee — that's the whole point of the surface.
  const entityIds = [...new Set(obs.map(o => o.entity_id).filter(Boolean))];
  const { data: nameClaims } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('entity_id', entityIds)
    .in('property', ['first_name', 'last_name', 'name', 'company', 'job_title']);

  const byEntity = new Map();
  for (const c of nameClaims ?? []) {
    const m = byEntity.get(c.entity_id) ?? {};
    m[c.property] = c.value;
    byEntity.set(c.entity_id, m);
  }
  const nameOf = (id) => {
    const m = byEntity.get(id) ?? {};
    return m.name ? String(m.name) : [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  };

  // A cancellation at the same slot supersedes the scheduled row.
  const cancelled = new Set(
    obs.filter(o => o.property === 'interaction.meeting_cancelled')
       .map(o => `${o.entity_id}|${o.observed_at}`),
  );

  const now = Date.now();
  const seen = new Set();
  const meetings = [];

  for (const o of obs) {
    if (o.property === 'interaction.meeting_cancelled') continue;
    const key = `${o.entity_id}|${o.observed_at}`;
    if (seen.has(key)) continue;   // one meeting reported by two connectors
    seen.add(key);

    const who = nameOf(o.entity_id);
    if (opts.name && !who.toLowerCase().includes(String(opts.name).toLowerCase())) continue;

    const when = o.observed_at;
    if (opts.upcomingOnly && new Date(when).getTime() < now) continue;

    const m = byEntity.get(o.entity_id) ?? {};
    meetings.push({
      when,
      title: meetingTitle(o.value),
      status: cancelled.has(key) ? 'cancelled'
        : o.property === 'interaction.meeting_held' ? 'held' : 'scheduled',
      with: who || null,
      company: m.company ? String(m.company) : null,
      job_title: m.job_title ? String(m.job_title) : null,
      entity_id: o.entity_id,
    });
  }

  return meetings;
}
