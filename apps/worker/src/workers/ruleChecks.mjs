// Rules, checked in the background (GET-846).
//
// A rep's checked rules (ri_rules, kind 'checked') are evaluated hourly against what the graph
// holds. A broken rule becomes, on the account:
//   • a flag, flag_type 'rule:<rule id>', owned by the rep and ranked by the rule's weight and how
//     late it is — so it leads `query(attention:'mine')`, `attention` and the worklist;
//   • a task, action_item.rule_<…>, one per broken instance (this meeting, this thread, this
//     stage), due now — on /v2/action-items and the MCP `tasks` tool on every plan.
// When the rule is met again the flag resolves and the task closes itself. A task someone closed
// stays closed. Nothing is written to the CRM (GET-352): rule tasks are not follow-up tasks, so
// the HubSpot task sync never sees them.
//
// The checks themselves are pure (packages/core services/ruleChecks.ts); this file loads the
// data they read and writes what they decide.

import { createHash } from 'node:crypto';
import {
  getSupabaseClient, listRules, rulePriority, RULE_CHECKS,
  upsertFlag, resolveFlagIfOpen, recordObservation, accountStage, normalizeStage, checkRule,
  getRelationshipOwners, effectiveOwnerUserId, getInternalEntityIds,
} from '@nous/core';

const DAY = 86_400_000;
const PAGE = 1000;
const MAX_ROWS = 20_000;
const RULE_TASK_PREFIX = 'action_item.rule_';

const short = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
/** The task a broken instance opens: stable per rule and instance, so it is written once. */
export const ruleTaskProperty = (ruleId, key) => `${RULE_TASK_PREFIX}${String(ruleId).slice(0, 8)}_${short(key)}`;

async function pages(build) {
  const out = [];
  for (let from = 0; out.length < MAX_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** person/company entity id → the account it belongs to (a person with no company is its own account). */
async function accountResolver(supabase, ids) {
  const map = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    // A failed read must stop the run: falling back to person ids would flag and task the wrong
    // entity, then resolve it next hour.
    const { data, error } = await supabase.from('contacts').select('id, company_id').in('id', list.slice(i, i + 200));
    if (error) throw new Error(`contacts: ${error.message}`);
    for (const c of data ?? []) map.set(c.id, c.company_id || c.id);
  }
  return (id) => map.get(id) ?? id;
}

/** relationship_owner for many entities, 200 at a time (one .in() of thousands overflows the URL). */
async function ownersOf(supabase, workspaceId, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const part = await getRelationshipOwners(supabase, workspaceId, list.slice(i, i + 200));
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}

/** Everything the workspace's checked rules read, for the rules' owners only. */
export async function loadRuleData(supabase, workspaceId, rules, now = Date.now(), deps = {}) {
  const owners = [...new Set(rules.map((r) => r.user_id).filter(Boolean))];
  const types = new Set(rules.map((r) => r.check_type));
  const maxDays = Math.max(30, ...rules.filter((r) => r.check_type === 'stage_without_meeting').map((r) => Number(r.params?.days) || RULE_CHECKS.stage_without_meeting.default));
  const since = new Date(now - maxDays * DAY).toISOString();
  const data = { meetings: [], tasks: [], bookings: [], inbound: [], outbound: [], accounts: [] };
  if (!owners.length) return data;

  // Our own people: a teammate on a call is not the buyer. Fireflies and the rest log a meeting
  // row for every attendee, teammates included, and a teammate resolves to our own company — so
  // without this every internal call would open a flag on ourselves.
  const internal = await (deps.getInternalEntityIds ?? getInternalEntityIds)(supabase, workspaceId);
  const external = (r) => !internal.has(r.entity_id);

  const events = (properties, columns, narrow = (q) => q) => pages(() => narrow(supabase.from('observations').select(columns)
    .eq('workspace_id', workspaceId).eq('kind', 'event').in('property', properties)
    .gte('observed_at', since)).order('observed_at', { ascending: false }));

  const needMeetings = types.has('next_step_after_meeting') || types.has('stage_without_meeting');
  const meetingRows = needMeetings
    ? (await events(['interaction.meeting_held'], 'entity_id, observed_at, owner_user_id, value')).filter(external) : [];
  const bookingRows = types.has('next_step_after_meeting')
    ? (await events(['interaction.meeting_scheduled', 'interaction.meeting_booked'], 'entity_id, observed_at')).filter(external) : [];
  const emailCols = 'entity_id, property, observed_at, owner_user_id, thread_id:raw->>thread_id, subject:raw->>subject';
  // Buyer emails to the rule's owner; replies from anyone's mailbox (a team thread is filed once,
  // under whichever mailbox was read first).
  const inboundRows = types.has('reply_to_buyer_email')
    ? (await events(['interaction.email_received'], emailCols, (q) => q.in('owner_user_id', owners))).filter(external) : [];
  const outboundRows = types.has('reply_to_buyer_email')
    ? (await events(['interaction.email_sent'], emailCols)).filter(external) : [];

  const accountOf = await accountResolver(supabase, [...meetingRows, ...bookingRows, ...inboundRows, ...outboundRows].map((r) => r.entity_id));

  for (const m of meetingRows) {
    const account = accountOf(m.entity_id);
    const title = String(m.value?.description ?? '').replace(/^meeting:\s*/i, '').trim();
    // One meeting is one row per attendee, and a calendar sync and a note-taker date the same call
    // minutes apart: the account and the hour name it.
    data.meetings.push({ account_id: account, key: `${account}:${String(m.observed_at).slice(0, 13)}`, at: m.observed_at, owner_user_id: m.owner_user_id ?? null, title: title && title.length <= 80 ? title : null });
  }
  for (const b of bookingRows) data.bookings.push({ account_id: accountOf(b.entity_id), at: b.observed_at });
  for (const e of inboundRows) {
    if (!e.thread_id) continue;
    data.inbound.push({ account_id: accountOf(e.entity_id), thread_id: e.thread_id, at: e.observed_at, owner_user_id: e.owner_user_id ?? null, subject: e.subject ?? null });
  }
  for (const e of outboundRows) data.outbound.push({ account_id: accountOf(e.entity_id), thread_id: e.thread_id ?? null, at: e.observed_at });

  // Dated next steps: every action item on the accounts (and their people) the meetings touched,
  // dated by when it was said. A rule's OWN task is left out, or the task opened for "no dated next
  // step" would itself be the dated next step and close the rule it was opened for.
  if (types.has('next_step_after_meeting') && meetingRows.length) {
    const ids = [...new Set(meetingRows.flatMap((m) => [m.entity_id, accountOf(m.entity_id)]))];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: rows, error } = await supabase.from('claims')
        .select('entity_id, property, value, valid_from, last_observed_at')
        .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 100))
        .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null).limit(2000);
      // No tasks read is not "no tasks": every meeting would look broken and get a task.
      if (error) throw new Error(`action items: ${error.message}`);
      for (const r of rows ?? []) {
        if (r.property.startsWith(RULE_TASK_PREFIX) || r.property.startsWith('action_item.internal_')) continue;
        data.tasks.push({ account_id: accountOf(r.entity_id), occurred_at: r.valid_from ?? r.last_observed_at ?? null, due_at: r.value?.due_at ?? null });
      }
    }
  }

  // Deals sitting in a stage. The account's stage is its furthest person (accountStage). When it
  // ENTERED that stage comes from the stage history, not the claim's last observation (a CRM sync
  // re-observes the same stage every night). The owner is the account's own relationship_owner,
  // else the one most of its people carry (ingest writes it on the person).
  if (types.has('stage_without_meeting')) {
    const stageRows = (await pages(() => supabase.from('claims').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('property', 'pipeline_stage').is('invalid_at', null).order('entity_id')))
      .filter(external);
    const stageOf = await accountResolver(supabase, stageRows.map((r) => r.entity_id));
    const byAccount = new Map();
    for (const r of stageRows) {
      const stage = normalizeStage(typeof r.value === 'string' ? r.value : r.value?.stage ?? r.value?.value);
      if (!stage) continue;
      const a = stageOf(r.entity_id);
      byAccount.set(a, [...(byAccount.get(a) ?? []), { entity_id: r.entity_id, stage }]);
    }
    const accountIds = [...byAccount.keys()];
    const personIds = [...byAccount.values()].flat().map((p) => p.entity_id);
    const rel = deps.owners ? deps.owners([...accountIds, ...personIds]) : await ownersOf(supabase, workspaceId, [...accountIds, ...personIds]);
    const ownerOfAccount = (account, people) => {
      const own = effectiveOwnerUserId(rel.get(account));
      if (own) return own;
      const tally = new Map();
      for (const p of people) { const o = effectiveOwnerUserId(rel.get(p.entity_id)); if (o) tally.set(o, (tally.get(o) ?? 0) + 1); }
      return [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    };
    const mine = [];
    for (const [account, people] of byAccount) {
      const owner = ownerOfAccount(account, people);
      if (owner && owners.includes(owner)) mine.push({ account, people, owner, stage: accountStage(people.map((p) => p.stage)) });
    }
    // When each person at the account's stage entered it: the start of the latest unbroken run of
    // that stage in their pipeline_stage history.
    const entered = new Map();
    const want = mine.flatMap((m) => m.people.filter((p) => p.stage === m.stage).map((p) => p.entity_id));
    for (let i = 0; i < want.length; i += 100) {
      const { data: hist, error } = await supabase.from('observations').select('entity_id, value, observed_at')
        .eq('workspace_id', workspaceId).eq('property', 'pipeline_stage').in('entity_id', want.slice(i, i + 100))
        .order('observed_at', { ascending: true }).limit(5000);
      if (error) throw new Error(`stage history: ${error.message}`);
      const runs = new Map();
      for (const h of hist ?? []) {
        const st = normalizeStage(typeof h.value === 'string' ? h.value : h.value?.stage ?? h.value?.value);
        const cur = runs.get(h.entity_id);
        if (!cur || cur.stage !== st) runs.set(h.entity_id, { stage: st, since: h.observed_at });
      }
      for (const [id, r] of runs) entered.set(id, r);
    }
    const lastMeeting = new Map();
    for (const m of data.meetings) if (!lastMeeting.has(m.account_id) || m.at > lastMeeting.get(m.account_id)) lastMeeting.set(m.account_id, m.at);
    const names = new Map();
    const ids = mine.map((m) => m.account);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: rows, error } = await supabase.from('companies').select('id, name').in('id', ids.slice(i, i + 200));
      if (error) throw new Error(`companies: ${error.message}`);
      for (const c of rows ?? []) names.set(c.id, c.name);
    }
    for (const m of mine) {
      const since_ = m.people.filter((p) => p.stage === m.stage)
        .map((p) => entered.get(p.entity_id)).filter((r) => r && r.stage === m.stage).map((r) => r.since).sort()[0] ?? null;
      data.accounts.push({ account_id: m.account, name: names.get(m.account) ?? null, stage: m.stage, stage_entered_at: since_, last_meeting_at: lastMeeting.get(m.account) ?? null, owner_user_id: m.owner });
    }
  }
  return data;
}

/** Evaluate one workspace's rules and write the flags and tasks they decide. */
export async function checkWorkspaceRules(supabase, workspaceId, { now = Date.now(), deps = {} } = {}) {
  const raise = deps.upsertFlag ?? upsertFlag;
  const clear = deps.resolveFlagIfOpen ?? resolveFlagIfOpen;
  const record = deps.recordObservation ?? recordObservation;
  const rules = await (deps.listRules ?? listRules)(supabase, workspaceId, { includePaused: false, checkedOnly: true });
  const data = rules.length ? await (deps.loadRuleData ?? loadRuleData)(supabase, workspaceId, rules, now) : null;
  const stats = { rules: rules.length, broken: 0, flags: 0, tasks_opened: 0, flags_resolved: 0, tasks_closed: 0 };

  // Broken instances, grouped per rule and account: one flag each, one task per instance.
  const liveFlags = new Set();
  const liveTasks = new Set();
  const metKeys = new Set();
  for (const rule of rules) {
    const { broken: violations, met } = checkRule(rule, data, now);
    for (const k of met) metKeys.add(`${rule.id}|${k}`);
    stats.broken += violations.length;
    const byAccount = new Map();
    for (const v of violations) byAccount.set(v.account_id, [...(byAccount.get(v.account_id) ?? []), v]);
    for (const [account, vs] of byAccount) {
      vs.sort((a, b) => b.overdue_hours - a.overdue_hours);
      const worst = vs[0];
      const flagType = `rule:${rule.id}`;
      liveFlags.add(`${account}|${flagType}`);
      const flag = await raise(supabase, workspaceId, {
        entityId: account, flagType, source: 'rule', ownerUserId: rule.user_id,
        reason: vs.length > 1 ? `${worst.reason} (+${vs.length - 1} more)` : worst.reason,
        priority: rulePriority(rule.weight, worst.overdue_hours),
        evidence: { rule_id: rule.id, statement: rule.statement, check: rule.check_type, broken: vs.map((v) => ({ key: v.key, due_at: v.due_at, overdue_hours: v.overdue_hours, ...v.evidence })) },
      }).catch((e) => { console.warn(`[RULES] ${workspaceId} flag ${flagType}:`, e?.message || e); return null; });
      if (flag) stats.flags++;
      for (const v of vs) {
        const property = ruleTaskProperty(rule.id, v.key);
        liveTasks.add(`${account}|${property}`);
        // Written once. A task already there — open, or closed by the rep — is left as it is.
        const { data: existing } = await supabase.from('claims').select('id').eq('workspace_id', workspaceId)
          .eq('entity_id', account).eq('property', property).is('invalid_at', null).limit(1);
        if (existing?.length) continue;
        const rec = await record(supabase, {
          workspaceId, entityId: account, kind: 'state', property,
          value: {
            title: v.task, owner_kind: 'user', owner_name: null, status: 'open',
            due_phrase: null, due_at: new Date(now).toISOString(),
            source_type: 'rule', source_id: rule.id, rule_id: rule.id, rule_key: v.key,
            reason: v.reason, owner_user_id: rule.user_id,
          },
          source: 'rule', method: 'inference', observedAt: new Date(now).toISOString(),
          externalId: property.replace('.', '_'),
        }).catch((e) => { console.warn(`[RULES] ${workspaceId} task:`, e?.message || e); return null; });
        if (rec) stats.tasks_opened++;
      }
    }
  }

  // Met again (or the rule was paused or removed): resolve its flags, close its open tasks.
  const { data: openFlags } = await supabase.from('flags').select('entity_id, flag_type')
    .eq('workspace_id', workspaceId).like('flag_type', 'rule:%').eq('status', 'open');
  for (const f of openFlags ?? []) {
    if (liveFlags.has(`${f.entity_id}|${f.flag_type}`)) continue;
    await clear(supabase, workspaceId, f.entity_id, f.flag_type).catch(() => {});
    stats.flags_resolved++;
  }
  const openTasks = await pages(() => supabase.from('claims').select('id, entity_id, property, value')
    .eq('workspace_id', workspaceId).like('property', `${RULE_TASK_PREFIX}%`).is('invalid_at', null).eq('value->>status', 'open'));
  const at = new Date(now).toISOString();
  const activeRules = new Set(rules.map((r) => r.id));
  for (const t of openTasks) {
    if (liveTasks.has(`${t.entity_id}|${t.property}`)) continue;
    // Say why it closed, truthfully: only an instance checked and passing is "met". One that aged
    // out of the window was never met, and a paused or removed rule simply stopped asking.
    const why = !activeRules.has(t.value?.rule_id) ? 'your rule was paused or removed'
      : metKeys.has(`${t.value?.rule_id}|${t.value?.rule_key}`) ? 'your rule is met'
      : 'no longer checked: older than the rule looks back';
    const { error } = await supabase.from('claims').update({
      value: { ...t.value, status: 'done', completed_at: at, completed_reason: why, completed_by: 'rule' },
    }).eq('id', t.id).eq('workspace_id', workspaceId);
    if (!error) stats.tasks_closed++;
  }
  return stats;
}

/** Every workspace with a checked rule, or a rule flag still open (a rule paused since). */
export async function runRuleChecks({ now = Date.now() } = {}) {
  const supabase = getSupabaseClient();
  const { data: ruleWs } = await supabase.from('ri_rules').select('workspace_id')
    .eq('kind', 'checked').eq('status', 'active').is('removed_at', null).limit(5000);
  const { data: flagWs } = await supabase.from('flags').select('workspace_id')
    .like('flag_type', 'rule:%').eq('status', 'open').limit(5000);
  const workspaces = [...new Set([...(ruleWs ?? []), ...(flagWs ?? [])].map((r) => r.workspace_id))];
  for (const ws of workspaces) {
    try {
      const stats = await checkWorkspaceRules(supabase, ws, { now });
      console.log(`[RULES] ${ws} ${JSON.stringify(stats)}`);
    } catch (e) { console.error(`[RULES] ${ws} failed:`, e?.message || e); }
  }
}
