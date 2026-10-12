/**
 * Internal meeting next steps become tasks (GET-446).
 *
 * A next step in an internal meeting summary ("Theo Bramwell — create the workspace for Harborline,
 * by 2026-09-18") is a task in every sense the Tasks page knows: an owner, a due date, an account
 * and a source. It is written the way every other task is — an `action_item.*` state observation
 * that projects to a claim — so the page, the account view and the agent read it with no change.
 *
 *   owner    the named teammate; a step two people share becomes one task each, so each can close
 *            their own. Stored as an address (GET-383) and resolved to a seat on read.
 *   account  the client when the step is scoped to one ("· Harborline"), so it shows under that
 *            account; otherwise the owner's own team record, which the page reads as internal.
 *   due      only when one was said; never invented.
 *   source   the meeting page in the brain, with the meeting's title and date.
 *
 * Read from the stored summary's Next steps section rather than from the model's answer, so the
 * live path and a backfill over summaries already written are the same code. Deduped per meeting
 * and step: re-running a summary never files a second copy.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sectionText, type DocumentSection } from './documents.js';
import { recordObservation } from './observations.js';
import { resolveFocus } from './entities.js';
import { getWorkspaceTimezone } from './workspaces.js';
import { resolveDuePhrase, dueDateAgreeingWith } from '../dateResolve.js';
import { writesTasks } from '../services/meetingPolicy.js';
import { emptyTaskProvenance } from '../services/taskProvenance.js';
import { sameTask } from './meetingTaskClosure.js';

export interface MeetingNextStep { owners: string[]; action: string; due: string | null; client: string | null }

// "- **Theo Bramwell, Avery Castellan** — Do the thing. _(by 2026-09-18 17:00)_ · Harborline"
const STEP = /^- (?:\*\*(.+?)\*\* — )?(.+?)(?: _\(by (.+?)\)_)?(?: · ([^·]+))?$/;

/** The Next steps section of a stored summary, back as steps. */
export function parseMeetingNextSteps(sections: DocumentSection[]): MeetingNextStep[] {
  const body = sectionText(sections.find(s => s.label === 'Next steps') ?? { label: '', body: '' });
  const out: MeetingNextStep[] = [];
  for (const line of body.split('\n')) {
    const m = STEP.exec(line.trim());
    if (!m || /^_None\._$/.test(m[2])) continue;
    out.push({
      owners: (m[1] ?? '').split(/,|\band\b|&/).map(s => s.trim()).filter(Boolean),
      action: m[2].trim(),
      due: m[3]?.trim() || null,
      client: m[4]?.trim() || null,
    });
  }
  return out;
}

interface Member { user_id: string; email: string | null; name: string | null }

async function workspaceMembers(supabase: SupabaseClient, workspaceId: string): Promise<Member[]> {
  const { data, error } = await supabase.from('workspace_members').select('user_id, users:user_id(email, name)').eq('workspace_id', workspaceId);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => {
    const u = (Array.isArray(r.users) ? r.users[0] : r.users) as { email?: string; name?: string } | null;
    return { user_id: String(r.user_id), email: u?.email?.toLowerCase() ?? null, name: u?.name ?? null };
  });
}

/** A name as the summary wrote it → one member: the full name, else a first name only one member has. */
function memberFor(name: string, members: Member[]): Member | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const full = members.filter(m => (m.name ?? '').trim().toLowerCase() === n);
  if (full.length === 1) return full[0];
  const first = n.split(/\s+/)[0];
  const byFirst = members.filter(m => (m.name ?? '').trim().toLowerCase().split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/**
 * A company entity for a client name. A name that fits several records is settled only when
 * exactly one of them is a real account with a domain — the usual shape of a CRM import beside a
 * stray duplicate (Harborline: harborline.example with dozens of facts, and an empty "Harborline"). Otherwise null:
 * a task left off an account beats one filed on the wrong one.
 */
async function companyFor(supabase: SupabaseClient, workspaceId: string, name: string): Promise<string | null> {
  return (await resolveClientCompany(supabase, workspaceId, name))?.id ?? null;
}

/**
 * A client as a summary names it → the company record, or null. A person's name ("Rowan") follows
 * them to the company they work at. Used for tasks and for the brain's Accounts (GET-449).
 */
export async function resolveClientCompany(
  supabase: SupabaseClient, workspaceId: string, name: string,
): Promise<{ id: string; name: string | null; domain: string | null } | null> {
  const r = await resolveFocus(supabase, workspaceId, name).catch(() => null);
  if (!r || r.status === 'not_found') return null;
  let ids = r.status === 'resolved' ? [r.entity_id] : r.candidates.map(c => c.entity_id);
  if (r.status === 'resolved') {
    const { data: e } = await supabase.from('entities').select('type').eq('workspace_id', workspaceId).eq('id', r.entity_id).maybeSingle();
    if (e?.type === 'person') {
      const { data: rel } = await supabase.from('relationships').select('to_entity_id')
        .eq('workspace_id', workspaceId).eq('from_entity_id', r.entity_id).eq('type', 'works_at').is('valid_to', null).limit(1);
      if (!rel?.[0]) return null;
      ids = [rel[0].to_entity_id];
    }
  }
  const { data, error } = await supabase.from('companies').select('id, name, domain').eq('workspace_id', workspaceId).in('id', ids.slice(0, 50));
  if (error) throw error;
  const companies = (data ?? []) as { id: string; name: string | null; domain: string | null }[];
  if (ids.length === 1) return companies[0] ?? null;
  const withDomain = companies.filter(c => c.domain);
  return withDomain.length === 1 ? withDomain[0] : null;
}

const slug = (v: string) => v.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);

/**
 * File a meeting's next steps as tasks. Returns how many were new (a re-run returns 0).
 * `fallbackEntityId` is an internal attendee, used when an owner's own record cannot be found.
 */
export async function fileInternalMeetingTasks(
  supabase: SupabaseClient, workspaceId: string,
  input: {
    sections: DocumentSection[]; sourceRef: string; title: string; occurredAt: string | null;
    fallbackEntityId: string; meetingUrl: string | null;
  },
): Promise<number> {
  const steps = parseMeetingNextSteps(input.sections);
  if (!steps.length) return 0;
  const [members, timeZone] = await Promise.all([
    workspaceMembers(supabase, workspaceId),
    getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined),
  ]);
  // source://granola/not_Q4mZx… → system "granola", call "not_Q4mZx…".
  const [system = 'meeting', ...idParts] = input.sourceRef.replace(/^source:\/\//, '').split('/');
  const callId = slug(idParts.join('_') || input.sourceRef);
  const anchor = new Date(input.occurredAt ?? Date.now());
  // Tasks only from a meeting in the last 30 days (GET-514).
  if (!writesTasks(input.occurredAt)) return 0;
  // The same call recorded twice (Fireflies and Granola) is two summaries with the same next steps.
  // A step that repeats an open task of the same owner from within two days is that task again.
  const { data: openRows, error: openErr } = await supabase.from('claims').select('property, value')
    .eq('workspace_id', workspaceId).gte('property', 'action_item.internal_').lt('property', 'action_item.internal`').is('invalid_at', null).limit(2000);
  if (openErr) throw openErr;
  const near = (openRows ?? [])
    .map(r => r.value as Record<string, unknown>)
    .filter(v => v?.status === 'open' && Math.abs(Date.parse(String(v.occurred_at ?? '')) - anchor.getTime()) <= 2 * 86_400_000);
  const repeats = (title: string, owner: string | null) =>
    near.some(v => String(v.source_id ?? '') !== input.sourceRef && (v.owner_name ?? null) === owner && sameTask(String(v.title ?? ''), title));
  const clientCache = new Map<string, string | null>();
  const ownEntityCache = new Map<string, string | null>();
  let filed = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const owners = step.owners.length ? step.owners : [''];
    let accountId: string | null = null;
    if (step.client) {
      if (!clientCache.has(step.client)) clientCache.set(step.client, await companyFor(supabase, workspaceId, step.client));
      accountId = clientCache.get(step.client) ?? null;
    }
    // A date the summary wrote as YYYY-MM-DD resolves directly; a phrase goes through the resolver.
    const iso = step.due ? /\d{4}-\d{2}-\d{2}/.exec(step.due)?.[0] ?? null : null;
    const dueAt = step.due ? (iso ?? dueDateAgreeingWith(resolveDuePhrase(step.due, anchor, timeZone), step.action)) : null;

    for (let j = 0; j < owners.length; j++) {
      const member = owners[j] ? memberFor(owners[j], members) : null;
      let entityId = accountId;
      if (!entityId && member?.email) {
        if (!ownEntityCache.has(member.email)) {
          const r = await resolveFocus(supabase, workspaceId, member.email).catch(() => null);
          ownEntityCache.set(member.email, r?.status === 'resolved' ? r.entity_id : null);
        }
        entityId = ownEntityCache.get(member.email) ?? null;
      }
      entityId = entityId ?? input.fallbackEntityId;
      const property = `action_item.internal_${slug(system)}_${callId}_${i}_${j}`;
      if (repeats(step.action, member?.name ?? (owners[j] || null))) continue;
      const obs = await recordObservation(supabase, {
        workspaceId, entityId, kind: 'state', property,
        value: {
          ...emptyTaskProvenance(),
          source_title: input.title,
          source_url: input.meetingUrl,
          occurred_at: input.occurredAt,
          title: step.action.slice(0, 300),
          owner_kind: 'user',
          owner_email: member?.email ?? null,
          owner_name: member?.name ?? (owners[j] || null),
          status: 'open',
          due_phrase: step.due,
          due_at: dueAt,
          source_type: 'internal_meeting',
          source_id: input.sourceRef,
          internal_meeting: true,
          client: step.client,
        },
        source: `${system}:internal-meeting`,
        method: 'extraction',
        observedAt: input.occurredAt ?? new Date().toISOString(),
        externalId: property,
      });
      if (obs) filed++;
    }
  }
  return filed;
}

/**
 * The names summaries give one client ("Harborline", "Rowan's Company", "Rowan") → the account's own
 * name, so the brain shows one client once. A name that resolves to no account keeps its own name.
 */
export async function canonicalClientNames(
  supabase: SupabaseClient, workspaceId: string, names: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of [...new Set(names)]) {
    const c = await resolveClientCompany(supabase, workspaceId, n).catch(() => null);
    out.set(n, c?.name || n);
  }
  return out;
}

/** Like canonicalClientNames, but null for a name that is no account — so a caller can tell. */
export async function resolveClientNames(
  supabase: SupabaseClient, workspaceId: string, names: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const n of [...new Set(names)]) out[n] = (await resolveClientCompany(supabase, workspaceId, n).catch(() => null))?.name ?? null;
  return out;
}
