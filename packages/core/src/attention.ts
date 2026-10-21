import type { SupabaseClient } from '@supabase/supabase-js';
import { derivedViewerForContext, filterDerivedForViewer } from './privacy/messagePrivacy.mjs';
import type { ReadContext } from './db/readContext.js';
import { getInternalEntityIds } from './db/teamMembers.js';
import { getPersonalEntityIds, getProductUserEntityIds } from './db/relationship.js';
import { intentBandOr } from './intentBand.js';

// getAttention() — the proactive endpoint. Scans the substrate for what an
// agent should look at and returns ranked decisions. v1 detectors: accounts
// going dark, and decayed key facts. Champion-change and buying-signal
// detectors come later (they need observation diffing / a signal taxonomy).

export interface AttentionItem {
  kind: 'going_dark' | 'decayed_fact' | 'upcoming_meeting' | 'open_commitment' | 'hot_intent' | 'flag';
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
  // open_commitment only: the id that closes it (`<entity_id>:<property>`), for
  // POST /v2/action-items/status and the MCP `tasks` tool (GET-830).
  task_id?: string;
}

export interface AttentionResult {
  items: AttentionItem[];
  meta: { going_dark: number; decayed_facts: number; upcoming_meetings: number; open_commitments: number; hot_intent: number; flags: number };
}

const DAY = 86_400_000;
const KEY_PROPS = new Set(['email', 'pipeline_stage', 'job_title']);

/**
 * The scheduled meetings that are still on, one per slot (GET-950 shares this with deal.stalled).
 * Cancellations are append-only events that reuse the meeting's (entity_id, start time), and the
 * calendar poller stamps an RSVP into the label ("(Declined)"/"(Cancelled)"), so a declined call
 * still lands as meeting_scheduled: both take the slot off. Slot = entity + start minute, so a
 * Cal.com booking and its Google Calendar mirror land on the same one. Rows are observations
 * ({ entity_id, observed_at = the start time, property, value }); order is kept. Pure.
 */
export function meetingsStillOn<T extends { entity_id?: string | null; observed_at?: string | null; property?: string; value?: unknown }>(rows: T[]): T[] {
  const labelOf = (o: T): string => {
    const v = o.value as { description?: string; summary?: string } | null;
    return String(v?.summary || v?.description || '');
  };
  const slotKey = (o: T): string =>
    `${o.entity_id}|${o.observed_at ? Math.floor(new Date(o.observed_at).getTime() / 60_000) : 0}`;
  const off = new Set<string>();
  for (const o of rows ?? []) {
    if (o.property === 'interaction.meeting_cancelled' || /\((declined|cancell?ed)\)/i.test(labelOf(o))) off.add(slotKey(o));
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const o of rows ?? []) {
    if (o.property !== 'interaction.meeting_scheduled') continue;
    const slot = slotKey(o);
    if (off.has(slot) || seen.has(slot)) continue;
    seen.add(slot);
    out.push(o);
  }
  return out;
}

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
  const labelOf = (o: any): string => {
    const v = o.value as { description?: string; summary?: string } | null;
    return String(v?.summary || v?.description || '');
  };
  const upcoming: AttentionItem[] = [];
  for (const o of meetingsStillOn((meetingRaw as any[]) ?? [])) {
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
    .select('entity_id, property, value, computed_at, supporting_observation_ids')
    .eq('workspace_id', workspaceId)
    .like('property', 'action_item.%')
    .is('invalid_at', null)
    .limit(300);
  // A commitment read out of an email follows the email (GET-253).
  const aiViewer = await derivedViewerForContext(supabase, ctx);
  const aiVisible = aiViewer ? await filterDerivedForViewer(supabase, workspaceId, (aiRows as any[]) ?? [], aiViewer) : aiRows;
  const commitments: AttentionItem[] = [];
  // A claim's origin lives at the far end of its evidence chain: the observation
  // it was derived from. Collect the first supporting id for each claim now, and
  // resolve them all in ONE query below rather than a lookup per item.
  const chain: { item: AttentionItem; obsId: string }[] = [];
  for (const r of (aiVisible as any[]) ?? []) {
    const v = r.value ?? {};
    if (v.owner_kind !== 'user' || (v.status ?? 'open') !== 'open' || !v.title) continue;
    // A broken rule's task (GET-846) is already in attention as its rule flag; listing it again as
    // something owed would say the same thing twice.
    if (String(r.property ?? '').startsWith('action_item.rule_')) continue;
    const item: AttentionItem = {
      kind: 'open_commitment', entity_id: r.entity_id, entity_name: null,
      age_days: Math.round((now - +new Date(r.computed_at)) / DAY),
      what: `You owe: ${v.title}`,
      suggested_action: 'Follow up, or close it if it is already done',
      task_id: `${r.entity_id}:${r.property}`,
      ...(v.due_at ? { when: v.due_at } : {}),
      source: null,
    };
    const obsId = (r.supporting_observation_ids ?? [])[0];
    if (obsId) chain.push({ item, obsId });
    commitments.push(item);
  }
  commitments.sort((a, b) => b.age_days - a.age_days);   // oldest-owed first

  // ── hot intent — the intent score says "reach out NOW" ──────────────────────
  // Warm+ accounts (score ≥ 50), led by a recent positive reply to our outreach.
  // intent_score / intent_band are two claim rows per entity; join them here.
  const { data: intentRaw } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('property', ['intent_score', 'intent_band'])
    .is('invalid_at', null)
    .limit(2000);
  const intentByEntity = new Map<string, { score: number; band: string }>();
  for (const c of (intentRaw as any[]) ?? []) {
    const m = intentByEntity.get(c.entity_id) ?? { score: 0, band: 'Dormant' };
    if (c.property === 'intent_score') m.score = Number(c.value) || 0;
    // The claim comes in two shapes — a bare "Warm" from the intent worker's
    // direct upsert, or { band, score, from } when the history observation was
    // re-derived over it. String()-ing the object printed "[object Object]" into
    // the feed. readIntentBand knows both; see intentBand.ts for why both exist.
    else m.band = intentBandOr(c.value);
    intentByEntity.set(c.entity_id, m);
  }
  const hotScored: { item: AttentionItem; score: number }[] = [];
  for (const [entity_id, m] of intentByEntity) {
    if (m.score < 50) continue;   // Warm and above only
    hotScored.push({
      score: m.score,
      item: {
        kind: 'hot_intent', entity_id, entity_name: null, age_days: 0,
        what: `intent is ${m.band} (${m.score}/100)`,
        suggested_action: 'Reach out now while it is warm',
        source: null,
      },
    });
  }
  hotScored.sort((a, b) => b.score - a.score);   // hottest first
  const hotIntent = hotScored.map(h => h.item);

  // ── recommendations — the Revenue Intelligence Engine's worklist. These replace the
  // retired flag sweep: change-detected + coaching "act on X" items, so they LEAD
  // attention. Each rec text already says what to do; only account-level recs (a
  // resolvable entity) surface here. ──
  const { data: recRows } = await supabase
    .from('ri_recommendations')
    .select('target_id, target_type, category, text')
    .eq('workspace_id', workspaceId)
    .eq('status', 'open')
    // Home's own recommendations (GET-477) are built FROM this function's signals; reading them
    // back would recommend every one twice.
    .neq('category', 'home')
    // What converts leads (learned effectiveness), then recency. `priority` is 1.0 until the
    // loop has data, so this stays recency-order for a fresh workspace. See effectiveness.mjs.
    .order('priority', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);
  const REC_ACTION: Record<string, string> = {
    signals: 'Reach out now while it is warm',
    leakage: 'Re-engage before it slips',
    pipeline: 'Advance the deal',
    meeting: 'Qualify it before it advances',
    hygiene: 'Update the record',
    journey: 'Book the conversation',
    outbound: 'Rework the sequence',
  };
  const recItems: AttentionItem[] = ((recRows as any[]) ?? [])
    .filter(r => r.target_type === 'deal' || r.target_type === 'account')
    .map(r => ({
      kind: 'flag' as const, entity_id: r.target_id, entity_name: null, age_days: 0,
      what: r.text,
      suggested_action: REC_ACTION[r.category] ?? 'Act on this recommendation',
      source: 'recommendation',
    }));

  // ── broken rules (GET-846) — the operator's own rules, checked in the background
  // (worker ruleChecks.mjs). They lead the flags: the rep said these must happen. A rule is
  // personal, so a viewer sees their own; a workspace-wide caller with no person sees them all.
  // Highest priority first: the rule's weight, then how late it is. ──
  let ruleQ = supabase
    .from('flags')
    .select('entity_id, reason, evidence, priority, owner_user_id, last_fired_at')
    .eq('workspace_id', workspaceId)
    .like('flag_type', 'rule:%')
    .eq('status', 'open')
    .order('priority', { ascending: false })
    .order('last_fired_at', { ascending: false })
    .limit(50);
  if (ctx?.viewerUserId) ruleQ = ruleQ.eq('owner_user_id', ctx.viewerUserId);
  const { data: ruleRows } = await ruleQ;
  const ruleItems: AttentionItem[] = ((ruleRows as any[]) ?? []).map(r => ({
    kind: 'flag' as const, entity_id: r.entity_id, entity_name: null,
    age_days: r.last_fired_at ? Math.max(0, Math.floor((now - Date.parse(r.last_fired_at)) / DAY)) : 0,
    what: r.reason ?? 'One of your rules is not met',
    suggested_action: r.evidence?.statement ? `Meet your rule: ${r.evidence.statement}` : 'Meet your rule',
    source: 'rule',
  }));
  const flagItems: AttentionItem[] = [...ruleItems, ...recItems];

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
    for (const arr of [upcoming, commitments, goingDark, decayed, hotIntent, flagItems]) {
      for (let i = arr.length - 1; i >= 0; i--) if (drop(arr[i].entity_id)) arr.splice(i, 1);
    }
  }

  // ── entity names — one batched claims query ─────────────────────────────────
  const ids = [...new Set([...upcoming, ...commitments, ...goingDark, ...decayed, ...hotIntent, ...flagItems].map(i => i.entity_id))];
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
    for (const it of hotIntent)   it.entity_name = nameOf(it.entity_id);
    for (const it of flagItems)   it.entity_name = nameOf(it.entity_id);
  }

  // Budget: upcoming meetings + your open commitments lead (both time/action-
  // critical), then split the rest between going-dark and decayed facts.
  // Upcoming calls are the most time-critical, then "reach out now" hot intent,
  // then your open commitments — all three lead. Hot intent is capped so a big
  // batch of warm accounts can't crowd out meetings/commitments.
  const leadShown = [...flagItems.slice(0, 15), ...upcoming, ...hotIntent.slice(0, 12), ...commitments].slice(0, limit);
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
      hot_intent: hotIntent.length,
      flags: flagItems.length,
    },
  };
}
