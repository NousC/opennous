/**
 * Internal Insights as "what we believe now" (GET-466).
 *
 * Every internal meeting summary files its insights by scope (our business, or one client) and
 * topic. Listed raw, that page only grew: 32 meetings of points, the same idea in five wordings,
 * last month's view beside this week's. The brain should answer "what do we think about pricing?"
 * in one read.
 *
 * So each scope/topic gets a synthesis: the current position in a few bullets, each citing the
 * meetings behind it, and what changed from earlier views. It is stored as a hidden brain page
 * (`_synthesis/<scope>/<topic>`) so the page reads instantly, and rebuilt only for the topics a
 * new meeting touches. The meeting summaries stay the record; this is a projection over them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDocument, type DocumentSection } from './documents.js';
import { listInternalMeetings, type Brain, type InternalMeeting } from './brains.js';
import { internalMeetingSummaries, parseMeetingSummarySections, OUR_BUSINESS } from './meetingSummaries.js';
import { canonicalClientNames, resolveClientNames } from './meetingTasks.js';

export const SYNTHESIS_PREFIX = '_synthesis/';
const MAX_POINTS = 150;

export interface InsightPoint { text: string; date: string | null; path: string; title: string }
export interface TopicKey { scope: string; group: string }

const keyOf = (k: TopicKey) => `${k.scope}\u0000${k.group}`;
const clean = (v: string) => v.replace(/[\/\\]/g, '-').trim();
export const synthesisPath = (k: TopicKey) => `${SYNTHESIS_PREFIX}${clean(k.scope)}/${clean(k.group)}`;

/** Where hand-set client names live: `{ "Saltmarsh Dealer Group": "Harborline", "Rowan": "Harborline" }`. */
export const CLIENT_ALIASES_PATH = `${SYNTHESIS_PREFIX}_client_aliases`;

/**
 * The hand-set names (GET-466): for a client the automatic match cannot settle — a call that never
 * says the company's name, or a first name two contacts share. They win over the automatic match.
 */
export async function manualClientAliases(supabase: SupabaseClient, workspaceId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('documents').select('sections')
    .eq('workspace_id', workspaceId).eq('kind', 'brain_page').eq('brain_path', CLIENT_ALIASES_PATH).eq('status', 'live').limit(1);
  if (error) throw error;
  const body = String(((data?.[0]?.sections ?? []) as DocumentSection[])[0]?.body ?? '');
  try { const m = JSON.parse(body || '{}'); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/** Save the hand-set names as the next version of their hidden page. */
export async function saveManualClientAliases(supabase: SupabaseClient, workspaceId: string, brain: Brain, aliases: Record<string, string>): Promise<void> {
  await writeDocument(supabase, workspaceId, {
    kind: 'brain_page', title: 'Client aliases', sections: [{ label: 'Client aliases', body: JSON.stringify(aliases) }],
    writtenBy: 'user', brainId: brain.id, brainPath: CLIENT_ALIASES_PATH,
  });
}

/** Every insight point from every internal meeting, by scope and topic, oldest first. */
export async function collectInsightPoints(
  supabase: SupabaseClient, workspaceId: string,
): Promise<Map<string, { key: TopicKey; points: InsightPoint[] }>> {
  const meetings = await listInternalMeetings(supabase, workspaceId);
  const summaries = await internalMeetingSummaries(supabase, workspaceId, meetings.flatMap(m => m.refs));
  const summaryOf = (m: InternalMeeting) => m.refs.map(r => summaries.get(r)).find(Boolean);
  // One client under one name: the variants a summary used resolve to the account they are.
  const clientNames = new Set<string>();
  for (const m of meetings) {
    const doc = summaryOf(m);
    if (doc) for (const g of parseMeetingSummarySections((doc.sections ?? []) as DocumentSection[]).insights) if (g.scope !== OUR_BUSINESS) clientNames.add(g.scope);
  }
  const alias = await canonicalClientNames(supabase, workspaceId, [...clientNames]);
  for (const [k, v] of Object.entries(await manualClientAliases(supabase, workspaceId))) alias.set(k, v);
  const out = new Map<string, { key: TopicKey; points: InsightPoint[] }>();
  for (const m of [...meetings].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))) {
    const doc = summaryOf(m);
    if (!doc) continue;
    for (const g of parseMeetingSummarySections((doc.sections ?? []) as DocumentSection[]).insights) {
      const key = { scope: alias.get(g.scope) ?? g.scope, group: g.group };
      const entry = out.get(keyOf(key)) ?? { key, points: [] };
      for (const p of g.points) entry.points.push({ text: p, date: m.date, path: m.path, title: m.title });
      out.set(keyOf(key), entry);
    }
  }
  return out;
}

/** The topics one stored meeting summary touches, so only those are rebuilt. */
export async function topicsOfSummary(supabase: SupabaseClient, workspaceId: string, sections: DocumentSection[]): Promise<TopicKey[]> {
  const groups = parseMeetingSummarySections(sections).insights;
  const alias = await canonicalClientNames(supabase, workspaceId, groups.map(g => g.scope).filter(sc => sc !== OUR_BUSINESS));
  for (const [k, v] of Object.entries(await manualClientAliases(supabase, workspaceId))) alias.set(k, v);
  const seen = new Map<string, TopicKey>();
  for (const g of groups) { const k = { scope: alias.get(g.scope) ?? g.scope, group: g.group }; seen.set(keyOf(k), k); }
  return [...seen.values()];
}

export function buildSynthesisPrompt(key: TopicKey, points: InsightPoint[]): string {
  const recent = points.slice(-MAX_POINTS);
  const meetings = [...new Map(recent.map(p => [p.path, p])).values()];
  const mId = new Map(meetings.map((p, i) => [p.path, `M${i + 1}`]));
  const whose = key.scope === 'Our business' ? 'our own business' : `the client ${key.scope}`;
  return [
    `You maintain the company brain's record of what the team currently believes about ${whose}, topic: ${key.group}.`,
    'Below is every point on this topic from the team\'s internal meetings, oldest first, each tagged with its meeting.',
    '',
    'Write the CURRENT position: what the team believes or has settled on now.',
    '- 2 to 5 bullets, most important first. One idea per bullet, one sentence, under 30 words.',
    '- Merge points that say the same thing. When a later meeting changed a view, the later view is the current one.',
    '- Every bullet cites the meetings it rests on (their M-ids).',
    '- Business executive register: declarative, specific, quantified where the points are. No narrative, no evaluative adjectives.',
    '- Never add anything the points do not say.',
    '',
    'Also list where the view CHANGED over time: an earlier position the team moved away from, the newer one, and the meeting where it moved. Only real changes; empty if none.',
    '',
    'Return ONLY JSON:',
    '{ "current": [{ "point": string, "meetings": ["M3", "M7"] }], "changed": [{ "from": string, "to": string, "meeting": "M9" }] }',
    '',
    'MEETINGS',
    ...meetings.map(p => `${mId.get(p.path)} · ${p.date ?? 'undated'} · ${p.title}`),
    '',
    'POINTS',
    ...recent.map(p => `- [${mId.get(p.path)} · ${p.date ?? ''}] ${p.text.replace(/\s*_\(from [^)]*\)_\s*$/, '')}`),
  ].join('\n');
}

export interface Synthesis { current: { point: string; meetings: string[] }[]; changed: { from: string; to: string; meeting: string }[] }

export function parseSynthesis(text: string): Synthesis | null {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(o?.current) || !o.current.length) return null;
    return {
      current: o.current.map((c: Record<string, unknown>) => ({ point: String(c?.point ?? '').trim(), meetings: Array.isArray(c?.meetings) ? c.meetings.map(String) : [] })).filter((c: { point: string }) => c.point),
      changed: (Array.isArray(o.changed) ? o.changed : []).map((c: Record<string, unknown>) => ({ from: String(c?.from ?? '').trim(), to: String(c?.to ?? '').trim(), meeting: String(c?.meeting ?? '') })).filter((c: { from: string; to: string }) => c.from && c.to),
    };
  } catch { return null; }
}

/** The synthesis as markdown, each claim linked to the meetings behind it. */
export function renderSynthesis(syn: Synthesis, points: InsightPoint[]): string {
  const meetings = [...new Map(points.slice(-MAX_POINTS).map(p => [p.path, p])).values()];
  const byId = new Map(meetings.map((p, i) => [`M${i + 1}`, p]));
  const link = (id: string) => { const p = byId.get(id); return p ? `[[${p.path}|${p.date ?? p.title}]]` : null; };
  const lines = syn.current.map(c => {
    const refs = c.meetings.map(link).filter(Boolean);
    return `- ${c.point}${refs.length ? ` · ${refs.join(', ')}` : ''}`;
  });
  for (const ch of syn.changed) {
    const where = link(ch.meeting);
    lines.push(`- _Changed${where ? ` in ${where}` : ''}: from "${ch.from}" to "${ch.to}"._`);
  }
  return lines.join('\n');
}

/** Where the client-name map is kept: summary name → account name (null when no account). */
export const CLIENT_MAP_PATH = `${SYNTHESIS_PREFIX}_clients`;

/**
 * Resolve every client name the summaries use and store the map beside the syntheses, so the
 * brain reads it instead of resolving a dozen names against the account records on every page
 * view (which took ~17s on the Internal Insights page).
 */
export async function saveClientMap(supabase: SupabaseClient, workspaceId: string, brain: Brain): Promise<Record<string, string | null>> {
  const meetings = await listInternalMeetings(supabase, workspaceId);
  const summaries = await internalMeetingSummaries(supabase, workspaceId, meetings.flatMap(m => m.refs));
  const names = new Set<string>();
  for (const d of summaries.values()) {
    const secs = (d.sections ?? []) as DocumentSection[];
    for (const g of parseMeetingSummarySections(secs).insights) if (g.scope !== OUR_BUSINESS) names.add(g.scope);
    for (const line of String((secs.find(x => x.label === 'Accounts')?.body) ?? '').split('\n')) {
      const a = /^- \*\*(.+?)\*\*/.exec(line.trim());
      if (a) names.add(a[1]);
    }
  }
  const map: Record<string, string | null> = { ...(await resolveClientNames(supabase, workspaceId, [...names])), ...(await manualClientAliases(supabase, workspaceId)) };
  await writeDocument(supabase, workspaceId, {
    kind: 'brain_page', title: 'Client names', sections: [{ label: 'Client names', body: JSON.stringify(map) }],
    writtenBy: 'routine', skill: 'internal-insight-synthesis', brainId: brain.id, brainPath: CLIENT_MAP_PATH,
  });
  return map;
}

/** Store one topic's synthesis as the next version of its hidden page. */
export async function saveSynthesis(
  supabase: SupabaseClient, workspaceId: string, brain: Brain, key: TopicKey, markdown: string,
): Promise<void> {
  await writeDocument(supabase, workspaceId, {
    kind: 'brain_page',
    title: `${key.scope} · ${key.group}`,
    sections: [{ label: key.group, body: markdown }],
    writtenBy: 'routine',
    skill: 'internal-insight-synthesis',
    brainId: brain.id,
    brainPath: synthesisPath(key),
  });
}
