// /v2/rev-plays — RevPlays for agents (GET-1087), and the MCP `rev_plays` tool's door.
//
// A RevPlay is an agent_routines row, the same one /v2/workflows and the Rev Plays page write. This
// adds what an agent needs on top: the templates, the plan's limit counted the way the app counts it
// (every RevPlay, on or off), and a refusal in words for anything that would save and never deliver.
//
//   GET   /v2/rev-plays/templates        the templates, each saying whether this workspace can create it
//   GET   /v2/rev-plays                  the caller's RevPlays (a member's own; an admin's whole workspace)
//   POST  /v2/rev-plays                  { template, to?, name?, enabled? } or { trigger, steps, name?, enabled? }
//   PATCH /v2/rev-plays/:id              { enabled }
//   DELETE /v2/rev-plays/:id             removes it and its run history, and frees its slot
//   POST  /v2/rev-plays/:id/test         runs it once on its latest real trigger, sending nothing
//   GET   /v2/rev-plays/:id/runs/:runId  that run, step by step
//
// A RevPlay runs as a person, so every call but the templates needs one: a member key, which acts as
// that member. A workspace key (no person, GET-248) is refused: a RevPlay writes account content
// and sends it on. Any member may make a personal one, on a closed workspace too: it fires only on
// what its owner may see. Only an admin shares one with the team, and a shared one is read-only to
// everyone else (lib/routineVisibility.mjs).
import { Router } from 'express';
import { getSupabaseClient, revPlayTemplateById, listRevPlayTemplates, agentColumnsOf, startTestRun, getAutomationRun } from '@nous/core';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { allowQueryParams } from '../../lib/v2Query.mjs';
import { isApiTier, planName, requireAiCredits } from '../../lib/plans.mjs';
import { isMissingFlowColumn } from '../../lib/flows.mjs';
import { onlyOrdinaryRoutines, ownerColumnMissing } from '../../lib/routineAccess.mjs';
import {
  insertFlow, automationLimitHit, routinesInPool, workspaceAutomationLimit, LIVE_TRIGGERS, NEEDS_MIGRATION,
} from '../api/automations.mjs';
import {
  buildColumns, loadEditable, loadOwned, stepsIn, triggerIn, withTriggerTools, workflowOut, workflowSummary,
} from './workflows.mjs';
import { PERSONAL, SHARED, createVisibility, viewerOf, visibilityChange, visibilityFields } from '../../lib/routineVisibility.mjs';

export const revPlaysV2Router = Router();

const CREATE_FIELDS = ['template', 'to', 'name', 'trigger', 'steps', 'enabled', 'visibility'];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MEETING_TOOLS = ['fireflies', 'granola', 'fathom', 'fellow', 'ringcentral', 'otter', 'zoom'];
// A trigger nothing fires yet, and the webhook event that does cover the moment, where there is one.
const WEBHOOK_INSTEAD = { deal_stalled: 'deal.stalled', expansion_signal: 'account.expansion_requested' };

const emailStep = (flow) => flow.steps.find(s => s.type === 'email');

/** Where a template's first send is left blank for the user to fill in. Pure. */
const needsTo = (flow) => { const s = emailStep(flow); return !!s && !String(s.config?.to ?? '').trim(); };

/** Why this workspace cannot create a template, or null. Pure. */
export function templateRefusal(t, { apiTier }) {
  const kind = t.flow.trigger.kind;
  // On the Workspace plan OpenNous runs the defaults itself. The API plan runs none, so a default
  // with a live trigger is one more thing it can have.
  if (t.byDefault && !apiTier) return { error: 'runs_by_default', message: `${t.name} already runs for this workspace.` };
  if (!LIVE_TRIGGERS.has(kind)) {
    const instead = WEBHOOK_INSTEAD[kind];
    return { error: 'trigger_not_live', message: `Nothing fires ${t.name} as a RevPlay yet.${instead ? ` Subscribe a webhook to ${instead} instead.` : ''}`, ...(instead ? { webhook_event: instead } : {}) };
  }
  return null;
}

/** A template as an agent reads it. Pure. */
export function templateView(t, { apiTier }) {
  const refusal = templateRefusal(t, { apiTier });
  const needs = [...new Set((t.tools ?? []).filter(x => x.slug).map(x => (MEETING_TOOLS.includes(x.slug) ? 'notetaker' : x.slug)))];
  return {
    id: t.id, name: t.name, does: t.does, group: t.group,
    trigger: t.flow.trigger.kind, steps: t.flow.steps.map(s => s.type), needs, needs_to: needsTo(t.flow),
    available: !refusal, ...(refusal ? { why_not: refusal.message, ...(refusal.webhook_event ? { webhook_event: refusal.webhook_event } : {}) } : {}),
  };
}

/** The addresses in `to`, first as To and the rest as Cc, or null when one is not an address. Pure. */
export function parseTo(raw) {
  const all = String(raw ?? '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  return all.length && all.every(a => EMAIL.test(a)) ? { to: all[0], cc: all.slice(1).join(', ') } : null;
}

/**
 * The flow to save from a template, or `{ fail }`. An Approval step with nothing after it but a Gmail
 * draft comes out on the API plan: a draft waits in Gmail anyway, and that plan's app has no approvals
 * inbox, so the draft would sit behind a review nobody sees. Pure.
 */
export function flowFromTemplate(t, { apiTier, to = null }) {
  const refusal = templateRefusal(t, { apiTier });
  if (refusal) return { fail: { status: 409, body: refusal } };
  let steps = t.flow.steps;
  if (needsTo(t.flow)) {
    const people = parseTo(to);
    if (!people) return { fail: { status: 400, body: { error: 'to_required', message: `${t.name} emails its result. Pass \`to\`: who gets it (an address, or several separated by commas).` } } };
    steps = steps.map(s => (s === emailStep(t.flow) ? { ...s, config: { ...s.config, ...people } } : s));
  }
  if (apiTier) {
    steps = steps.filter((s, i) => s.type !== 'approval'
      || !steps.slice(i + 1).every(x => x.type === 'gmail' && x.config?.mode === 'draft'));
  }
  return { flow: { ...t.flow, steps } };
}

/** Why a custom flow would save and never deliver, or null (GET-1087). Pure. */
export function customRefusal({ when, steps }, { slack }) {
  if (!LIVE_TRIGGERS.has(when)) {
    const instead = WEBHOOK_INSTEAD[when];
    return { status: 409, body: { error: 'trigger_not_live', trigger: when, live: [...LIVE_TRIGGERS].filter(k => k !== 'before_meeting'),
      message: `Nothing fires ${when} yet.${instead ? ` Subscribe a webhook to ${instead} instead.` : ''}`, ...(instead ? { webhook_event: instead } : {}) } };
  }
  // The routine runner gives a meeting to the in-app agent, not to the steps, so its delivery steps
  // never run and what it writes lands in a thread the API plan cannot open.
  if (when === 'before_meeting') {
    return { status: 409, body: { error: 'trigger_not_available', trigger: when, message: 'A RevPlay cannot deliver before a meeting yet. Use a clock trigger, or a webhook on interaction.meeting_scheduled.' } };
  }
  // The same runner takes a schedule with nothing but an AI step: it would write where nobody reads.
  if (when === 'clock' && !steps.some(s => s?.type !== 'agent')) {
    return { status: 400, body: { error: 'needs_delivery', message: 'A scheduled RevPlay needs a step that delivers: email, gmail, webhook or hubspot.' } };
  }
  if (steps.some(s => s?.type === 'slack') && !slack) {
    return { status: 402, body: { error: 'slack_not_in_plan', message: 'Slack is on the Workspace plan. Deliver by email, Gmail draft, webhook or HubSpot.', upgrade_url: '/settings?section=billing' } };
  }
  return null;
}

/** The 402 at the plan's limit, in the words an agent repeats to the user. Pure. */
export function revPlayLimitBody(planId, limit, { personal = false } = {}) {
  const whose = personal ? 'personal ' : 'shared ';
  return {
    error: 'automation_limit_reached', limit, current_plan: planName(planId),
    message: limit === 0
      ? 'RevPlays need an active plan.'
      : `This plan includes ${limit} ${whose}RevPlay${limit === 1 ? '' : 's'}, on or off, and ${limit === 1 ? 'it is' : 'all are'} in use. Delete one, or upgrade.`,
    upgrade_url: '/settings?section=billing',
  };
}

/** What will stop a new RevPlay delivering until the user connects something. Pure. */
export function connectionWarnings({ when, steps }, connected) {
  const has = (slug) => connected.includes(slug);
  const out = [];
  if (steps.some(s => s?.type === 'hubspot') && !has('hubspot')) out.push("HubSpot isn't connected, so the HubSpot step will stop the run.");
  if (steps.some(s => s?.type === 'gmail') && !has('gmail')) out.push("Gmail isn't connected, so the Gmail step will stop the run.");
  if (when === 'call_ended' && !MEETING_TOOLS.some(has)) out.push('No notetaker is connected, so no call will trigger this yet.');
  if (when === 'posthog_event' && !has('posthog')) out.push("PostHog isn't connected, so no event will trigger this yet.");
  if (steps.some(s => s?.type === 'wait')) out.push("A wait step is saved but doesn't run yet.");
  return out;
}

async function connectedSlugs(supabase, workspaceId) {
  const { data: conns } = await supabase.from('workflow_provider_connections').select('provider_id').eq('workspace_id', workspaceId);
  const ids = [...new Set((conns ?? []).map(c => c.provider_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: provs } = await supabase.from('workflow_providers').select('name').in('id', ids);
  return [...new Set((provs ?? []).map(p => String(p.name ?? '').toLowerCase().replace(/_oauth$/, '')))];
}


// The person, as /v2/rules asks for one.
const needPerson = (req, res) => {
  const user = req.workspaceId && !req.noContent ? req.memberUserId ?? null : null;
  if (!user) res.status(400).json({ error: 'member_required', message: 'A RevPlay runs as a person: use a member API key.' });
  return user;
};
const notFound = (res) => res.status(404).json({ error: 'rev_play_not_found' });
const wrap = (label, fn) => async (req, res) => {
  try { return await fn(req, res, getSupabaseClient()); }
  catch (err) {
    console.error(`[${label}]`, err);
    if (!res.headersSent) return res.status(500).json({ error: 'internal_error' });
  }
};

revPlaysV2Router.get('/templates', allowQueryParams([]), wrap('GET /v2/rev-plays/templates', async (req, res) => {
  const { plan } = await resolveTeamAndPlan(req);
  const apiTier = isApiTier(plan);
  return res.json({ templates: listRevPlayTemplates().map(t => templateView(t, { apiTier })) });
}));

revPlaysV2Router.get('/', allowQueryParams([]), wrap('GET /v2/rev-plays', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const { plan } = await resolveTeamAndPlan(req);
  const viewer = viewerOf(req);
  const list = (narrow) => {
    let q = supabase.from('agent_routines').select('*').eq('workspace_id', req.workspaceId);
    if (narrow) q = onlyOrdinaryRoutines(q);
    q = q.or(`visibility.neq.personal,user_id.eq.${user}`);
    return q.order('created_at', { ascending: true }).order('id', { ascending: true });
  };
  let { data, error } = await list(true);
  if (error && ownerColumnMissing(error)) ({ data, error } = await list(false));
  if (error) throw error;
  return res.json({
    rev_plays: (data ?? []).map(r => ({ ...workflowSummary(r), ...visibilityFields(r, viewer) })),
    // A pool each: the person's own, and the team's shared ones.
    plan: planName(plan.id), limit: workspaceAutomationLimit(req.workspaceId, plan.id),
    used: await routinesInPool(supabase, req.workspaceId, { personalOf: user }),
    used_shared: await routinesInPool(supabase, req.workspaceId),
  });
}));

revPlaysV2Router.post('/', allowQueryParams([]), wrap('POST /v2/rev-plays', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const body = req.body || {};
  const extra = Object.keys(body).filter(k => !CREATE_FIELDS.includes(k));
  if (extra.length) return res.status(400).json({ error: 'unknown_field', detail: `unsupported field(s): ${extra.join(', ')}`, supported: CREATE_FIELDS });
  if (body.template != null && (body.trigger != null || body.steps != null)) return res.status(400).json({ error: 'template_or_custom', message: 'Pass a template, or a trigger and steps, not both.' });
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'invalid_enabled', message: 'enabled must be true or false.' });
  if (body.name !== undefined && typeof body.name !== 'string') return res.status(400).json({ error: 'invalid_name', message: 'name must be a string.' });

  const viewer = viewerOf(req);
  const placed = createVisibility(body.visibility, viewer);
  if (placed.fail) return res.status(placed.fail.status).json(placed.fail.body);

  const { plan } = await resolveTeamAndPlan(req);
  const apiTier = isApiTier(plan);
  let name = body.name, trig, steps;
  if (body.template != null) {
    const t = revPlayTemplateById(String(body.template));
    if (!t) return res.status(404).json({ error: 'template_not_found', message: 'List them with GET /v2/rev-plays/templates.' });
    const built = flowFromTemplate(t, { apiTier, to: body.to });
    if (built.fail) return res.status(built.fail.status).json(built.fail.body);
    trig = { when: built.flow.trigger.kind, trigger_config: built.flow.trigger.config };
    steps = built.flow.steps;
    name ??= t.name;
  } else {
    trig = triggerIn(body.trigger);
    if (!trig || !Array.isArray(body.steps)) return res.status(400).json({ error: 'template_or_custom', message: 'Pass a template, or a trigger { type, ... } and steps [{ type, ... }].' });
    steps = stepsIn(body.steps);
  }

  const connected = await connectedSlugs(supabase, req.workspaceId);
  if (body.template == null) {
    const refused = customRefusal({ when: trig.when, steps }, { slack: !!plan.features?.slack || connected.includes('slack') });
    if (refused) return res.status(refused.status).json(refused.body);
  }
  const t = await withTriggerTools(supabase, req.workspaceId, trig);
  const cols = buildColumns(res, { when: t.when, trigger_config: t.trigger_config, steps, ...agentColumnsOf(steps) }, plan);
  if (!cols) return;

  // Counted over every RevPlay, on or off, as the app counts it: one created switched off still fills a slot.
  const personalOf = placed.visibility === PERSONAL ? user : null;
  const hit = await automationLimitHit(supabase, req.workspaceId, plan.id, { personalOf });
  if (hit !== null) return res.status(402).json(revPlayLimitBody(plan.id, hit, { personal: !!personalOf }));

  const { data, error } = await insertFlow(supabase, {
    workspaceId: req.workspaceId, userId: user, name: name ?? 'RevPlay', cols, enabled: body.enabled ?? true, visibility: placed.visibility,
  });
  if (error && isMissingFlowColumn(error)) return res.status(409).json(NEEDS_MIGRATION);
  if (error) throw error;
  return res.status(201).json({ rev_play: { ...workflowOut(data), ...visibilityFields(data, viewer) }, warnings: connectionWarnings({ when: t.when, steps }, connected) });
}));

revPlaysV2Router.patch('/:id', allowQueryParams([]), wrap('PATCH /v2/rev-plays/:id', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const { enabled, visibility } = req.body ?? {};
  const keys = Object.keys(req.body ?? {});
  if (keys.length !== 1 || (keys[0] === 'enabled' ? typeof enabled !== 'boolean' : keys[0] !== 'visibility')) return res.status(400).json({ error: 'enabled_required', message: 'Pass { enabled: true | false }, or { visibility } to share one.' });
  const row = await loadEditable(supabase, req, res, notFound);
  if (!row) return;
  if (visibility !== undefined) {
    const refused = visibilityChange(row, visibility, viewerOf(req));
    if (refused) return res.status(refused.status).json(refused.body);
  }
  if (enabled || visibility === SHARED) {
    const personal = (visibility ?? row.visibility) === PERSONAL;
    const { plan } = await resolveTeamAndPlan(req);
    const hit = await automationLimitHit(supabase, req.workspaceId, plan.id, { excludeId: row.id, personalOf: personal ? row.user_id : null });
    if (hit !== null) return res.status(402).json(revPlayLimitBody(plan.id, hit, { personal }));
  }
  const { data, error } = await supabase.from('agent_routines')
    .update({ ...(visibility !== undefined ? { visibility } : { enabled }), updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('workspace_id', req.workspaceId).select('*').single();
  if (error) throw error;
  return res.json({ rev_play: workflowSummary(data) });
}));

// A disabled RevPlay still fills a slot, as the app counts it, so this is how one is freed. Its run
// history goes with it, as it does from the app's own delete (agent_routine_runs cascades).
revPlaysV2Router.delete('/:id', allowQueryParams([]), wrap('DELETE /v2/rev-plays/:id', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const row = await loadEditable(supabase, req, res, notFound);
  if (!row) return;
  const { error } = await supabase.from('agent_routines').delete().eq('id', row.id).eq('workspace_id', req.workspaceId);
  if (error) throw error;
  return res.json({ deleted: true, id: row.id });
}));

// One run on the latest real trigger, with every send held: it writes, and shows what it would send.
revPlaysV2Router.post('/:id/test', allowQueryParams([]), wrap('POST /v2/rev-plays/:id/test', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const row = await loadEditable(supabase, req, res, notFound);
  if (!row) return;
  const gate = await requireAiCredits(supabase, req.workspaceId);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const out = await startTestRun(supabase, req.workspaceId, row.id, { holdSends: true, startedByKey: req.apiKeyId ?? null });
  if (!out.ok) return res.status(409).json(out);
  return res.status(202).json({ run_id: out.run_id, trigger: out.trigger, sends_held: true });
}));

revPlaysV2Router.get('/:id/runs/:runId', allowQueryParams([]), wrap('GET /v2/rev-plays/:id/runs/:runId', async (req, res, supabase) => {
  const user = needPerson(req, res); if (!user) return;
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const run = await getAutomationRun(supabase, req.workspaceId, req.params.runId);
  if (!run || run.automation?.id !== row.id) return res.status(404).json({ error: 'run_not_found' });
  return res.json({ run });
}));
