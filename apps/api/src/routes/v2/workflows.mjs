// /v2/workflows — the public API over the automation flows engine (GET-523).
//
// A workflow is an agent_routines row: a trigger, an ordered list of steps, a switch. The app's
// Automations page writes the same rows through routes/api/automations.mjs; everything that
// decides what a valid flow is, what a plan may run and how a flow is written lives there and in
// lib/flows.mjs, and is called from here — this file is the public shape, not a second engine.
//
// OWNERSHIP. Automations belong to the WORKSPACE in the app (one list, one plan limit, any member
// may edit any row); user_id on the row is who made it and who a run acts as. Over the API:
//   - an admin-scoped key sees and manages every workflow on the workspace;
//   - a member-scoped key sees and manages only the workflows whose user_id is its person, and
//     what it creates is theirs. Another member's workflow is a 404, not a 403.
// The plan's automation limit is per workspace either way (it counts every enabled row).
//
// WHAT RUNS TODAY. Steps are stored and validated; the runners execute the first agent step (as
// the artifact/prompt columns) and the first delivery step (as the destination columns). Deal
// triggers run in the daily automation poll; clock and before_meeting in the routine tick.
// Other triggers are saved but nothing fires them yet — GET /v2/workflows/triggers says which.

import { Router } from 'express';
import { getSupabaseClient, runAutomationsForWorkspace } from '@nous/core';
import { resolveTeamAndPlan, assertFeature } from '../../lib/access.mjs';
import { FLOW_TRIGGERS, STEP_TYPES, INTERNAL_STEP_TYPES, scheduleColumns } from '../../lib/flows.mjs';
import { allowQueryParams, parsePaging } from '../../lib/v2Query.mjs';
import {
  flowColumns, insertFlow, automationLimitHit, automationLimitBody, listAutomationRuns,
  LIVE_TRIGGERS, NEEDS_MIGRATION, RUN_STATUSES,
} from '../api/automations.mjs';
import { isMissingFlowColumn } from '../../lib/flows.mjs';
import { isBoxJob, missingBoxColumn } from '../../lib/boxJobAccess.mjs';

// Run-now on an agent workflow runs the in-app agent, which is Cloud's (cloud/lib/routineRunner.mjs).
// Cloud registers the runner at boot (GET-754); without it run-now answers 403 cloud_only_feature,
// which is what a self-hosted install already got from the plan gate.
let routineRunner = null;
export function registerRoutineRunner(fn) { routineRunner = fn; }

export const workflowsV2Router = Router();

// ── Shapes ──────────────────────────────────────────────────────────────────

const DEAL_TRIGGERS = new Set(['deal_closed_won', 'deal_closed_lost', 'deal_stage_changed']);
// Run now through the routine runner (an agent turn on the workflow's prompt): the triggers the
// app's own "run it now" covers, plus manual — "When I run it" has no other runner.
const AGENT_RUN_TRIGGERS = new Set(['clock', 'before_meeting', 'manual']);

export const STEP_DESCRIPTIONS = {
  agent: 'OpenNous writes something. { action } for a built-in: account_summary, call_summary, follow_up, premeeting_brief or deal_handoff ("Account summary" works too), with optional { instructions } added to it. Or { prompt } for your own instruction.',
  gmail: 'An email in your Gmail { to, subject?, body?, cc? }: drafted in the account owner\'s Gmail, sent only after someone approves it. No body: the email is what the previous AI step wrote. Use this for any email.',
  email: 'Send from a connected SMTP mailbox { send_from: { id }, to, subject?, body? }; always waits for approval. Without send_from it is made a gmail step.',
  hubspot: 'Write to HubSpot: { action: note | task | update_deal | update_contact | update_company, ... }. A note with no body writes what the AI step wrote.',
  slack: 'Post to a Slack channel { channel, text? }. No text: what the AI step wrote.',
  webhook: 'POST the result to a URL { url }.',
  only_if: 'Continue only when rules match { match, rules[] }.',
  wait: 'Wait a duration or for a reply { mode, amount, unit }. Saved; not run yet.',
  approval: 'Hold every send after this for a person to approve in Approvals.',
};

/** The trigger as the API shows it: { type, ...settings }, legacy columns folded in as the editor does. */
function triggerOut(r) {
  const tc = { ...(r.trigger_config ?? {}) };
  if (r.trigger_kind === 'clock') { tc.frequency ??= r.frequency ?? 'daily'; tc.at ??= String(r.at_time ?? '08:00').slice(0, 5); }
  if (r.trigger_kind === 'before_meeting') tc.offset ??= r.offset_minutes ?? 30;
  if (Array.isArray(r.tools) && r.tools.length) tc.tools ??= r.tools;
  return { type: r.trigger_kind, ...tc };
}

/** A row from before flows (no steps) as the [agent, send] it is — the editor's flowFromRow. */
function legacySteps(r) {
  const steps = [];
  if (r.artifact || r.prompt) {
    steps.push({ id: 'step_1', type: 'agent', config: { ...(r.artifact ? { artifact: r.artifact } : {}), ...(r.prompt ? { prompt: r.prompt } : {}) } });
  }
  const [to, ...cc] = String(r.destination_target ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const id = `step_${steps.length + 1}`;
  if (r.destination === 'slack') steps.push({ id, type: 'slack', config: { channel: to ?? '' } });
  if (r.destination === 'email') steps.push({ id, type: 'email', config: { to: to ?? '', cc: cc.join(', ') } });
  if (r.destination === 'webhook') steps.push({ id, type: 'webhook', config: { url: to ?? '' } });
  return steps;
}

const storedSteps = (r) => (Array.isArray(r.steps) && r.steps.length ? r.steps : legacySteps(r));
const stepOut = (s) => ({ id: s.id, type: s.type, ...(s.config ?? {}) });

function workflowSummary(r) {
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    trigger: triggerOut(r),
    steps_count: storedSteps(r).length,
    last_run_at: r.last_run_at ?? null,
    created_at: r.created_at ?? null,
  };
}

function workflowOut(r) {
  return {
    ...workflowSummary(r),
    steps: storedSteps(r).map(stepOut),
    owner_user_id: r.user_id ?? null,
    updated_at: r.updated_at ?? null,
    // The live version's number (GET-584); GET /v2/workflows/:id/versions lists them.
    version: r.version ?? 1,
    // What the current runners read (see the header): the first agent step and first delivery.
    artifact: r.artifact ?? null,
    prompt: r.prompt ?? null,
    destination: r.destination ?? 'none',
  };
}

const runOut = (r) => ({
  id: r.id, status: r.status, started_at: r.started_at, error: r.error,
  document_id: r.document_id, document_title: r.document_title, version: r.version ?? null,
});

// ── Input → the app's flow body ─────────────────────────────────────────────

const invalid = (res, reasons) => res.status(400).json({
  error: 'invalid_workflow',
  detail: reasons.map(r => r.message ?? r.code).join('; '),
  reasons,
});

/** Public steps [{ id?, type, ...settings }] → the engine's [{ id, type, config }]. */
function stepsIn(steps) {
  if (!Array.isArray(steps)) return steps;
  return normalizeSteps(steps.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
    const { id, type, config, ...settings } = s;
    const cfg = config && typeof config === 'object' && !Array.isArray(config) && !Object.keys(settings).length ? config : settings;
    return { id: id != null ? String(id) : `step_${i + 1}`, type, config: cfg };
  }));
}

// ── Steps the way the editor writes them (GET-748) ──────────────────────────
// An agent following these docs sent { artifact: 'account_summary' } and an `email` step with no
// body; the editor read them as "Pick an action" and an SMTP send with nothing to say. The API now
// writes the same shapes the editor does, so what an agent builds opens ready.

const JOB_IDS = ['account_summary', 'call_summary', 'follow_up', 'premeeting_brief', 'deal_handoff'];
const JOB_ALIASES = {
  account_summary: 'account_summary', summary_of_the_account: 'account_summary',
  call_summary: 'call_summary', summarize_the_call: 'call_summary', call_recap: 'call_summary',
  follow_up: 'follow_up', followup: 'follow_up', draft_follow_up: 'follow_up', follow_up_email: 'follow_up', follow_up_draft: 'follow_up',
  premeeting_brief: 'premeeting_brief', pre_meeting_brief: 'premeeting_brief', meeting_brief: 'premeeting_brief', brief: 'premeeting_brief',
  deal_handoff: 'deal_handoff', handoff: 'deal_handoff', cs_handoff: 'deal_handoff',
};
const JOB_ARTIFACT = { account_summary: 'account_summary', call_summary: 'call_summary' };

/** "Account summary", "account-summary", "ACCOUNT_SUMMARY" → account_summary. Pure. */
export function jobOf(v) {
  const k = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return JOB_ALIASES[k] ?? (JOB_IDS.includes(k) ? k : null);
}

/** The editor's step shapes, from what an API caller sends. Pure. */
export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return steps;
  const out = [];
  let lastAgent = null;
  const aiOutput = () => (lastAgent ? `{{steps.${lastAgent}.output}}` : '');
  const text = (v) => (typeof v === 'string' ? v : '');
  for (const s of steps) {
    if (!s || typeof s !== 'object' || typeof s.type !== 'string') { out.push(s); continue; }
    const c = { ...(s.config ?? {}) };
    if (s.type === 'agent') {
      const job = jobOf(c.action ?? c.job ?? c.artifact);
      const extra = text(c.instructions ?? c.extra).trim();
      const cfg = job
        ? { mode: 'pick', job, extra, model: c.model ?? 'opennous', ...(JOB_ARTIFACT[job] ? { artifact: JOB_ARTIFACT[job] } : {}) }
        : text(c.prompt).trim()
          ? { mode: 'write', job: null, prompt: text(c.prompt).trim(), extra: '', model: c.model ?? 'opennous' }
          : { ...c };
      out.push({ ...s, config: cfg });
      lastAgent = s.id;
      continue;
    }
    if (s.type === 'email' && !(c.send_from && typeof c.send_from === 'object' && c.send_from.id)) {
      // No SMTP mailbox: this is an email from your Gmail, drafted and sent after approval.
      out.push({ ...s, type: 'gmail', config: { mode: 'draft', to: text(c.to), cc: text(c.cc), subject: text(c.subject), body: text(c.body).trim() || aiOutput() } });
      continue;
    }
    if (s.type === 'gmail' || s.type === 'email') {
      out.push({ ...s, config: { ...c, ...(s.type === 'gmail' && !c.mode ? { mode: 'draft' } : {}), body: text(c.body).trim() || aiOutput() } });
      continue;
    }
    if (s.type === 'slack') { out.push({ ...s, config: { ...c, text: text(c.text).trim() || aiOutput() } }); continue; }
    out.push(s);
  }
  return out;
}

/** The workspace's CRM (hubspot, attio, salesforce), for a deal trigger that names no tool. */
async function workspaceCrm(supabase, workspaceId) {
  const { data } = await supabase.from('crm_sync_configs').select('provider').eq('workspace_id', workspaceId).limit(1);
  return data?.[0]?.provider ?? null;
}

/** A deal trigger with no tools runs on the CRM this workspace has connected (GET-748). */
async function withTriggerTools(supabase, workspaceId, trig) {
  if (!trig || !DEAL_TRIGGERS.has(trig.when)) return trig;
  const tools = trig.trigger_config?.tools;
  if (Array.isArray(tools) && tools.length) return trig;
  const crm = await workspaceCrm(supabase, workspaceId).catch(() => null);
  return crm ? { ...trig, trigger_config: { ...(trig.trigger_config ?? {}), tools: [crm] } } : trig;
}

/** The first agent step, as the artifact/prompt pair the runners read. */
function agentColumns(steps) {
  const a = (Array.isArray(steps) ? steps : []).find(s => s?.type === 'agent');
  const c = a?.config ?? {};
  return {
    artifact: typeof c.artifact === 'string' && c.artifact ? c.artifact : null,
    prompt: typeof c.prompt === 'string' && c.prompt.trim() ? c.prompt.trim() : null,
  };
}

function triggerIn(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger) || typeof trigger.type !== 'string' || !trigger.type) return null;
  const { type, ...settings } = trigger;
  return { when: type, trigger_config: settings };
}

/**
 * Build the row columns through the app's flowColumns. Returns { cols } or sends the error and
 * returns null. A plan refusal (artifact not in plan) keeps the app's 402; everything else that
 * makes a flow invalid is 400 invalid_workflow with the checker's reasons.
 */
function buildColumns(res, body, plan) {
  // A RevBox's delivery step belongs to RevBox jobs (GET-868); a public workflow has no box to deliver to.
  const internal = (Array.isArray(body?.steps) ? body.steps : []).find(s => INTERNAL_STEP_TYPES.has(s?.type));
  if (internal) { invalid(res, [{ code: 'unknown_step', step: internal.type, message: `Step type ${internal.type} is not available on the API.` }]); return null; }
  const built = flowColumns(body, plan);
  if (!built.fail) return built.cols;
  const { status, body: fail } = built.fail;
  if (status === 402) { res.status(402).json(fail); return null; }
  const { ok: _ok, error, message, ...rest } = fail;
  invalid(res, [{ code: error, ...(message ? { message } : {}), ...rest }]);
  return null;
}

const CREATE_FIELDS = ['name', 'trigger', 'steps', 'enabled'];
function unknownFields(body, allowed) {
  return Object.keys(body || {}).filter(k => !allowed.includes(k));
}

// ── Ownership ───────────────────────────────────────────────────────────────

const isMemberKey = (req) => req.viewerScope !== 'admin';

/**
 * The workflow this key may touch, or null (→ 404). A RevBox job (GET-868, a row with revbox_id) is
 * never one: it is managed only through the box, which checks the caller's access to it.
 */
async function loadOwned(supabase, req) {
  const { data } = await supabase.from('agent_routines')
    .select('*').eq('id', req.params.id).eq('workspace_id', req.workspaceId).maybeSingle();
  if (!data) return null;
  if (isBoxJob(data)) return null;
  if (isMemberKey(req) && data.user_id !== req.memberUserId) return null;
  return data;
}

const notFound = (res) => res.status(404).json({ error: 'workflow_not_found' });

const wrap = (label, fn) => async (req, res) => {
  try { return await fn(req, res, getSupabaseClient()); }
  catch (err) {
    console.error(`[${label}]`, err);
    if (!res.headersSent) return res.status(500).json({ error: 'internal_error' });
  }
};

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /v2/workflows/triggers — what a workflow can start on and what its steps can be.
workflowsV2Router.get('/triggers', allowQueryParams([]), (_req, res) => {
  res.json({
    triggers: FLOW_TRIGGERS.map(t => ({
      ...t,
      live: LIVE_TRIGGERS.has(t.key),
      runs_now: DEAL_TRIGGERS.has(t.key) || AGENT_RUN_TRIGGERS.has(t.key),
    })),
    step_types: [...STEP_TYPES].filter(type => !INTERNAL_STEP_TYPES.has(type)).map(type => ({ type, description: STEP_DESCRIPTIONS[type] ?? '' })),
  });
});

// GET /v2/workflows?enabled=&limit=&offset= → { workflows, limit, offset, has_more }
workflowsV2Router.get('/', allowQueryParams(['enabled', 'limit', 'offset']), wrap('GET /v2/workflows', async (req, res, supabase) => {
  const page = parsePaging(req.query);
  if (page.error) return res.status(400).json({ error: page.error });
  const { enabled } = req.query;
  if (enabled != null && !['true', 'false'].includes(String(enabled))) return res.status(400).json({ error: 'invalid_enabled', supported: ['true', 'false'] });

  const list = (boxColumn) => {
    let q = supabase.from('agent_routines').select('*').eq('workspace_id', req.workspaceId);
    // RevBox jobs are the box's, never listed here (GET-868).
    if (boxColumn) q = q.is('revbox_id', null);
    if (isMemberKey(req)) q = q.eq('user_id', req.memberUserId ?? '00000000-0000-0000-0000-000000000000');
    if (enabled != null) q = q.eq('enabled', String(enabled) === 'true');
    return q.order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(page.offset, page.offset + page.limit);
  };
  let { data, error } = await list(true);
  // Before the RevBox migration there is no revbox_id column, and so no box jobs.
  if (error && missingBoxColumn(error)) ({ data, error } = await list(false));
  if (error) throw error;
  const rows = data ?? [];
  const has_more = rows.length > page.limit;
  return res.json({ workflows: rows.slice(0, page.limit).map(workflowSummary), limit: page.limit, offset: page.offset, has_more });
}));

// POST /v2/workflows { name?, trigger: { type, ...settings }, steps: [{ type, ...settings }], enabled? = true }
// 201 { workflow }
workflowsV2Router.post('/', allowQueryParams([]), wrap('POST /v2/workflows', async (req, res, supabase) => {
  const body = req.body || {};
  const extra = unknownFields(body, CREATE_FIELDS);
  if (extra.length) return res.status(400).json({ error: 'unknown_field', detail: `unsupported field(s): ${extra.join(', ')}`, supported: CREATE_FIELDS });
  const reasons = [];
  const trig = triggerIn(body.trigger);
  if (!trig) reasons.push({ code: 'trigger_required', message: 'trigger must be an object with a type.' });
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') reasons.push({ code: 'invalid_enabled', message: 'enabled must be true or false.' });
  if (body.name !== undefined && typeof body.name !== 'string') reasons.push({ code: 'invalid_name', message: 'name must be a string.' });
  if (reasons.length) return invalid(res, reasons);

  const { plan } = await resolveTeamAndPlan(req);
  const steps = stepsIn(body.steps);
  const t = await withTriggerTools(supabase, req.workspaceId, trig);
  const cols = buildColumns(res, { when: t.when, trigger_config: t.trigger_config, steps, ...agentColumns(steps) }, plan);
  if (!cols) return;

  const enabled = body.enabled ?? true;
  if (enabled) {
    const hit = await automationLimitHit(supabase, req.workspaceId, plan.id);
    if (hit !== null) return res.status(402).json(automationLimitBody(plan.id, hit));
  }
  const { data, error } = await insertFlow(supabase, {
    workspaceId: req.workspaceId, userId: req.memberUserId ?? null, name: body.name ?? 'Workflow', cols, enabled,
  });
  if (error && isMissingFlowColumn(error)) return res.status(409).json(NEEDS_MIGRATION);
  if (error) throw error;
  return res.status(201).json({ workflow: workflowOut(data) });
}));

// GET /v2/workflows/:id → { workflow, recent_runs: [last 5] }
workflowsV2Router.get('/:id', allowQueryParams([]), wrap('GET /v2/workflows/:id', async (req, res, supabase) => {
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const { runs, stats } = await listAutomationRuns(supabase, req.workspaceId, { routines: [row.id], limit: 5 });
  return res.json({ workflow: workflowOut(row), recent_runs: runs.map(runOut), run_stats: { runs: stats.runs, failed: stats.failed, reports: stats.reports } });
}));

// GET /v2/workflows/:id/versions → { live, versions: [{ version, published_at, snapshot }] }
// Every change to a workflow's content is a numbered version (GET-584); a run records which.
workflowsV2Router.get('/:id/versions', allowQueryParams([]), wrap('GET /v2/workflows/:id/versions', async (req, res, supabase) => {
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const { data, error } = await supabase.from('automation_versions').select('version, published_at, snapshot')
    .eq('routine_id', row.id).eq('workspace_id', req.workspaceId).order('version', { ascending: false }).limit(100);
  if (error) throw error;
  return res.json({ live: row.version ?? 1, versions: data ?? [] });
}));

// PATCH /v2/workflows/:id { name?, trigger?, steps?, enabled? } → { workflow }
workflowsV2Router.patch('/:id', allowQueryParams([]), wrap('PATCH /v2/workflows/:id', async (req, res, supabase) => {
  const body = req.body || {};
  const extra = unknownFields(body, CREATE_FIELDS);
  if (extra.length) return res.status(400).json({ error: 'unknown_field', detail: `unsupported field(s): ${extra.join(', ')}`, supported: CREATE_FIELDS });
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);

  const reasons = [];
  if (body.trigger !== undefined && !triggerIn(body.trigger)) reasons.push({ code: 'trigger_required', message: 'trigger must be an object with a type.' });
  if (body.steps !== undefined && !Array.isArray(body.steps)) reasons.push({ code: 'invalid_steps', message: 'steps must be an array.' });
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') reasons.push({ code: 'invalid_enabled', message: 'enabled must be true or false.' });
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) reasons.push({ code: 'invalid_name', message: 'name must be a non-empty string.' });
  if (reasons.length) return invalid(res, reasons);

  const { plan } = await resolveTeamAndPlan(req);
  const patch = {};
  if (body.trigger !== undefined || body.steps !== undefined) {
    // The flow is rebuilt whole from what changed plus what the row already says, through the
    // same checker a new one passes — so a trigger change can never leave a schedule shape the
    // table refuses, and a steps change can never skip the plan's artifact check.
    const current = triggerOut(row);
    const trig = await withTriggerTools(supabase, req.workspaceId, body.trigger !== undefined ? triggerIn(body.trigger) : triggerIn(current));
    const steps = body.steps !== undefined ? stepsIn(body.steps) : storedSteps(row);
    const agent = body.steps !== undefined ? agentColumns(steps) : { artifact: row.artifact ?? null, prompt: row.prompt ?? null };
    if (!steps.length && body.steps === undefined) {
      // A legacy row with nothing to rebuild from: only the trigger moves.
      Object.assign(patch, scheduleColumns(trig.when, trig.trigger_config), { trigger_config: trig.trigger_config });
    } else {
      const cols = buildColumns(res, { when: trig.when, trigger_config: trig.trigger_config, steps, ...agent }, plan);
      if (!cols) return;
      Object.assign(patch, cols);
    }
  }
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120);
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_change', supported: CREATE_FIELDS });

  if (patch.enabled === true) {
    const hit = await automationLimitHit(supabase, req.workspaceId, plan.id, { excludeId: row.id });
    if (hit !== null) return res.status(402).json(automationLimitBody(plan.id, hit));
  }

  const { data, error } = await supabase.from('agent_routines')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('workspace_id', req.workspaceId)
    .select('*').single();
  if (error && isMissingFlowColumn(error)) return res.status(409).json(NEEDS_MIGRATION);
  if (error) throw error;
  if (!data) return notFound(res);
  return res.json({ workflow: workflowOut(data) });
}));

// POST /v2/workflows/:id/duplicate → 201 { workflow } — "<name> (copy)", disabled.
workflowsV2Router.post('/:id/duplicate', allowQueryParams([]), wrap('POST /v2/workflows/:id/duplicate', async (req, res, supabase) => {
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const { id: _id, created_at: _c, updated_at: _u, last_run_at: _l, next_run_at: _n, condition_state: _cs,
          workspace_id: _w, user_id: _o, name, enabled: _e, ...rest } = row;
  // Disabled, so a copy never takes a slot on the plan's ladder until somebody switches it on.
  const { data, error } = await supabase.from('agent_routines').insert({
    ...rest,
    workspace_id: req.workspaceId,
    user_id: req.memberUserId ?? row.user_id ?? null,
    name: `${name} (copy)`.slice(0, 120),
    enabled: false,
  }).select('*').single();
  if (error) throw error;
  return res.status(201).json({ workflow: workflowOut(data) });
}));

// DELETE /v2/workflows/:id → { deleted: true, id }
// The app deletes an automation outright (DELETE /api/automations/:id), and its run history goes
// with it (agent_routine_runs cascades). This does the same. Disable instead (PATCH enabled:false)
// to stop one and keep its history.
workflowsV2Router.delete('/:id', allowQueryParams([]), wrap('DELETE /v2/workflows/:id', async (req, res, supabase) => {
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const { error } = await supabase.from('agent_routines').delete().eq('id', row.id).eq('workspace_id', req.workspaceId);
  if (error) throw error;
  return res.json({ deleted: true, id: row.id });
}));

// POST /v2/workflows/:id/run → { run_id, status, document_id?, thread_id? }
//
// Two runners, the two the app's own buttons use:
//   deal triggers      the automation engine's one-off (Test on the Automations page): the most
//                      recent deal in the last 90 days that hit the trigger, written AND sent.
//   clock, before_meeting, manual
//                      the routine runner's run-now (Tasks → Run): one agent turn on the prompt,
//                      landed in a thread. Needs a prompt, and the in-app agent on the plan.
// Any other trigger: 409 run_not_supported — nothing in the engine can run it yet.
workflowsV2Router.post('/:id/run', allowQueryParams([]), wrap('POST /v2/workflows/:id/run', async (req, res, supabase) => {
  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);

  if (DEAL_TRIGGERS.has(row.trigger_kind)) {
    const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const out = await runAutomationsForWorkspace(supabase, req.workspaceId, since, { onlyAutomation: row.id, max: 1 });
    if (!out?.document) {
      return res.json({ run_id: null, status: 'nothing_to_run_on', detail: 'No account has hit this trigger in the last 90 days, so there is nothing to run it on yet.' });
    }
    const { data: run } = await supabase.from('agent_routine_runs')
      .select('id, status').eq('routine_id', row.id).eq('document_id', out.document.id)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    return res.json({ run_id: run?.id ?? null, status: run?.status ?? 'ok', document_id: out.document.id });
  }

  if (!AGENT_RUN_TRIGGERS.has(row.trigger_kind)) {
    return res.status(409).json({ error: 'run_not_supported', trigger: row.trigger_kind, detail: `Nothing runs a "${row.trigger_kind}" workflow on demand yet.` });
  }
  if (!row.prompt || !String(row.prompt).trim()) {
    return res.status(409).json({ error: 'run_not_supported', trigger: row.trigger_kind, detail: 'A run-now needs an agent step with a prompt.' });
  }
  const { plan } = await resolveTeamAndPlan(req);
  try { assertFeature(plan.id, 'inAppAgent'); }
  catch (e) {
    if (e.code === 'cloud_only_feature') return res.status(403).json({ error: 'cloud_only_feature', feature: 'inAppAgent' });
    return res.status(402).json({ error: 'feature_not_in_plan', feature: 'inAppAgent', current_plan: plan.id, upgrade_url: '/settings?section=billing' });
  }
  if (!routineRunner) return res.status(403).json({ error: 'cloud_only_feature', feature: 'inAppAgent' });

  // A manual run is its own occurrence, stamped with the moment it was asked for.
  const dedupeKey = `manual|${new Date().toISOString()}`;
  const runIdFor = async (key) => {
    const { data } = await supabase.from('agent_routine_runs')
      .select('id').eq('routine_id', row.id).eq('dedupe_key', key).maybeSingle();
    return data?.id ?? null;
  };
  let out;
  try {
    out = await routineRunner(row, { dedupeKey });
  } catch (err) {
    // The runner keeps the failed row (renamed off the occurrence key) so History shows it.
    console.error('[POST /v2/workflows/:id/run]', err);
    const { data } = await supabase.from('agent_routine_runs')
      .select('id').eq('routine_id', row.id).like('dedupe_key', `${dedupeKey}|failed|%`).maybeSingle();
    return res.status(500).json({ error: 'run_failed', run_id: data?.id ?? null });
  }
  if (out?.skipped === 'out_of_credits') return res.status(402).json({ error: 'out_of_credits', run_id: await runIdFor(dedupeKey), status: 'skipped' });
  return res.json({ run_id: await runIdFor(dedupeKey), status: out?.status ?? 'ok', ...(out?.thread_id ? { thread_id: out.thread_id } : {}) });
}));

// GET /v2/workflows/:id/runs?status=&days=&limit=&offset= → { runs, stats, limit, offset, has_more }
workflowsV2Router.get('/:id/runs', allowQueryParams(['status', 'days', 'limit', 'offset']), wrap('GET /v2/workflows/:id/runs', async (req, res, supabase) => {
  const page = parsePaging(req.query);
  if (page.error) return res.status(400).json({ error: page.error });
  const statuses = req.query.status == null ? [] : String(req.query.status).split(',').map(x => x.trim()).filter(Boolean);
  const badStatus = statuses.filter(s => !RUN_STATUSES.has(s));
  if (badStatus.length) return res.status(400).json({ error: 'invalid_status', supported: [...RUN_STATUSES] });
  const days = req.query.days == null ? null : Number(req.query.days);
  if (days != null && (!Number.isFinite(days) || days <= 0)) return res.status(400).json({ error: 'invalid_days' });

  const row = await loadOwned(supabase, req);
  if (!row) return notFound(res);
  const { runs, stats } = await listAutomationRuns(supabase, req.workspaceId, {
    days, routines: [row.id], statuses, limit: page.limit + 1, offset: page.offset,
  });
  const has_more = runs.length > page.limit;
  return res.json({
    runs: runs.slice(0, page.limit).map(runOut),
    stats: { days: stats.days, runs: stats.runs, failed: stats.failed, reports: stats.reports },
    limit: page.limit, offset: page.offset, has_more,
  });
}));
