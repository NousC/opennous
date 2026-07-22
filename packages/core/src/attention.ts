import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadContext } from './db/readContext.js';
import { getInternalEntityIds } from './db/teamMembers.js';
import { getPersonalEntityIds, getProductUserEntityIds } from './db/relationship.js';

// getAttention() — the proactive endpoint. Scans the substrate for what an
// agent should look at and returns ranked decisions. v1 detectors: accounts
// going dark, and decayed key facts. Champion-change and buying-signal
// detectors come later (they need observation diffing / a signal taxonomy).

export interface AttentionItem {
  kind: 'going_dark' | 'decayed_fact' | 'upcoming_meeting' | 'open_commitment';
  entity_id: string;
  entity_name: string | null;
  what: string;
  suggested_action: string;
  age_days: number;
  when?: string;            // ISO — start time (upcoming_meeting) or due date (open_commitment); MCP renders local
  // Where this actually came from — the calendar that holds the meeting, the
  // transcript that captured the commitment. Every item here traces to an
  // observation, either directly or through a claim's evidence chain, so an
  // agent can always say WHERE it learned something instead of asserting it.
  // Null only when the chain is genuinely broken.
  source?: string | null;
}

export interface AttentionResult {
  items: AttentionItem[];
  meta: { going_dark: number; decayed_facts: number; upcoming_meetings: number; open_commitments: number };
}

const DAY = 86_400_000;
const KEY_PROPS = new Set(['email', 'pipeline_stage', 'job_title']);

export async function getAttention(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { limit?: number } = {},
  ctx?: ReadContext,
): Promise<AttentionResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const now = Date.now();
  const memberScope = !!(ctx && ctx.viewerScope === 'member');

  // ── going dark — last event observation 30–365 days ago ────────────────────
  let eventsQ = supabase
    .from('observations')
    .select('entity_id, observed_at, source')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'event')
    .order('observed_at', { ascending: false })
    .limit(5000);
  // Member scope: recency (and meeting labels below) reflect only this rep's own
  // touches + shared rows, never another rep's private activity.
  if (memberScope) eventsQ = eventsQ.or(`owner_user_id.is.null,owner_user_id.eq.${ctx.viewerUserId}`);
  const { data: events } = await eventsQ;
  // Rows arrive newest-first, so the first one we see per entity IS the last
  // touch — keep its source, because "quiet since the last email" and "quiet
  // since the last call" are different facts to a rep.
  const lastTouch = new Map<string, { at: number; source: string | null }>();
  for (const o of (events as any[]) ?? []) {
    if (!lastTouch.has(o.entity_id)) {
      lastTouch.set(o.entity_id, { at: +new Date(o.observed_at), source: o.source ?? null });
    }
  }
  const goingDark: AttentionItem[] = [];
  for (const [entity_id, t] of lastTouch) {
    const age = Math.round((now - t.at) / DAY);
    if (age >= 30 && age <= 365) {
      goingDark.push({
        kind: 'going_dark', entity_id, entity_name: null, age_days: age,
        what: `no activity for ${age} days`,
        suggested_action: 'Re-engage with a follow-up, or close the account out',
        source: t.source,
      });
    }
  }
  goingDark.sort((a, b) => a.age_days - b.age_days);   // freshest-cold first — most recoverable

  // ── decayed key facts — suspect/expired claims on properties that matter ───
  const { data: decayedRaw } = await supabase
    .from('claims')
    .select('entity_id, property, value, freshness, last_observed_at, supporting_observation_ids')
    .eq('workspace_id', workspaceId)
    .in('freshness', ['suspect', 'expired'])
    .limit(500);
  const decayed: AttentionItem[] = [];
  for (const c of (decayedRaw as any[]) ?? []) {
    if (!KEY_PROPS.has(c.property) && !String(c.property).startsWith('deal.')) continue;
    const age = c.last_observed_at
      ? Math.round((now - +new Date(c.last_observed_at)) / DAY) : 0;
    decayed.push({
      kind: 'decayed_fact', entity_id: c.entity_id, entity_name: null, age_days: age,
      what: `${c.property} is ${c.freshness} — last confirmed ${age}d ago`,
      suggested_action: c.property === 'email'
        ? 'Verify the email before sending'
        : 'Verify this fact before acting on it',
    });
  }
  decayed.sort((a, b) => b.age_days - a.age_days);

  // ── upcoming meetings — scheduled calls from now through the next 7 days ────
  // These lead the list: a call today is the most actionable thing in the
  // workspace. Cancellations are append-only events that reuse the meeting's
  // (entity_id, start time), so we use them to drop calls that are now off.
  const nowISO = new Date(now).toISOString();
  const horizonISO = new Date(now + 7 * DAY).toISOString();
  let meetingQ = supabase
    .from('observations')
    .select('entity_id, observed_at, value, property, source')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'event')
    .in('property', ['interaction.meeting_scheduled', 'interaction.meeting_cancelled'])
    .gte('observed_at', nowISO)
    .lte('observed_at', horizonISO)
    .order('observed_at', { ascending: true })   // soonest first
    .limit(500);
  if (memberScope) meetingQ = meetingQ.or(`owner_user_id.is.null,owner_user_id.eq.${ctx.viewerUserId}`);
  const { data: meetingRaw } = await meetingQ;
  // Pre-pass: collect slots that are OFF — either a separate meeting_cancelled
  // event, or a meeting_scheduled whose label carries the RSVP (the calendar
  // poller stamps "(Declined)"/"(Cancelled)" into the description, so a declined
  // call still lands as meeting_scheduled). Slot = entity + start time.
  const offSlots = new Set<string>();
  const labelOf = (o: any): string => {
    const v = o.value as { description?: string; summary?: string } | null;
    return String(v?.summary || v?.description || '');
  };
  // Slot = entity + start-minute. Bucketing to the minute makes the match robust
  // to timestamp-format differences between connectors, so a Cal.com booking and
  // its Google Calendar mirror (or a cancellation) land on the same slot.
  const slotKey = (o: any): string =>
    `${o.entity_id}|${o.observed_at ? Math.floor(new Date(o.observed_at).getTime() / 60_000) : 0}`;
  for (const o of (meetingRaw as any[]) ?? []) {
    const slot = slotKey(o);
    if (o.property === 'interaction.meeting_cancelled') { offSlots.add(slot); continue; }
    if (/\((declined|cancell?ed)\)/i.test(labelOf(o))) offSlots.add(slot);
  }
  const upcoming: AttentionItem[] = [];
  const seenSlots = new Set<string>();   // collapse re-imports + cross-source dupes of the same meeting
  for (const o of (meetingRaw as any[]) ?? []) {
    if (o.property !== 'interaction.meeting_scheduled') continue;
    const slot = slotKey(o);
    if (offSlots.has(slot) || seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    const daysUntil = Math.round((+new Date(o.observed_at) - now) / DAY);
    upcoming.push({
      kind: 'upcoming_meeting', entity_id: o.entity_id, entity_name: null,
      age_days: daysUntil, when: o.observed_at,
      // strip the "Booked:" prefix and trailing status label — the time +
      // "upcoming" already say it's a scheduled call.
      what: labelOf(o).replace(/^Booked:\s*/i, '').replace(/\s*\((Scheduled|Held)\)\s*$/i, '').trim() || 'meeting scheduled',
      suggested_action: 'Prep before the call — pull a meeting brief',
      source: o.source ?? null,
    });
  }

  // ── open commitments — YOUR action items not yet done ───────────────────────
  // Extracted from meetings/emails as action_item.* claims. Surface only the
  // founder's own open commitments (owner_kind:'user') so the agent can nudge
  // "you owe X to this account"; what the prospect owes you isn't your to-do.
  const { data: aiRows } = await supabase
    .from('claims')
    .select('entity_id, value, computed_at, supporting_observation_ids')
    .eq('workspace_id', workspaceId)
    .like('property', 'action_item.%')
    .is('invalid_at', null)
    .limit(300);
  const commitments: AttentionItem[] = [];
  // A claim's origin lives at the far end of its evidence chain: the observation
  // it was derived from. Collect the first supporting id for each claim now, and
  // resolve them all in ONE query below rather than a lookup per item.
  const chain: { item: AttentionItem; obsId: string }[] = [];
  for (const r of (aiRows as any[]) ?? []) {
    const v = r.value ?? {};
    if (v.owner_kind !== 'user' || (v.status ?? 'open') !== 'open' || !v.title) continue;
    const item: AttentionItem = {
      kind: 'open_commitment', entity_id: r.entity_id, entity_name: null,
      age_days: Math.round((now - +new Date(r.computed_at)) / DAY),
      what: `You owe: ${v.title}`,
      suggested_action: 'Follow up or mark it done',
      ...(v.due_at ? { when: v.due_at } : {}),
      source: null,
    };
    const obsId = (r.supporting_observation_ids ?? [])[0];
    if (obsId) chain.push({ item, obsId });
    commitments.push(item);
  }
  commitments.sort((a, b) => b.age_days - a.age_days);   // oldest-owed first

  for (const c of (decayedRaw as any[]) ?? []) {
    const obsId = (c.supporting_observation_ids ?? [])[0];
    if (!obsId) continue;
    const item = decayed.find(d => d.entity_id === c.entity_id && d.what.startsWith(String(c.property)));
    if (item) chain.push({ item, obsId });
  }

  // ── origins — one batched observations query for every claim-derived item ────
  // A commitment isn't something Nous knows; it's something someone SAID, in a
  // call we have the transcript of. Naming that call is the difference between
  // an assertion and a citation.
  if (chain.length) {
    const { data: origins } = await supabase
      .from('observations')
      .select('id, source')
      .in('id', [...new Set(chain.map(c => c.obsId))]);
    const sourceOf = new Map((origins as any[] ?? []).map(o => [o.id, o.source ?? null]));
    for (const { item, obsId } of chain) {
      const src = sourceOf.get(obsId);
      if (src) item.source = src;
    }
  }

  // ── Drop non-deal records (team, personal, product users) ───────────────────
  // A teammate, a personal contact, or a product user (a "Free User" signup) going
  // quiet is not a pipeline concern, so none of them surface as "needs attention".
  const [internalIds, personalIds, productUserIds] = await Promise.all([
    getInternalEntityIds(supabase, workspaceId),
    getPersonalEntityIds(supabase, workspaceId),
    getProductUserEntityIds(supabase, workspaceId),
  ]);
  if (internalIds.size || personalIds.size || productUserIds.size) {
    const drop = (id: string) => internalIds.has(id) || personalIds.has(id) || productUserIds.has(id);
    for (const arr of [upcoming, commitments, goingDark, decayed]) {
      for (let i = arr.length - 1; i >= 0; i--) if (drop(arr[i].entity_id)) arr.splice(i, 1);
    }
  }

  // ── entity names — one batched claims query ─────────────────────────────────
  const ids = [...new Set([...upcoming, ...commitments, ...goingDark, ...decayed].map(i => i.entity_id))];
  if (ids.length) {
    const { data: nameClaims } = await supabase
      .from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('entity_id', ids)
      .in('property', ['name', 'first_name', 'last_name']);
    const parts = new Map<string, Record<string, unknown>>();
    for (const c of (nameClaims as any[]) ?? []) {
      const m = parts.get(c.entity_id) ?? {};
      m[c.property] = c.value;
      parts.set(c.entity_id, m);
    }
    const nameOf = (id: string): string | null => {
      const m = parts.get(id) ?? {};
      if (m.name) return String(m.name);
      return [m.first_name, m.last_name].filter(Boolean).join(' ') || null;
    };
    for (const it of upcoming)    it.entity_name = nameOf(it.entity_id);
    for (const it of commitments) it.entity_name = nameOf(it.entity_id);
    for (const it of goingDark)   it.entity_name = nameOf(it.entity_id);
    for (const it of decayed)     it.entity_name = nameOf(it.entity_id);
  }

  // Budget: upcoming meetings + your open commitments lead (both time/action-
  // critical), then split the rest between going-dark and decayed facts.
  const leadShown = [...upcoming, ...commitments].slice(0, limit);
  const rest = limit - leadShown.length;
  const half = Math.ceil(rest / 2);
  const items = [
    ...leadShown,
    ...goingDark.slice(0, half),
    ...decayed.slice(0, rest - Math.min(goingDark.length, half)),
  ].slice(0, limit);

  return {
    items,
    meta: {
      going_dark: goingDark.length,
      decayed_facts: decayed.length,
      upcoming_meetings: upcoming.length,
      open_commitments: commitments.length,
    },
  };
}
