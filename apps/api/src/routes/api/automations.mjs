import { Router } from 'express';
import { getSupabaseClient, syncAfterCallWebhook, runAutomationsForWorkspace, previewAutomationVars, hubspotFieldList, automationContextPreview, searchAutomationAccounts, automationEmailPreview, listAutomationApprovals, decideAutomationRun, getAutomationRun, startTestRun, sendRunEmail, saveApprovalChoices, testTriggers, hubspotObjects, hubspotObjectFields, readHubspotRecords } from '@nous/core';
import { buildOutcomeLedger } from '../../lib/outcomeLedger.mjs';
import { automationLimit, canMakeArtifact, planName } from '../../lib/plans.mjs';
import { creditsForRuns, creditsByAutomation } from '../../lib/automationCredits.mjs';
import { isOwnedRoutine, ownsRoutine, routineAccess, canSeeRoutineRuns, hiddenRoutines, routineRunGuard, foldHiddenRoutines } from '../../lib/routineAccess.mjs';

/** Every From a review picked is one of the reviewer's own mailboxes (GET-745). */
export async function ownMailboxesOnly(req, decisions) {
  for (const d of Object.values(decisions ?? {})) {
    const from = d?.email?.from;
    if (from && (await chosenMailbox(getSupabaseClient(), req.workspaceId, req.internalUserId, from)) === false) return false;
  }
  return true;
}
import { listMailboxes, chosenMailbox } from '../../lib/automationMailboxes.mjs';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { loadModelKey, listModels, callOwnModel, OWN_MODEL_PROVIDERS } from '../../lib/ownModel.mjs';
import { FLOW_TRIGGERS, FLOW_TRIGGER_KEYS, checkFlow, scheduleColumns, destinationColumns, isMissingFlowColumn } from '../../lib/flows.mjs';

// The built-in automations (GET-80) — the OpenNous-shipped side of the automation layer (GET-73),
// as opposed to the user's own custom Sequences (routines). Per SEAT: each member's calls fire into
// their own connected repo, so the config lives on personal_workspaces (automation_enabled +
// automation_events, from the GET-74 migration). The `after_call` automation toggles the
// meeting_held dispatch the deployed bridge reads.

export const automationsRouter = Router();

automationsRouter.use((req, res, next) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  next();
});

// A routine another surface owns (GET-868, lib/routineAccess.mjs) is managed only there, which checks
// the caller's access to it: here it is neither listed nor reachable by id, or any workspace member
// could read its prompt, run it, edit it or delete it. Every /:id route answers 404 for one, as for a
// row that is not there. Its runs follow that surface's access: seen and acted on only as it allows.
automationsRouter.param('id', async (req, res, next, id) => {
  try {
    if (await ownsRoutine(getSupabaseClient(), req.workspaceId, id)) return res.status(404).json({ error: 'not_found' });
    return next();
  } catch (err) {
    console.error('[/api/automations/:id owner check]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
automationsRouter.param('runId', routineRunGuard((req) => req.internalUserId ?? null));

const AFTER_CALL_EVENT = 'interaction.meeting_held';

async function seatConfig(supabase, workspaceId, userId) {
  const { data } = await supabase
    .from('personal_workspaces')
    .select('source_type, github_repo, automation_enabled, automation_events')
    .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return data || null;
}

// GET /api/automations/after-call — this seat's repo-dispatch toggle. Older than the recipe
// model below and kept whole: the deployed bridge reads the flag it writes.
automationsRouter.get('/after-call', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const seat = await seatConfig(supabase, req.workspaceId, req.internalUserId);
    const repoConnected = !!(seat && seat.source_type === 'github' && seat.github_repo);
    const events = seat?.automation_events || [];
    const afterCallOn = !!(seat?.automation_enabled && events.includes(AFTER_CALL_EVENT));

    return res.json({
      repo_connected: repoConnected,
      repo: repoConnected ? seat.github_repo : null,
      automations: [
        {
          key: 'after_call',
          name: 'After every call',
          description: 'When a call ends, draft the follow-up in the channel the conversation lives in, and score the call for coaching.',
          enabled: afterCallOn,
          available: true,
          requires_repo: true,
        },
        {
          key: 'weekly_coaching',
          name: 'Weekly coaching report',
          description: "Every Sunday, a coaching report over the week's calls — your trend, what to work on, and best calls.",
          enabled: false,
          available: false, // coming soon (GET-78)
          requires_repo: true,
        },
      ],
    });
  } catch (err) {
    console.error('[GET /api/automations/after-call]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/automations/after-call — toggle it for this seat. Body: { key, enabled }.
automationsRouter.patch('/after-call', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { key, enabled } = req.body || {};
    if (key !== 'after_call') return res.status(400).json({ error: 'unknown_or_readonly_automation' });

    // The toggle sets the INTENT — it works before a repo is connected; the dispatch bridge simply
    // has nothing to fire into until the repo lands (the UI says so). Store the flag either way,
    // creating a placeholder seat row (source_type 'none') when none exists yet.
    const seat = await seatConfig(supabase, req.workspaceId, req.internalUserId);
    const events = new Set(seat?.automation_events || []);
    if (enabled) events.add(AFTER_CALL_EVENT); else events.delete(AFTER_CALL_EVENT);
    const nextEvents = [...events];
    const anyOn = events.size > 0;

    if (seat) {
      await supabase.from('personal_workspaces')
        .update({ automation_enabled: anyOn, automation_events: nextEvents, updated_at: new Date().toISOString() })
        .eq('workspace_id', req.workspaceId).eq('user_id', req.internalUserId);
    } else {
      await supabase.from('personal_workspaces').insert({
        workspace_id: req.workspaceId, user_id: req.internalUserId, source_type: 'none',
        automation_enabled: anyOn, automation_events: nextEvents,
      });
    }

    // The toggle owns a real webhook now (GET-672): make it match. Best-effort; the worker's
    // reconcile catches anything this misses within minutes.
    try { await syncAfterCallWebhook(supabase, req.workspaceId, req.internalUserId); }
    catch (e) { console.warn('[PATCH /api/automations/after-call] webhook sync failed:', e.message); }

    return res.json({ ok: true, key, enabled: !!enabled });
  } catch (err) {
    console.error('[PATCH /api/automations/after-call]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});


// ─── WHEN · MAKE · SEND (GET-426) ────────────────────────────────────────────
//
// An automation is three choices and a switch: when it fires, what it writes, and where that
// goes besides Home. Home ALWAYS gets it — a delivery you cannot go back and read is not a
// record of anything — so `destination` is an extra, and 'none' is not a degraded state.
//
// The rows live in agent_routines, which already held the custom kind (a prompt plus a
// trigger). A preset and a custom automation are the same object with a different middle, so
// they share one table, one list and one limit.

export const ARTIFACT_RECIPES = [
  {
    artifact: 'account_summary',
    name: 'Account summary',
    blurb: 'When a deal is won, write the account up from everything the graph knows and send it on.',
    when: 'deal_closed_won',
    when_label: 'a deal is won',
  },
  {
    artifact: 'call_summary',
    name: 'Call summary',
    blurb: 'After every call, what was said, what was agreed, and who owes what.',
    when: 'call_ended',
    when_label: 'a call ends',
  },
  {
    artifact: 'call_score',
    name: 'Call score',
    blurb: 'Score the call against your own bar and say what to work on.',
    when: 'call_scored',
    when_label: 'a call is scored',
  },
];

// The trigger catalogue is FLOW_TRIGGERS in lib/flows.mjs (GET-523).

// Which triggers something actually dispatches today. routineRunner handles the clock and
// before_meeting; the daily deal pass (runAutomationsForWorkspace) handles won, lost and stage
// moves, an account signal lands (GET-686), a customer call ends and is read (GET-706), or a
// PostHog event arrives (GET-751). The
// rest are not wired, so the API says so rather than letting a workspace build an automation that
// silently never runs.
export const LIVE_TRIGGERS = new Set(['clock', 'before_meeting', 'deal_closed_won', 'deal_closed_lost', 'deal_stage_changed', 'icp_tier_changed', 'account_signal', 'call_ended', 'hubspot_field_changed', 'posthog_event']);

const DESTINATIONS = [
  { key: 'none',    label: 'Home only' },
  // Several addresses, comma-separated: the first is the To and the rest are Cc, so a
  // handoff lands in one person's inbox with the others on the same thread rather than in
  // three separate emails nobody can reply-all to.
  { key: 'email',   label: 'Email',   needs_target: true, multiple: true },
  { key: 'slack',   label: 'Slack',   needs_target: true },
  { key: 'webhook', label: 'Webhook', needs_target: true },
];

// Every new field is read with a default, because this runs against a database that may not
// have the GET-426 migration yet. An automations page that 500s until a migration lands is a
// page nobody can use to find out what is missing.
/**
 * Tidy a destination's target. For email that means a comma-separated list with the To
 * first — trimmed, de-duplicated, and anything that is not an address dropped, because a
 * typo in a Cc is a send that fails at delivery rather than at the point you made it.
 */
function normaliseTarget(destination, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (destination !== 'email') return s;
  const seen = new Set();
  const out = [];
  for (const part of s.split(/[,;\s]+/)) {
    const a = part.trim().toLowerCase();
    if (!a || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a) || seen.has(a)) continue;
    seen.add(a); out.push(a);
  }
  return out.length ? out.join(', ') : null;
}

export const rowOut = (r) => ({
  id: r.id,
  name: r.name,
  artifact: r.artifact ?? null,
  custom: !r.artifact,
  prompt: r.prompt,
  when: r.trigger_kind,
  destination: r.destination ?? 'none',
  destination_target: r.destination_target ?? null,
  enabled: r.enabled,
  last_run_at: r.last_run_at,
  offset_minutes: r.offset_minutes ?? null,
  // The clock's shape, so the editor opens on the schedule it was saved with.
  frequency: r.frequency ?? null,
  at_time: r.at_time ?? null,
  tools: r.tools ?? [],
  // The flow (GET-523). Null on a row from before flows; the editor reads those as
  // [agent, send] from the columns above.
  steps: Array.isArray(r.steps) ? r.steps : null,
  trigger_config: r.trigger_config ?? {},
  // Versions (GET-584): the live version's number, and the unpublished draft when there is one.
  version: r.version ?? 1,
  draft: r.draft ?? null,
});

export const NEEDS_MIGRATION = {
  error: 'needs_migration',
  message: 'Multi-step automations need a database update that has not run yet.',
};

/**
 * The agent a flow's first agent step makes, as the legacy artifact/prompt pair. The editor
 * sends it alongside the steps (it owns the job briefs); this checks it the way a new
 * single-step automation is checked, so a flow cannot buy an artifact its plan does not have.
 */
function flowAgentColumns(body, plan) {
  const artifact = body?.artifact ?? null;
  const prompt = String(body?.prompt ?? '').trim() || null;
  if (artifact && !ARTIFACT_RECIPES.some(r => r.artifact === artifact)) {
    return { fail: { status: 400, body: { error: 'unknown_artifact', artifact } } };
  }
  if (!canMakeArtifact(plan.id, artifact)) {
    return { fail: { status: 402, body: { error: 'artifact_not_in_plan', artifact, current_plan: planName(plan.id), upgrade_url: '/settings?section=billing' } } };
  }
  return { cols: { artifact, prompt } };
}

/**
 * The automation limit for one workspace: its plan's, unless the workspace is on the server's
 * unlimited list (AUTOMATION_UNLIMITED_WORKSPACES, comma-separated ids) — our own comped
 * workspaces, which run every automation we ship (GET-708). Null = unlimited.
 */
export function workspaceAutomationLimit(workspaceId, planId, raw = process.env.AUTOMATION_UNLIMITED_WORKSPACES) {
  const unlimited = String(raw ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (workspaceId && unlimited.includes(workspaceId)) return null;
  return automationLimit(planId);
}

/** Build a flow's row from the request, or say why not. */
export function flowColumns(body, plan) {
  const when = String(body?.when ?? '');
  if (!FLOW_TRIGGER_KEYS.has(when)) return { fail: { status: 400, body: { error: 'unknown_trigger', when, message: 'Pick a trigger.' } } };
  const flow = checkFlow(body);
  if (!flow.ok) return { fail: { status: 400, body: flow } };
  const agent = flowAgentColumns(body, plan);
  if (agent.fail) return agent;
  return {
    cols: {
      ...agent.cols,
      ...scheduleColumns(when, flow.triggerConfig),
      ...destinationColumns(flow.steps),
      steps: flow.steps,
      trigger_config: flow.triggerConfig,
    },
  };
}

/**
 * The plan's automation ladder: the limit when one more automation would pass it, else null.
 * Counted at the moment of writing, over every automation the workspace has, on or off (GET-528);
 * the defaults OpenNous runs are not rows, so they never count. `excludeId` leaves out the row
 * being switched on, so it is not counted twice. Shared with /v2/workflows.
 */
export async function automationLimitHit(supabase, workspaceId, planId, { excludeId = null } = {}) {
  const limit = workspaceAutomationLimit(workspaceId, planId);
  if (limit === null) return null;
  let q = supabase.from('agent_routines')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (excludeId) q = q.neq('id', excludeId);
  const { count } = await q;
  return (count ?? 0) >= limit ? limit : null;
}

/** The 402 a create sends when the ladder is full. */
export function automationLimitBody(planId, limit) {
  return {
    error: 'automation_limit_reached', limit, current_plan: planName(planId),
    message: limit === 0
      ? 'Automations need an active plan.'
      : `Your plan includes ${limit} automation${limit === 1 ? '' : 's'}. Delete one, or move to Custom for unlimited.`,
    upgrade_url: '/settings?section=billing',
  };
}

/** Every automation on this workspace, with the plan's ladder around it. */
automationsRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { plan } = await resolveTeamAndPlan(req);
    const { data, error } = await supabase
      .from('agent_routines')
      .select('*')
      .eq('workspace_id', req.workspaceId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const rows = data ?? [];
    const limit = workspaceAutomationLimit(req.workspaceId, plan.id);
    return res.json({
      plan: planName(plan.id),
      limit,                                   // null = unlimited
      used: rows.length,                       // the limit counts every automation, on or off, owned ones too
      automations: rows.filter(r => !isOwnedRoutine(r)).map(rowOut),   // an owned routine is its surface's, not listed here
      // The catalogue is returned whole, with each entry saying whether THIS plan may pick it.
      // A locked card that names the plan it needs sells better than a card that is missing.
      catalogue: ARTIFACT_RECIPES.map(r => ({
        ...r,
        available: canMakeArtifact(plan.id, r.artifact),
        needs_plan: canMakeArtifact(plan.id, r.artifact)
          ? null
          : (r.artifact === 'call_score' ? 'Scale' : 'Pro'),
      })),
      // Your own prompt, on every plan. This is what keeps a Starter slot from being empty.
      custom: { available: true, name: 'Custom', blurb: 'Your own instruction, on your own trigger.' },
      destinations: DESTINATIONS,
      triggers: FLOW_TRIGGERS.map(t => ({ ...t, live: LIVE_TRIGGERS.has(t.key) })),
    });
  } catch (err) {
    console.error('[GET /api/automations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** POST with steps — a flow (GET-523). The same ladder as a single-step automation. */
async function createFlow(req, res, supabase, plan) {
  const built = flowColumns(req.body, plan);
  if (built.fail) return res.status(built.fail.status).json(built.fail.body);
  const hit = await automationLimitHit(supabase, req.workspaceId, plan.id);
  if (hit !== null) return res.status(402).json(automationLimitBody(plan.id, hit));
  const { data, error } = await insertFlow(supabase, {
    workspaceId: req.workspaceId, userId: req.internalUserId ?? null, name: req.body?.name, cols: built.cols, enabled: true,
  });
  if (error && isMissingFlowColumn(error)) return res.status(409).json(NEEDS_MIGRATION);
  if (error) throw error;
  return res.status(201).json(rowOut(data));
}

/** Write a checked flow (flowColumns' cols) as a row. Shared with /v2/workflows. Returns { data, error }. */
export function insertFlow(supabase, { workspaceId, userId = null, name, cols, enabled = true }) {
  return supabase.from('agent_routines').insert({
    workspace_id: workspaceId,
    user_id: userId,
    name: String(name ?? 'Automation').trim().slice(0, 120) || 'Automation',
    ...cols,
    enabled,
  }).select('*').single();
}

// POST /api/automations — build one. Body: { name?, artifact?, prompt?, when?, destination?,
// destination_target? }. Either an artifact or a prompt; the database enforces that too.
automationsRouter.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { plan } = await resolveTeamAndPlan(req);
    if (Array.isArray(req.body?.steps)) return await createFlow(req, res, supabase, plan);
    const { artifact = null, prompt = null, destination = 'none', destination_target = null } = req.body || {};
    const recipe = ARTIFACT_RECIPES.find(r => r.artifact === artifact) || null;

    if (artifact && !recipe) return res.status(400).json({ error: 'unknown_artifact', artifact });
    if (!artifact && !String(prompt ?? '').trim()) {
      return res.status(400).json({ error: 'nothing_to_make', message: 'Pick an artifact or write a prompt.' });
    }
    if (!canMakeArtifact(plan.id, artifact)) {
      return res.status(402).json({
        error: 'artifact_not_in_plan', artifact, current_plan: planName(plan.id),
        upgrade_url: '/settings?section=billing',
      });
    }
    if (!DESTINATIONS.some(d => d.key === destination)) {
      return res.status(400).json({ error: 'unknown_destination', destination });
    }

    // The ladder. Counted at the moment of writing rather than trusted from the client, and
    // counted over every automation the workspace HAS, on or off (GET-528): self-serve gets five,
    // and a sixth kept switched off is still a sixth. The defaults OpenNous runs are not rows here,
    // so they never count.
    const hit = await automationLimitHit(supabase, req.workspaceId, plan.id);
    if (hit !== null) return res.status(402).json(automationLimitBody(plan.id, hit));

    // Built field by field so the optional ones can be dropped when the column is missing.
    const insert = {
      workspace_id: req.workspaceId,
      user_id: req.internalUserId ?? null,
      name: String(req.body?.name ?? recipe?.name ?? 'Automation').slice(0, 120),
      artifact,
      // A preset may still carry a prompt — the "anything else?" field on the dialog. It is
      // an addition to what the artifact already does, not a replacement for it.
      prompt: artifact ? (String(req.body?.prompt ?? '').trim() || null) : String(prompt).trim(),
      // The recipe's own trigger is the default; the dialog may override it, which is what
      // makes a preset customisable rather than a fixed thing you take or leave.
      trigger_kind: String(req.body?.when ?? recipe?.when ?? 'call_ended'),
      tools: Array.isArray(req.body?.tools) && req.body.tools.length ? req.body.tools : null,
      // The schedule shape the constraint demands: a clock needs a frequency and an hour, a
      // before-meeting needs its offset, an event needs neither.
      ...(String(req.body?.when ?? recipe?.when) === 'clock'
        ? { frequency: req.body?.frequency ?? 'daily', at_time: req.body?.at_time ?? '08:00' }
        : {}),
      ...(String(req.body?.when ?? recipe?.when) === 'before_meeting'
        ? { offset_minutes: Number(req.body?.offset_minutes) || 30 }
        : {}),
      destination,
      destination_target: destination === 'none' ? null : normaliseTarget(destination, destination_target),
      enabled: true,
    };
    let { data, error } = await supabase.from('agent_routines').insert(insert).select('*').single();
    // PGRST204 / 42703 — a column the migration has not created. Retry with the shape the
    // table had before it, so a workspace can still build the custom kind today.
    if (error && /column|schema cache/i.test(error.message ?? '')) {
      const { artifact: _a, destination: _d, destination_target: _t, tools: _o, ...legacy } = insert;
      ({ data, error } = await supabase.from('agent_routines')
        .insert({ ...legacy, prompt: insert.prompt ?? `Write a ${String(insert.artifact ?? 'summary').replace(/_/g, ' ')}.` })
        .select('*').single());
    }
    if (error) throw error;

    return res.status(201).json(rowOut(data));
  } catch (err) {
    console.error('[POST /api/automations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/automations/:id — on/off, where it sends, and (GET-523) the rest of the flow:
// name, what the agent does, when it fires, which tools. Before the flow editor only the first
// two were read, so editing a trigger or a prompt saved nothing and said nothing. Turning one
// ON has to pass the same ladder a new one does, or the limit would be a formality you step
// around by creating everything disabled.
/**
 * The columns a save changes, checked exactly as a create is. Shared by a live save, a draft
 * (checked now so Publish cannot fail later) and Publish itself. `{ fail }` carries the refusal.
 */
function buildPatch(body, plan) {
  const req = { body };
    const patch = {};
    if (Array.isArray(req.body?.steps)) {
      const built = flowColumns(req.body, plan);
      if (built.fail) return { fail: built.fail };
      Object.assign(patch, built.cols);
      if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 120);
    }
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (req.body?.destination !== undefined) {
      if (!DESTINATIONS.some(d => d.key === req.body.destination)) {
        return { fail: { status: 400, body: { error: 'unknown_destination' } } };
      }
      patch.destination = req.body.destination;
      patch.destination_target = req.body.destination === 'none' ? null : normaliseTarget(req.body.destination, req.body.destination_target);
    }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 120);
    if (Array.isArray(req.body?.tools)) patch.tools = req.body.tools.length ? req.body.tools : null;
    // What the agent does. Sent as a pair, checked exactly as a new one is.
    if ('artifact' in (req.body || {}) || 'prompt' in (req.body || {})) {
      const artifact = req.body.artifact ?? null;
      const prompt = String(req.body.prompt ?? '').trim() || null;
      if (artifact && !ARTIFACT_RECIPES.some(r => r.artifact === artifact)) {
        return { fail: { status: 400, body: { error: 'unknown_artifact', artifact } } };
      }
      if (!artifact && !prompt) {
        return { fail: { status: 400, body: { error: 'nothing_to_make', message: 'Pick a job or write what the agent should do.' } } };
      }
      if (!canMakeArtifact(plan.id, artifact)) {
        return { fail: { status: 402, body: { error: 'artifact_not_in_plan', artifact, current_plan: planName(plan.id), upgrade_url: '/settings?section=billing' } } };
      }
      patch.artifact = artifact;
      patch.prompt = prompt;
    }
    // When it fires, and the schedule shape that trigger needs — the others cleared, so a
    // clock that became an event does not keep an hour it no longer runs at.
    if (typeof req.body?.when === 'string' && req.body.when) {
      const when = req.body.when;
      patch.trigger_kind = when;
      patch.frequency = when === 'clock' ? (req.body.frequency ?? 'daily') : null;
      patch.at_time = when === 'clock' ? (req.body.at_time ?? '08:00') : null;
      patch.offset_minutes = when === 'before_meeting' ? (Number(req.body.offset_minutes) || 30) : null;
    }
  return { patch };
}

automationsRouter.patch('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { plan } = await resolveTeamAndPlan(req);

    // A DRAFT (GET-584): the editor's autosave. Checked like a save, kept aside, and nothing
    // live changes until Publish. `draft: null` throws the draft away.
    if (req.body && 'draft' in req.body) {
      let draft = null;
      if (req.body.draft) {
        const built = buildPatch(req.body.draft, plan);
        if (built.fail) return res.status(built.fail.status).json(built.fail.body);
        draft = { ...req.body.draft, saved_at: new Date().toISOString() };
      }
      const { data, error } = await supabase.from('agent_routines')
        .update({ draft, updated_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('workspace_id', req.workspaceId)
        .select('*').single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'not_found' });
      return res.json(rowOut(data));
    }

    const built = buildPatch(req.body ?? {}, plan);
    if (built.fail) return res.status(built.fail.status).json(built.fail.body);
    const patch = built.patch;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_change' });

    if (patch.enabled === true) {
      const hit = await automationLimitHit(supabase, req.workspaceId, plan.id, { excludeId: req.params.id });
      if (hit !== null) return res.status(402).json({ error: 'automation_limit_reached', limit: hit, current_plan: planName(plan.id) });
    }

    const { data, error } = await supabase.from('agent_routines')
      .update({ ...patch, ...(patch.enabled === undefined || Object.keys(patch).length > 1 ? { edited_by: req.internalUserId ?? null } : {}), updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('workspace_id', req.workspaceId)
      .select('*').single();
    if (error && isMissingFlowColumn(error)) return res.status(409).json(NEEDS_MIGRATION);
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.json(rowOut(data));
  } catch (err) {
    console.error('[PATCH /api/automations/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Versions (GET-584) ───────────────────────────────────────────────────────
//
// The database numbers them: any change to what an automation is bumps `version` and keeps a
// snapshot in automation_versions (see 2026_10_01_automation_versions.sql). These routes publish
// a draft, list the versions, and restore one — as a new version, so nothing is overwritten.

// The columns a version's snapshot sets back.
const SNAPSHOT_COLUMNS = [
  'name', 'prompt', 'trigger_kind', 'frequency', 'at_time', 'day_of_week', 'day_of_month', 'timezone',
  'offset_minutes', 'entity_id', 'condition', 'action', 'artifact', 'destination', 'destination_target',
  'tools', 'steps', 'trigger_config',
];

async function ownRoutine(supabase, req) {
  const { data } = await supabase.from('agent_routines').select('*')
    .eq('id', req.params.id).eq('workspace_id', req.workspaceId).maybeSingle();
  return data ?? null;
}

// POST /api/automations/:id/publish — the draft goes live as the next version.
automationsRouter.post('/:id/publish', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { plan } = await resolveTeamAndPlan(req);
    const row = await ownRoutine(supabase, req);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!row.draft) return res.status(400).json({ error: 'nothing_to_publish', message: 'There are no unpublished changes.' });
    const { saved_at: _s, ...draft } = row.draft;
    const built = buildPatch(draft, plan);
    if (built.fail) return res.status(built.fail.status).json(built.fail.body);
    const { data, error } = await supabase.from('agent_routines')
      .update({ ...built.patch, draft: null, edited_by: req.internalUserId ?? null, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('workspace_id', req.workspaceId)
      .select('*').single();
    if (error) throw error;
    return res.json(rowOut(data));
  } catch (err) {
    console.error('[POST /api/automations/:id/publish]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/:id/versions — every version, newest first, with who published it.
automationsRouter.get('/:id/versions', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const row = await ownRoutine(supabase, req);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const { data, error } = await supabase.from('automation_versions')
      .select('version, snapshot, published_by, published_at')
      .eq('routine_id', row.id).eq('workspace_id', req.workspaceId)
      .order('version', { ascending: false }).limit(100);
    if (error) throw error;
    const ids = [...new Set((data ?? []).map(v => v.published_by).filter(Boolean))];
    const { data: people } = ids.length ? await supabase.from('users').select('id, name, email').in('id', ids) : { data: [] };
    const who = new Map((people ?? []).map(p => [p.id, p.name || p.email]));
    return res.json({
      live: row.version ?? 1,
      has_draft: !!row.draft,
      versions: (data ?? []).map(v => ({
        version: v.version,
        published_at: v.published_at,
        published_by: v.published_by ? who.get(v.published_by) ?? null : null,
        snapshot: v.snapshot,
      })),
    });
  } catch (err) {
    console.error('[GET /api/automations/:id/versions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/:id/versions/:version/restore — that version, live again, as a new one.
automationsRouter.post('/:id/versions/:version/restore', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const row = await ownRoutine(supabase, req);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const { data: v } = await supabase.from('automation_versions').select('snapshot')
      .eq('routine_id', row.id).eq('workspace_id', req.workspaceId).eq('version', Number(req.params.version)).maybeSingle();
    if (!v) return res.status(404).json({ error: 'version_not_found' });
    const back = Object.fromEntries(SNAPSHOT_COLUMNS.map(k => [k, v.snapshot?.[k] ?? null]));
    const { data, error } = await supabase.from('agent_routines')
      .update({ ...back, draft: null, edited_by: req.internalUserId ?? null, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('workspace_id', req.workspaceId)
      .select('*').single();
    if (error) throw error;
    return res.json(rowOut(data));
  } catch (err) {
    console.error('[POST /api/automations/:id/versions/:version/restore]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/runs — what actually ran, newest first. The History view.
// GET /api/automations/tools — the tools this workspace has actually connected, split by what
// an automation can do with them. A picker that offers Fireflies to a workspace with no
// Fireflies is a picker that produces automations which never fire.
const MEETING_TOOLS = ['fireflies', 'granola', 'fathom', 'fellow', 'ringcentral', 'otter', 'zoom'];
const CRM_TOOLS = ['hubspot', 'salesforce', 'attio', 'pipedrive'];
const MODEL_TOOLS = ['openai', 'anthropic'];

automationsRouter.get('/tools', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('provider_id')
      .eq('workspace_id', req.workspaceId);
    const ids = [...new Set((conns ?? []).map(c => c.provider_id).filter(Boolean))];
    const { data: provs } = ids.length
      ? await supabase.from('workflow_providers').select('id, name, display_name').in('id', ids)
      : { data: [] };

    const seen = new Map();
    for (const p of provs ?? []) {
      const slug = String(p.name || '').toLowerCase().replace(/_oauth$/, '');
      if (!seen.has(slug)) seen.set(slug, { slug, label: p.display_name || slug });
    }
    const all = [...seen.values()];
    return res.json({
      meeting: all.filter(t => MEETING_TOOLS.includes(t.slug)),
      crm: all.filter(t => CRM_TOOLS.includes(t.slug)),
      // Your own model keys (GET-528) — an agent step can run on one of these.
      models: all.filter(t => MODEL_TOOLS.includes(t.slug)),
      // Every connected slug, so the editor can say which steps have nothing to run on.
      connected: all.map(t => t.slug),
      // The mailboxes an email can go from (GET-716): Gmail accounts and SMTP mailboxes.
      mailboxes: (await listMailboxes(supabase, req.workspaceId).catch(() => [])).map(m => ({ id: m.id, kind: m.kind, email: m.email })),
    });
  } catch (err) {
    console.error('[GET /api/automations/tools]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Your own model (GET-528) ───────────────────────────────────────────────────────────
// GET  /models?provider=anthropic|openai  — the models this workspace's key can use.
// POST /ai-test                           — run an AI step once, on the key, and return what it
//      wrote. Variables are filled with their names ("[Account]") — this proves the call and the
//      settings work; the step's real run has the real values.
automationsRouter.get('/models', async (req, res) => {
  try {
    const provider = String(req.query.provider ?? '');
    if (!OWN_MODEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'unknown_provider' });
    const key = await loadModelKey(getSupabaseClient(), req.workspaceId, provider);
    if (!key) return res.json({ connected: false, models: [] });
    const models = await listModels(provider, key);
    return res.json({ connected: true, models });
  } catch (err) {
    return res.status(502).json({ error: 'provider_error', message: String(err?.message ?? err).slice(0, 200) });
  }
});

automationsRouter.post('/ai-test', async (req, res) => {
  try {
    const { provider, model = null, effort = 'medium', temperature = null, max_tokens = 1500, prompt = '' } = req.body || {};
    if (!OWN_MODEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'unknown_provider' });
    const text = String(prompt).trim();
    if (!text) return res.status(400).json({ error: 'nothing_to_run', message: 'Write what the AI should do first.' });
    const key = await loadModelKey(getSupabaseClient(), req.workspaceId, provider);
    if (!key) return res.status(409).json({ error: 'not_connected', message: `Connect ${provider === 'anthropic' ? 'Claude' : 'ChatGPT'} in Integrations first.` });
    const filled = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => `[${String(k).split('.').pop().replace(/_/g, ' ')}]`);
    const started = Date.now();
    const out = await callOwnModel({
      provider, apiKey: key, model, effort, temperature, maxTokens: max_tokens,
      system: 'You are a step in a sales automation. Do exactly what the instruction asks. Variables in [brackets] stand for real values supplied at run time; treat them as placeholders.',
      prompt: filled,
    });
    return res.status(out.ok ? 200 : 422).json({ ...out, ms: Date.now() - started });
  } catch (err) {
    console.error('[POST /api/automations/ai-test]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/runs — the history. Filters (GET-523), all optional:
//   days      window in days; absent or 'all' = all time
//   routines  comma-separated automation ids
//   status    comma-separated: ok | error | running
// The stats follow the window and the automations, not the status — "Failed 3" should not
// turn into "Failed 0" because you are looking at the ones that worked.
export const RUN_STATUSES = new Set(['ok', 'error', 'running', 'awaiting_approval', 'rejected']);
/**
 * Run history, newest first, with the stats above the table. The one read behind
 * GET /api/automations/runs and GET /v2/workflows/:id/runs. `routines` narrows to some
 * automations; `limit`/`offset` page the list (the stats always cover the whole window).
 */
export async function listAutomationRuns(supabase, workspaceId, { days = null, routines = [], statuses = [], limit = 200, offset = 0, excludeRoutines = [] } = {}) {
  const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const scoped = (q) => {
    q = q.eq('workspace_id', workspaceId);
    if (since) q = q.gte('started_at', since);
    if (routines.length) q = q.in('routine_id', routines);
    // Owned routines the caller may not see (GET-868): left out of the list and of the stats.
    if (excludeRoutines.length) q = q.or(`routine_id.is.null,routine_id.not.in.(${excludeRoutines.join(',')})`);
    return q;
  };
  let listQ = scoped(supabase.from('agent_routine_runs').select('id, routine_id, status, started_at, error, document_id, version'));
  if (statuses.length) listQ = listQ.in('status', statuses);
  const { data, error } = await listQ.order('started_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  const runs = data ?? [];
  // Name each run after the automation it belongs to, in one more query rather than a
  // join per row — a history that says "routine 4c99…" is a history nobody reads.
  const ids = [...new Set(runs.map(r => r.routine_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { data: rows } = await supabase.from('agent_routines')
      .select('id, name, artifact, trigger_kind').eq('workspace_id', workspaceId).in('id', ids);
    for (const r of rows ?? []) names.set(r.id, { name: r.name, artifact: r.artifact, when: r.trigger_kind });
  }
  const docIds = [...new Set(runs.map(r => r.document_id).filter(Boolean))];
  const titles = new Map();
  if (docIds.length) {
    const { data: ds } = await supabase.from('documents')
      .select('id, title').eq('workspace_id', workspaceId).in('id', docIds);
    for (const d of ds ?? []) titles.set(d.id, d.title);
  }

  // The numbers above the table (GET-523), counted in the database rather than from the rows
  // below — a busy workspace runs more than a page's worth in a month.
  const count = (q) => q.then(({ count: c }) => c ?? 0, () => 0);
  const base = () => scoped(supabase.from('agent_routine_runs').select('id', { count: 'exact', head: true }));
  const [total, failed, reports] = await Promise.all([
    count(base()),
    count(base().eq('status', 'error')),
    count(base().not('document_id', 'is', null)),
  ]);

  // What each run cost (GET-714): its credits, and each step's share.
  const credits = await creditsForRuns(supabase, workspaceId, runs).catch(() => new Map());

  return {
    stats: { days: since ? days : null, runs: total, failed, reports },
    runs: runs.map(r => ({
      credits: credits.get(r.id)?.credits ?? 0,
      credit_steps: credits.get(r.id)?.steps ?? [],
      id: r.id,
      routine_id: r.routine_id ?? null,
      when: names.get(r.routine_id)?.when ?? null,
      automation: names.get(r.routine_id)?.name ?? 'Deleted automation',
      artifact: names.get(r.routine_id)?.artifact ?? null,
      status: r.status,
      started_at: r.started_at,
      error: r.error ?? null,
      // WHAT IT PRODUCED. A history that says "ok" and nothing else asks you to take its
      // word for it; the document is the evidence, and it is one click away.
      document_id: r.document_id ?? null,
      document_title: r.document_id ? (titles.get(r.document_id) ?? null) : null,
      // The version that was live when it ran (GET-584).
      version: r.version ?? null,
    })),
  };
}

automationsRouter.get('/runs', async (req, res) => {
  try {
    const days = Number(req.query.days);
    const routines = String(req.query.routines ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const statuses = String(req.query.status ?? '').split(',').map(x => x.trim()).filter(x => RUN_STATUSES.has(x));
    const supabase = getSupabaseClient();
    const excludeRoutines = hiddenRoutines(await routineAccess(supabase, req.workspaceId, req.internalUserId ?? null));
    return res.json(await listAutomationRuns(supabase, req.workspaceId, { days, routines, statuses, excludeRoutines }));
  } catch (err) {
    console.error('[GET /api/automations/runs]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/runs/:runId — one run, step by step (GET-721): what each step did and wrote,
// where it failed and why, what it waits for. Credits come from the run list's own reading.
automationsRouter.get('/runs/:runId', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const run = await getAutomationRun(supabase, req.workspaceId, req.params.runId);
    if (!run) return res.status(404).json({ error: 'not_found' });
    const credits = await creditsForRuns(supabase, req.workspaceId, [{ id: run.id, started_at: run.started_at, steps: run.steps }]).catch(() => new Map());
    const c = credits.get(run.id);
    return res.json({ ...run, credits: c?.credits ?? 0, steps: run.steps.map(x => ({ ...x, credits: c?.steps?.find(y => y.step === x.step)?.credits ?? 0 })) });
  } catch (err) {
    console.error('[GET /api/automations/runs/:runId]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/credits?days=30 — what each automation cost over the window (GET-714),
// for Usage and billing.
automationsRouter.get('/credits', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const supabase = getSupabaseClient();
    const [rows, access] = await Promise.all([
      creditsByAutomation(supabase, req.workspaceId, { days }),
      routineAccess(supabase, req.workspaceId, req.internalUserId ?? null),
    ]);
    // Owned routines the caller may not see fold into one line: their credits, no name (GET-868).
    return res.json({ days, automations: foldHiddenRoutines(rows, access) });
  } catch (err) {
    console.error('[GET /api/automations/credits]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/approvals — the runs waiting on someone, with what each step would do
// (GET-713). POST /api/automations/approvals/:runId/approve | /reject decides one: approving runs
// that step and the rest of the automation; skipping ends the run as rejected.
automationsRouter.get('/approvals', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const [approvals, access] = await Promise.all([
      listAutomationApprovals(supabase, req.workspaceId),
      routineAccess(supabase, req.workspaceId, req.internalUserId ?? null),
    ]);
    return res.json({ approvals: approvals.filter(a => canSeeRoutineRuns(access, a.automation?.id)) });
  } catch (err) {
    console.error('[GET /api/automations/approvals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
// POST /api/automations/approvals/:runId/choices — an item's Approve / Skip kept before the review
// is finished, so a reload shows it as decided (GET-735).
automationsRouter.post('/approvals/:runId/choices', async (req, res) => {
  try {
    const out = await saveApprovalChoices(getSupabaseClient(), req.workspaceId, req.params.runId, req.body ?? {});
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[POST /api/automations/approvals/:runId/choices]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

for (const decision of ['approve', 'reject']) {
  automationsRouter.post(`/approvals/:runId/${decision}`, async (req, res) => {
    try {
      const decisions = decision === 'approve' && req.body?.decisions && typeof req.body.decisions === 'object' ? req.body.decisions : null;
      if (!(await ownMailboxesOnly(req, decisions))) return res.status(403).json({ error: 'mailbox_not_yours', message: 'You can only send from your own mailbox.' });
      const out = await decideAutomationRun(getSupabaseClient(), req.workspaceId, req.params.runId,
        { approve: decision === 'approve', userId: req.internalUserId ?? null, decisions });
      if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
      return res.json(out);
    } catch (err) {
      console.error(`[POST /api/automations/approvals/:runId/${decision}]`, err);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}

// GET /api/automations/hubspot-fields — every HubSpot deal and company property this portal
// has, custom ones first, for the variable picker (GET-567). Read from the schema the CRM sync
// stores; empty when HubSpot is not connected or has not synced yet.
automationsRouter.get('/hubspot-fields', async (req, res) => {
  try {
    return res.json(await hubspotFieldList(getSupabaseClient(), req.workspaceId));
  } catch (err) {
    console.error('[GET /api/automations/hubspot-fields]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/context — exactly what the flow's AI step would read for one real
// sample, with its account and parts applied (GET-568). Reads only: no model call, nothing written.
automationsRouter.post('/context', async (req, res) => {
  try {
    const { when = null, steps = [], entity_id: entityId = null } = req.body ?? {};
    return res.json(await automationContextPreview(getSupabaseClient(), req.workspaceId, {
      when: typeof when === 'string' ? when : null,
      steps: Array.isArray(steps) ? steps.slice(0, 20) : [],
      entityId: typeof entityId === 'string' ? entityId : null,
    }));
  } catch (err) {
    console.error('[POST /api/automations/context]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/accounts?q= — accounts by name, for an AI step that always reads one.
automationsRouter.get('/accounts', async (req, res) => {
  try {
    return res.json({ accounts: await searchAutomationAccounts(getSupabaseClient(), req.workspaceId, req.query.q) });
  } catch (err) {
    console.error('[GET /api/automations/accounts]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/email-preview — the email this flow would send, for a real recent
// trigger (GET-664). Body: { when, steps, entity_id? }. Built by the same code as the send.
automationsRouter.post('/email-preview', async (req, res) => {
  try {
    const { when = null, steps = [], entity_id: entityId = null } = req.body ?? {};
    return res.json(await automationEmailPreview(getSupabaseClient(), req.workspaceId, {
      when: typeof when === 'string' ? when : null,
      steps: Array.isArray(steps) ? steps.slice(0, 20) : [],
      entityId: typeof entityId === 'string' ? entityId : null,
    }));
  } catch (err) {
    console.error('[POST /api/automations/email-preview]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/preview — a flow's variables filled from a real trigger (GET-566).
// Body: { when, steps, entity_id? }. Reads only; nothing runs and nothing is sent. Works on an
// unsaved flow, so the preview follows the editor rather than what was last saved.
automationsRouter.post('/preview', async (req, res) => {
  try {
    const { when = null, steps = [], entity_id: entityId = null } = req.body ?? {};
    const out = await previewAutomationVars(getSupabaseClient(), req.workspaceId, {
      when: typeof when === 'string' ? when : null,
      steps: Array.isArray(steps) ? steps.slice(0, 20) : [],
      entityId: typeof entityId === 'string' ? entityId : null,
    });
    return res.json(out);
  } catch (err) {
    console.error('[POST /api/automations/preview]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/:id/test — run this one, once, now.
//
// An automation you have just built and cannot try is one you find out about the day a deal
// closes. The test runs it for real — writes the document AND sends it — against exactly one
// account, because sending is half of what an automation does and a test that skips it
// leaves the half that touches somebody else's inbox unproven. It ignores the enabled switch
// for the same reason: being told to turn it on first, on a schedule that next fires in the
// morning, is not an answer to "does this work".
// POST /api/automations/:id/test-run — run it once, now, on its latest real trigger (the newest call
// from its recorder, or the newest matching signal), returning the run id at once; the run saves each
// step as it lands so the canvas can follow it (GET-724).
// GET /api/automations/hubspot/objects — what a HubSpot "Read records" step can read (GET-773):
// companies, contacts, deals and the portal's custom objects.
automationsRouter.get('/hubspot/objects', async (req, res) => {
  try {
    return res.json(await hubspotObjects(getSupabaseClient(), req.workspaceId));
  } catch (err) {
    console.error('[GET /api/automations/hubspot/objects]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/hubspot/read-preview { config } — what a Read records step would hand the
// next steps right now (GET-787): the same read, read-only, nothing run or saved.
automationsRouter.post('/hubspot/read-preview', async (req, res) => {
  try {
    const out = await readHubspotRecords(getSupabaseClient(), req.workspaceId, req.body?.config ?? {});
    return res.status(out.ok ? 200 : 409).json(out.ok ? { ok: true, text: out.text, count: out.count, read: out.read } : out);
  } catch (err) {
    console.error('[POST /api/automations/hubspot/read-preview]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/hubspot/objects/:object/fields — that object's fields, for the picker.
automationsRouter.get('/hubspot/objects/:object/fields', async (req, res) => {
  try {
    return res.json({ fields: await hubspotObjectFields(getSupabaseClient(), req.workspaceId, req.params.object) });
  } catch (err) {
    console.error('[GET /api/automations/hubspot/objects/:object/fields]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/automations/:id/test-triggers — the last 10 calls or signals a test can run on (GET-735).
automationsRouter.get('/:id/test-triggers', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: a } = await supabase.from('agent_routines').select('*').eq('workspace_id', req.workspaceId).eq('id', req.params.id).maybeSingle();
    if (!a) return res.status(404).json({ error: 'not_found' });
    return res.json({ triggers: await testTriggers(supabase, req.workspaceId, a, { limit: 10 }) });
  } catch (err) {
    console.error('[GET /api/automations/:id/test-triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

automationsRouter.post('/:id/test-run', async (req, res) => {
  try {
    // A chosen trigger (GET-735), one of GET /:id/test-triggers; else the newest.
    const out = await startTestRun(getSupabaseClient(), req.workspaceId, req.params.id, { pick: req.body?.trigger_id ?? null });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[POST /api/automations/:id/test-run]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/automations/runs/:runId/send-email — send an email the run drafted, as the reviewer
// edited it, from the mailbox the draft is in; the draft it replaces is removed (GET-731).
automationsRouter.post('/runs/:runId/send-email', async (req, res) => {
  try {
    const b = req.body ?? {};
    // From (GET-745): only one of the sender's own mailboxes.
    const picked = await chosenMailbox(getSupabaseClient(), req.workspaceId, req.internalUserId, b.from ?? null);
    if (picked === false) return res.status(403).json({ error: 'mailbox_not_yours', message: 'You can only send from your own mailbox.' });
    const out = await sendRunEmail(getSupabaseClient(), req.workspaceId, req.params.runId, {
      step: b.step, to: b.to, cc: b.cc ?? null, subject: b.subject, body: b.body, userId: req.internalUserId ?? null, connectionId: picked?.id ?? null,
    });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[POST /api/automations/runs/:runId/send-email]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

automationsRouter.post('/:id/test', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    // A wide window, because a test has to find SOMETHING to run against — the point is to
    // see the output, not to respect a schedule.
    const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const out = await runAutomationsForWorkspace(supabase, req.workspaceId, since, {
      onlyAutomation: req.params.id, max: 1,
    });
    if (!out?.document) {
      return res.json({ ran: false, reason: 'nothing_to_run_on', message: 'No account has hit this trigger in the last 90 days, so there is nothing to write about yet.' });
    }
    return res.json({ ran: true, document_id: out.document.id, title: out.document.title });
  } catch (err) {
    console.error('[POST /api/automations/:id/test]', err);
    return res.status(500).json({ error: 'internal_error', message: String(err?.message ?? err).slice(0, 200) });
  }
});

automationsRouter.delete('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('agent_routines')
      .delete().eq('id', req.params.id).eq('workspace_id', req.workspaceId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/automations/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Internal: rebuild the outcome ledger ────────────────────────────────────
//
// deal_outcomes is DERIVED, and nothing was rebuilding it on a schedule — buildOutcomeLedger
// is reached only from the revenue report and the ICP evidence route, so the table was last
// written on 2026-09-22 when somebody happened to open a report. A deal-closed automation
// reads that table, so a deal closing tomorrow would not appear in it and nothing would fire.
//
// The rebuild lives in the API because the ledger's builder does (and the worker image has no
// apps/api in it — a cross-app import is exactly what broke the automation engine in
// production once). So the worker does what it already does for agent routines: it says
// "now", and the API does the work.
//
// Only workspaces with an enabled deal automation. Rebuilding the ledger for a workspace
// nobody is watching is a few hundred rows of work to answer a question nobody asked.
export const automationsInternalRouter = Router();
automationsInternalRouter.use((req, res, next) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' });
  if (req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});

automationsInternalRouter.post('/rebuild-ledger', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: rows, error } = await supabase.from('agent_routines')
      .select('workspace_id').eq('enabled', true)
      .in('trigger_kind', ['deal_closed_won', 'deal_closed_lost', 'deal_stage_changed']);
    if (error) throw error;
    const workspaces = [...new Set((rows ?? []).map(r => r.workspace_id))];
    const out = [];
    for (const ws of workspaces) {
      try {
        const built = await buildOutcomeLedger(ws, { supabase });
        out.push({ workspace_id: ws, ok: true, ...built });
        console.log(`[automations] outcome ledger rebuilt for ${ws}`);
      } catch (err) {
        // One workspace failing must not stop the rest — the next one may be the one with
        // a deal closing today.
        console.error(`[automations] ledger rebuild failed for ${ws}:`, err?.message ?? err);
        out.push({ workspace_id: ws, ok: false, error: String(err?.message ?? err).slice(0, 200) });
      }
    }
    return res.json({ workspaces: workspaces.length, results: out });
  } catch (err) {
    console.error('[POST /internal/automations/rebuild-ledger]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
