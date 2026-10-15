import { makeRevboxSnapshot, visibleDocument } from '../../lib/revboxSnapshot.mjs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { requireAiCredits } from '../../lib/plans.mjs';
import { computeCost } from '../../lib/llmUsage.mjs';
import { Router } from 'express';
import { latestSignalView, slackHealthView, runSlackStatus, jobUsesSlack, slackConnectionState } from '@nous/core';
import {
  getSupabaseClient, listDocuments, getDocument,
  listRevboxes, createRevbox, patchRevbox, loadRevbox, revboxDetails,
  listContextLibrary, loadContextFile, createContextFile, updateContextFile, deleteContextFile, validateContextFile,
  setRevboxMember, addRevboxContext, removeRevboxContext, saveRevboxJob,
  revboxWorkspaceMembers, revboxAccountCatalog, revboxScopedGraph, revboxAccountOverview,
  reprocessCustomSignal, loadRevboxRunForEdit, revboxRunCosts, REQUESTED_USD_PER_CREDIT, setRevboxWebhookKey, listCustomSignals, saveCustomSignal, approveRevboxRun, enableRevboxJob, revboxNextRunAt, loadRevboxJob, queueRevboxRun, listRevboxRuns, revboxDeliveries,
  compileRevboxPlan, recordRevboxUsage, deliveryRecipients, createMessage, revboxConnections, revboxMembership,
  listRevboxDatasets, createRevboxDataset, updateRevboxDataset, listDatasetRows, exportDatasetCsv,
  ensureBoxEmailVoice, emailDraftingBuiltins, isEmailVoiceFile, revboxContextRows, signalsLabel, routineTriggers, listRevboxRoutines, loadRevboxRoutine, revboxRunAccounts, revboxWorkedAccounts, revboxBuiltinTaken, revboxBuiltinActivity, REVBOX_BUILTIN_JOBS, builtinJobBrief, ensureDefaultBuiltinBoxes, FOLLOW_UP_RECORDERS, decideAutomationRun, BUILDER_TRIGGERS, startTestRun, reasonWords, registerStepHandler, revboxWorkspaceRole, listRevboxJobDeliveries, nextRunAt,
} from '@nous/core';
import { listMailboxes, sendableMailboxes } from '../../lib/automationMailboxes.mjs';
import { revboxCreditGate, deliverRevboxRun } from '../../lib/revboxRuntime.mjs';
import { viewerVisibleAccountSet } from '../../lib/visibility.mjs';
import { safeFetch, assertPublicUrl } from '../../lib/ssrf.mjs';
import { loadCloud } from '../../lib/cloud.mjs';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { planName, planTier, getPlanFromSubscription } from '../../lib/plans.mjs';
import { workspaceConnectedSlugs } from './signals.mjs';
import { allowedWorkspaces } from '../../lib/detectorDrafts.mjs';
import { automationLimitHit } from './automations.mjs';
import { FLOW_TRIGGERS, checkFlow } from '../../lib/flows.mjs';
import { creditsForRuns } from '../../lib/automationCredits.mjs';
import { markIcpFile, mirrorIcpFile } from '../../lib/icpContextFile.mjs';

// A RevBox job on the workflow engine (GET-868) reads its box's references as its owner, and posts to
// the box's webhooks through the SSRF guard. The engine lives in core, so the API hands it both.
registerStepHandler('revbox_visible_accounts', async ({ supabase, workspaceId, userId }) => {
  if (!userId) return new Set();
  const member = await revboxWorkspaceRole(supabase, workspaceId, userId);
  const set = await viewerVisibleAccountSet(supabase, workspaceId, userId, { isAdmin: ['admin', 'owner'].includes(member?.role) });
  return set.unrestricted ? null : set.ids;
});
// safe_fetch(url, init, { maxRedirects, timeoutMs }) (pre-ship finding 4, GET-858): a box webhook asks
// for nothing and follows no redirect, 8s; an automation's webhook step asks for 4 redirects and 30s,
// as before the guard. Every hop is re-checked; the asks are clamped (0-4, 1-30s). The worker mirrors it.
registerStepHandler('safe_fetch', (url, init, opts = {}) => {
  const r = Number(opts?.maxRedirects), t = Number(opts?.timeoutMs);
  return safeFetch(url, init, {
    maxRedirects: Number.isFinite(r) ? Math.min(4, Math.max(0, Math.floor(r))) : 0,
    timeoutMs: Number.isFinite(t) ? Math.min(30_000, Math.max(1_000, Math.floor(t))) : 8_000,
  });
});

const FREQ_LABEL = { daily: 'Every day', weekly: 'Every Monday', monthly: 'On the first of the month', quarterly: 'At the start of each quarter' };
/** "Every day at 08:00 (Toronto)", "30 minutes before a meeting", "When a deal is won". Pure. */
export function routineTriggerLabel(r) {
  const tc = r.trigger_config ?? {};
  if (r.trigger_kind === 'clock') {
    const at = String(tc.at ?? r.at_time ?? '08:00').slice(0, 5);
    const tz = r.timezone && r.timezone !== 'UTC' ? ` (${String(r.timezone).split('/').pop().replace(/_/g, ' ')})` : ' (UTC)';
    return `${FREQ_LABEL[tc.frequency ?? r.frequency] ?? 'Every day'} at ${at}${tz}`;
  }
  // Several signals (GET-873): every one of them, from the catalog keys when saved, else the kinds.
  const keys = Array.isArray(tc.signal_keys) ? tc.signal_keys.filter(k => typeof k === 'string' && k) : [];
  if (keys.length > 1) return signalsLabel(keys);
  const all = routineTriggers(r);
  if (all.length > 1) return `When ${all.map(t => kindPhrase(t.kind)).join(' or ')}`;
  if (r.trigger_kind === 'before_meeting') return `${Number(tc.offset ?? r.offset_minutes) || 30} minutes before a meeting`;
  return FLOW_TRIGGERS.find(t => t.key === r.trigger_kind)?.label ?? r.trigger_kind;
}
/** "a call ends" from "When a call ends": a kind inside a several-trigger label. */
function kindPhrase(kind) {
  if (kind === 'before_meeting') return 'a meeting is coming up';
  return (FLOW_TRIGGERS.find(t => t.key === kind)?.label ?? kind).replace(/^When /, '');
}
/** A box's routine as the Jobs list reads it. No `plan` key: that is how the UI tells it from a legacy job. */
export const routineOut = (r) => ({
  id: r.id, kind: 'routine', name: r.name, enabled: r.enabled, trigger_kind: r.trigger_kind, trigger_config: r.trigger_config ?? {},
  timezone: r.timezone ?? 'UTC', trigger_label: routineTriggerLabel(r), last_run_at: r.last_run_at ?? null, next_run_at: r.next_run_at ?? null,
  steps: Array.isArray(r.steps) ? r.steps : [], version: r.version ?? 1, created_at: r.created_at ?? null, updated_at: r.updated_at ?? null,
});
/**
 * A box's delivery list as it is saved (GET-868). A Gmail destination that is new, or now points at
 * another mailbox, must be one of the saver's OWN connected Gmail accounts (`sendable`, from
 * sendableMailboxes), and its `mailbox_email` is set here from that list, never taken from the client.
 * An unchanged one keeps its mailbox and address, so an editor saving the box does not drop or take
 * over a colleague's draft destination. Throws 400. Pure.
 */
export function checkDeliveryMailboxes(delivery, current, sendable) {
  if (!Array.isArray(delivery)) return delivery;
  const before = new Map((Array.isArray(current) ? current : []).filter(d => d?.kind === 'gmail').map(d => [d.id, d]));
  const mine = new Map((sendable ?? []).map(m => [m.id, m]));
  const bare = (d) => { const { mailbox_email: _, ...rest } = d; return rest; };
  return delivery.map(d => {
    if (!d || typeof d !== 'object') return d;
    if (d.kind !== 'gmail') return 'mailbox_email' in d ? bare(d) : d;
    const target = typeof d.target === 'string' ? d.target.trim() : d.target;
    if (!target) return bare(d);
    const old = before.get(d.id);
    if (old && old.target === target) return { ...d, target, mailbox_email: old.mailbox_email ?? null };
    const m = mine.get(target);
    if (!m) invalid('Choose one of your own connected Gmail mailboxes for this destination.');
    return { ...d, target, mailbox_email: m.email ?? null };
  });
}
/** The box's routine with this id, or null when the id is a legacy revbox_jobs id. */
async function boxRoutineOrNull(sb, req, edit) {
  try { return await loadRevboxRoutine(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, routineId: req.params.jobId, edit }); }
  catch (e) { if (e.status === 404 && /^Job not found/.test(e.message)) return null; throw e; }
}

export const revboxesRouter = Router();
export const accountOverviewRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function route(fn) {
  return async (req, res) => {
    try {
      if (!req.workspaceId || !req.internalUserId) return res.status(400).json({ error: 'Workspace and signed-in member are required.' });
      if (Object.values(req.params).some(id => !uuid.test(id))) return res.status(400).json({ error: 'Invalid identifier.' });
      const sb = getSupabaseClient();
      await revboxMembership(sb, req.workspaceId, req.internalUserId);
      await fn(req, res, sb);
    } catch (e) {
      if (e.code === '42P01' || e.code === 'PGRST205' || /revbox.*schema cache/i.test(e.message ?? '') || ((e.code === '42703' || e.code === 'PGRST204') && /revbox_id|builtin_jobs/.test(e.message ?? ''))) return res.status(409).json({ error: 'The RevBox database migration has not been applied.' });
      if (!e.status) console.error('[revboxes]', e);
      res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Could not save or load the RevBox.', ...(e.status && e.reply ? e.reply : {}) });
    }
  };
}
async function allowed(sb, req) {
  const set = await viewerVisibleAccountSet(sb, req.workspaceId, req.internalUserId, { isAdmin: req.viewerScope === 'admin' });
  return set.unrestricted ? null : set.ids;
}
async function documents(sb, req) {
  const ids = await allowed(sb, req);
  return (await listDocuments(sb, req.workspaceId, { limit: 500 })).filter(d => !d.subject_entity_id || !ids || ids.has(d.subject_entity_id));
}
async function accessibleDocument(sb, req, id) {
  if (!uuid.test(id)) invalid('Invalid document identifier.');
  const doc = visibleDocument(await getDocument(sb, req.workspaceId, id), await allowed(sb, req));
  if (!doc) invalid('Document not found.', 404);
  return doc;
}

accountOverviewRouter.post('/', route(async (req, res, sb) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose up to 200 account identifiers.');
  const visible = await allowed(sb, req);
  res.json({ accounts: accountOverviewRows(await revboxAccountOverview(sb, req.workspaceId, visible ? ids.filter(id => visible.has(id)) : ids)) });
}));
/** The Accounts table's rows (GET-894): the latest signal gains its kind's label, tone and the line that says what was said. */
export function accountOverviewRows(accounts) {
  return accounts.map(a => ({ ...a, latest_signal: latestSignalView(a.latest_signal) }));
}

revboxesRouter.get('/', route(async (req, res, sb) => {
  // Every built-in job of a Workspace-plan workspace sits in a box (GET-897): ensured here, on the
  // read the sidebar makes, so a workspace that moves to the plan, a new one, or a box that lost
  // its built-in is put right on the next load. Idempotent; a failure never fails the list.
  await ensureBuiltinBoxesForPlan(sb, req.workspaceId, { planId: () => workspacePlanId(sb, req.workspaceId) });
  res.json({ boxes: await listRevboxes(sb, req.workspaceId, req.internalUserId) });
}));
// Which box holds each built-in job (GET-897), for the Priorities chip: [{ key, box_id, box_name }],
// the name null for a box this viewer cannot open.
revboxesRouter.get('/builtins', route(async (req, res, sb) => res.json({ homes: await revboxBuiltinTaken(sb, req.workspaceId, req.internalUserId) })));
revboxesRouter.post('/', route(async (req, res, sb) => res.status(201).json({ box: await createRevbox(sb, req.workspaceId, req.internalUserId) })));
/**
 * A library file that is a linked document is changed only by someone who can still read that
 * document (GET-875): to them it is "not found", as in the list. `open(id)` throws a 404 for a
 * document the viewer cannot read; any other error propagates.
 */
export async function contextFileDocumentGate(file, open) {
  if (!file?.document_id) return;
  try { await open(file.document_id); } catch (e) { if (e.status === 404) invalid('Context file not found.', 404); throw e; }
}
/** A saved library file as the response returns it: a linked document's title and text only while the
 * viewer can read it, otherwise a neutral stand-in (never the raw row's document title). */
export async function readableContextFile(file, open) {
  if (!file?.document_id) return file;
  try { const doc = await open(file.document_id); return { ...file, title: doc.title ?? file.title, body: doc.body_md ?? '' }; }
  catch (e) { if (e.status !== 404) throw e; return { ...file, title: 'Linked document', body: '' }; }
}
// Settings > Context (GET-875): the workspace context library. Files are saved once and tagged to
// RevBoxes; a linked document is shown only while the viewer may still read it.
async function withDocumentBodies(sb, req, files) {
  const out = [];
  for (const f of files) {
    if (!f.document_id) { out.push(f); continue; }
    try { const doc = await accessibleDocument(sb, req, f.document_id); out.push({ ...f, title: doc.title ?? f.title, body: doc.body_md ?? '' }); } catch (e) { if (e.status !== 404) throw e; }
  }
  return out;
}
revboxesRouter.get('/context-library', route(async (req, res, sb) => {
  const library = await listContextLibrary(sb, req.workspaceId, req.internalUserId);
  const icp = library.files.find(f => f.kind === 'icp') ?? null;
  res.json({ ...library, files: await withDocumentBodies(sb, req, library.files), icp_file_id: icp?.id ?? null });
}));
revboxesRouter.post('/context-files', route(async (req, res, sb) => {
  const { confirm_scorer_switch: confirm, ...input } = req.body ?? {};
  let body = input;
  if (Array.isArray(body.revbox_ids) && body.revbox_ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose valid RevBoxes.');
  if (body.document_id) { const doc = await accessibleDocument(sb, req, body.document_id); body = { ...body, document_id: doc.id, title: body.title || doc.title, body: '' }; }
  const create = () => createContextFile(sb, req.workspaceId, req.internalUserId, body);
  if (body.kind !== 'icp') return res.status(201).json({ file: await readableContextFile(await create(), id => accessibleDocument(sb, req, id)) });
  // Marked ICP on creation (GET-878): on an 'external' workspace this is confirmed first (409, nothing
  // written), then Nous scores from the file. Otherwise the first scorecard if there is none.
  const error = validateContextFile(body); if (error) invalid(error);
  const { result: file, icp } = await markIcpFile(sb, req.workspaceId, { confirm: confirm === true, admin: !req.workspaceRole || ['owner', 'admin'].includes(req.workspaceRole) }, create);
  res.status(201).json({ file: await readableContextFile(file, id => accessibleDocument(sb, req, id)), icp });
}));
/** Does this PATCH mark the file ICP (it was not)? Unmarking or editing never switches the scorer. */
export const icpMarking = (body, before) => body?.kind === 'icp' && before?.kind !== 'icp';
revboxesRouter.patch('/context-files/:fileId', route(async (req, res, sb) => {
  const { confirm_scorer_switch: confirm, ...body } = req.body ?? {};
  if (Array.isArray(body.revbox_ids) && body.revbox_ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose valid RevBoxes.');
  const before = await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId);
  await contextFileDocumentGate(before.file, id => accessibleDocument(sb, req, id));
  const update = () => updateContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId, body);
  if (icpMarking(body, before.file)) {
    // Marked now (GET-878): confirmed first on an 'external' workspace, then Nous scores from it.
    const error = validateContextFile(body, { partial: true }); if (error) invalid(error);
    const { result: file, icp } = await markIcpFile(sb, req.workspaceId, { confirm: confirm === true, admin: ['owner', 'admin'].includes(before.role) }, update);
    return res.json({ file: await readableContextFile(file, id => accessibleDocument(sb, req, id)), icp });
  }
  const file = await update();
  // The ICP file's text changed: the workspace ICP follows it, never a re-score. Unmarking leaves
  // the last text and the scorer setting as they are.
  const foundation = file.kind === 'icp' ? (await mirrorIcpFile(sb, req.workspaceId)).status : null;
  res.json({ file: await readableContextFile(file, id => accessibleDocument(sb, req, id)), ...(foundation ? { icp: { status: 'saved', foundation } } : {}) });
}));
revboxesRouter.delete('/context-files/:fileId', route(async (req, res, sb) => {
  await contextFileDocumentGate((await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId)).file, id => accessibleDocument(sb, req, id));
    await deleteContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId); res.json({ ok: true });
}));
// "Rebuild scoring from this ICP": the explicit trigger that rebuilds the scorecard from the file.
revboxesRouter.post('/context-files/:fileId/icp-rebuild', route(async (req, res, sb) => {
  const { file, role } = await loadContextFile(sb, req.workspaceId, req.internalUserId, req.params.fileId);
  await contextFileDocumentGate(file, id => accessibleDocument(sb, req, id));
  if (!['owner', 'admin'].includes(role)) invalid('Only a workspace owner or admin can rebuild ICP scoring.', 403);
  if (file.kind !== 'icp') invalid('Mark this file as the ICP first.');
  // On an 'external' workspace this never answers external_scorer: confirm, switch, rebuild (GET-878).
  const { icp } = await markIcpFile(sb, req.workspaceId, { rebuild: true, confirm: req.body?.confirm_scorer_switch === true });
  res.json({ icp });
}));
revboxesRouter.get('/signals',route(async(req,res,sb)=>res.json({signals:await listCustomSignals(sb,req.workspaceId,req.internalUserId)})));
revboxesRouter.post('/signals',route(async(req,res,sb)=>res.status(201).json({signal:await saveCustomSignal(sb,req.workspaceId,req.internalUserId,req.body)})));
revboxesRouter.put('/signals/:signalId',route(async(req,res,sb)=>res.json({signal:await saveCustomSignal(sb,req.workspaceId,req.internalUserId,req.body,req.params.signalId)})));
revboxesRouter.post('/signals/:signalId/reprocess',route(async(req,res,sb)=>{await revboxCreditGate(sb,req.workspaceId);res.json({signal:await reprocessCustomSignal(sb,req.workspaceId,req.internalUserId,req.params.signalId,req.body?.since)});}));
revboxesRouter.get('/catalog', route(async (req, res, sb) => {
  const [members, accounts, docs, connections] = await Promise.all([revboxWorkspaceMembers(sb, req.workspaceId), revboxAccountCatalog(sb, req.workspaceId, await allowed(sb, req)), documents(sb, req), revboxConnections(sb, req.workspaceId, req.internalUserId)]);
  res.json({ members: members.map(m => ({ id: m.user_id, name: m.user?.name ?? m.user?.email ?? 'Member', email: m.user?.email ?? '', role: m.role })), accounts, documents: docs.map(d => ({ id: d.id, title: d.title })), connections });
}));
/**
 * A box that holds an email-drafting built-in has its "Email voice" context file (GET-902): added
 * here, idempotently, on the box's read when it is missing (core ensureBoxEmailVoice, seeded with the
 * voice the drafter used until now), and named as `email_voice_id` so the rail keeps it (the drafters
 * read it; removing it would bring the default back on the next read). Checked against the context
 * the read already has, so a box that has it costs nothing more. A failure never fails the read.
 */
export async function withBoxEmailVoice(sb, ws, detail, { ensure = ensureBoxEmailVoice, reread = () => revboxContextRows(sb, ws, detail.box.id) } = {}) {
  if (!emailDraftingBuiltins(detail.box).length) return { ...detail, email_voice_id: null };
  let context = detail.context ?? [];
  let voice = context.find(isEmailVoiceFile) ?? null;
  if (!voice) {
    try {
      const made = await ensure(sb, ws, detail.box);
      if (made) { context = await reread(); voice = context.find(c => c.id === made.id) ?? null; }
    } catch (e) { console.warn('[revboxes] email voice', detail.box.id, e?.message ?? e); }
  }
  return { ...detail, context, email_voice_id: voice?.id ?? null };
}
revboxesRouter.get('/:id', route(async (req, res, sb) => {
  const detail = await withBoxEmailVoice(sb, req.workspaceId, await revboxDetails(sb, req.workspaceId, req.internalUserId, req.params.id));
  // Linked references inherit document visibility on every read, including after revocation.
  const context = [];
  for (const c of detail.context) {
    if (!c.document_id) context.push(c);
    else { try { const doc = await accessibleDocument(sb, req, c.document_id); context.push({ ...c, title: doc.title, body: doc.body_md ?? '' }); } catch (e) { if (e.status !== 404) throw e; } }
  }
  // Where the box's jobs deliver (GET-868), derived here from their real steps, with the box's own
  // access (a private channel or recipient in a step is shown to the box's members only).
  const { routines, job_deliveries } = await listRevboxJobDeliveries(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, mailboxes: () => listMailboxes(sb, req.workspaceId) });
  // The built-in jobs it lists with what they drafted (GET-872). The rail's account count is
  // GET /:id/accounts: the scope plus the accounts the box's jobs worked on (GET-891).
  const visible = await allowed(sb, req);
  const [taken, activity, facts] = await Promise.all([
    revboxBuiltinTaken(sb, req.workspaceId, req.internalUserId, req.params.id),
    revboxBuiltinActivity(sb, req.workspaceId, detail.box.builtin_jobs, { allowed: visible }),
    detail.box.builtin_jobs.length ? builtinFacts(sb, req.workspaceId) : null,
  ]);
  // Slack trouble on the cards and the rail (GET-901): the connection now and each place's latest outcome.
  const slack = await boxSlackHealth(sb, req.workspaceId, routines, detail.box);
  res.json({ ...detail, context, routines: routines.map(r => ({ ...routineOut(r), slack_status: slack?.jobs[r.id] ?? null })),
    job_deliveries: withSlackStatus(job_deliveries, slack),
    slack: slack ? { connection: slack.connection, deliveries: boxDeliveryStatuses(slack) } : null,
    builtin_jobs: builtinJobsOut(detail.box.builtin_jobs, activity, facts), builtin_taken: taken });
}));
/**
 * The box's Slack state (GET-901, core slackHealthView): read only when a job or destination posts to
 * Slack, one connection read and one runs read (the newest 100 runs of the box's jobs). Null when
 * nothing posts to Slack or the state cannot be read: the surfaces then show nothing, never a guess.
 */
export async function boxSlackHealth(sb, ws, routines, box, { connectionState = slackConnectionState } = {}) {
  const usesSlack = (routines ?? []).some(r => jobUsesSlack(r.steps, box)) || (box?.delivery ?? []).some(d => d?.kind === 'slack');
  if (!usesSlack) return null;
  try {
    const [connection, runs] = await Promise.all([
      connectionState(sb, ws),
      sb.from('agent_routine_runs').select('routine_id, status, step_log, state, started_at').eq('workspace_id', ws).in('routine_id', routines.map(r => r.id))
        .order('started_at', { ascending: false }).limit(100).then(r => (r.error ? [] : r.data ?? [])),
    ]);
    if (!connection) return null;
    return slackHealthView({ connection, routines, runs, box });
  } catch (e) {
    console.warn('[revboxes] slack health', e?.message ?? e);
    return null;
  }
}
/** The rail's job rows with their Slack state: a job's own Slack step, keyed by its job and step. Pure. */
export function withSlackStatus(jobDeliveries, slack) {
  if (!slack) return jobDeliveries;
  return (jobDeliveries ?? []).map(j => j?.kind === 'slack' && j.step_id ? { ...j, slack_status: slack.deliveries[`step:${j.job_id}:${j.step_id}`] ?? slack.connection ?? null } : j);
}
/** The box destinations' Slack state, by destination id ({ d1: status }). Pure. */
export function boxDeliveryStatuses(slack) {
  const out = {};
  for (const [key, s] of Object.entries(slack?.deliveries ?? {})) if (key.startsWith('box:')) out[key.slice(4)] = s;
  return out;
}
revboxesRouter.patch('/:id', route(async (req, res, sb) => {
  if (req.body?.scope?.mode === 'selected') {
    const ids = req.body.scope.account_ids;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !uuid.test(id))) invalid('Choose valid accounts.');
    const accounts = await revboxAccountCatalog(sb, req.workspaceId, await allowed(sb, req));
    const valid = new Set(accounts.map(a => a.id));
    if (ids.some(id => !valid.has(id))) invalid('An account is not accessible in this workspace.');
  }
  // A Gmail draft destination is made in one of the saver's own mailboxes (GET-868).
  if (Array.isArray(req.body?.delivery) && req.body.delivery.some(d => d?.kind === 'gmail')) {
    const current = await loadRevbox(sb, req.workspaceId, req.internalUserId, req.params.id, true);
    req.body.delivery = checkDeliveryMailboxes(req.body.delivery, current.delivery, await sendableMailboxes(sb, req.workspaceId, req.internalUserId));
  }
  res.json({ box: await patchRevbox(sb, req.workspaceId, req.internalUserId, req.params.id, req.body) });
}));
revboxesRouter.put('/:id/members/:memberId', route(async (req, res, sb) => {
  await setRevboxMember(sb, req.workspaceId, req.internalUserId, req.params.id, req.params.memberId, req.body?.role);
  res.json({ ok: true });
}));
revboxesRouter.post('/:id/context', route(async (req, res, sb) => {
  let body = req.body ?? {};
  if (body.file_id) { if (typeof body.file_id !== 'string' || !uuid.test(body.file_id)) invalid('Choose a valid context file.'); body = { file_id: body.file_id }; await contextFileDocumentGate((await loadContextFile(sb, req.workspaceId, req.internalUserId, body.file_id)).file, id => accessibleDocument(sb, req, id)); }   // tag an existing library file (GET-875)
  else if (body.document_id) { const doc = await accessibleDocument(sb, req, body.document_id); body = { document_id: doc.id, title: doc.title, body: '' }; }
  res.status(201).json({ context: await addRevboxContext(sb, req.workspaceId, req.internalUserId, req.params.id, body) });
}));
revboxesRouter.delete('/:id/context/:contextId', route(async (req, res, sb) => {
  await removeRevboxContext(sb, req.workspaceId, req.internalUserId, req.params.id, req.params.contextId); res.json({ ok: true });
}));
/**
 * The accounts a box works on, as its Accounts card counts them and the Accounts page and Account
 * graph open on (GET-891): its selected scope plus what its jobs worked on in 30 days, viewer-visible
 * only. `selectedOnly`: the scope alone. Both card links read this one set.
 */
export const revboxCardAccounts = (sb, ws, uid, boxId, visible, { selectedOnly = false } = {}) => revboxWorkedAccounts(sb, ws, uid, boxId, visible, { selectedOnly });
/** The Account graph for exactly those accounts (GET-891): their people and deals. */
export async function revboxCardGraph(sb, ws, uid, boxId, visible, opts = {}) {
  const { accounts } = await revboxCardAccounts(sb, ws, uid, boxId, visible, opts);
  return revboxScopedGraph(sb, ws, { mode: 'selected', account_ids: accounts.map(a => a.id), min_icp: 0 }, accounts);
}
const selectedOnly = (req) => req.query.scope === 'selected';
// The rail's Accounts card (GET-891): "Accounts · N", N = selected ∪ worked on. ?scope=selected: the scope alone.
revboxesRouter.get('/:id/accounts', route(async (req, res, sb) => {
  const { box, accounts, breakdown, days, names } = await revboxCardAccounts(sb, req.workspaceId, req.internalUserId, req.params.id, allowed(sb, req), { selectedOnly: selectedOnly(req) });   // the visibility read goes out with the box's own (GET-896)
  res.json({ accounts, count: accounts.length, accounts_count: accounts.length, accounts_breakdown: breakdown, days, names, box: { id: box.id, name: box.name, scope: box.scope } });
}));
revboxesRouter.get('/:id/graph', route(async (req, res, sb) => {
  const visible = await allowed(sb, req);
  // ?source=runs: only the accounts the box's jobs touched in their last 30 days of runs (GET-872).
  if (req.query.source === 'runs') {
    const box = await loadRevbox(sb, req.workspaceId, req.internalUserId, req.params.id);
    const accounts = await revboxAccountCatalog(sb, req.workspaceId, visible);
    const routines = await listRevboxRoutines(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId });
    const ran = await revboxRunAccounts(sb, req.workspaceId, { revboxId: box.id, routineIds: routines.map(r => r.id), allowed: visible });
    return res.json(await revboxScopedGraph(sb, req.workspaceId, { mode: 'selected', account_ids: ran.accounts.map(a => a.id), min_icp: 0 }, accounts));
  }
  // The same accounts the Accounts card counts (GET-891); ?scope=selected: the scope alone.
  res.json(await revboxCardGraph(sb, req.workspaceId, req.internalUserId, req.params.id, visible, { selectedOnly: selectedOnly(req) }));
}));
revboxesRouter.post('/:id/plan', route(async (req, res, sb) => {
  await loadRevbox(sb, req.workspaceId, req.internalUserId, req.params.id, true);
  if (req.body?.tools && (!Array.isArray(req.body.tools) || req.body.tools.length > 12 || req.body.tools.some(t => typeof t !== 'string'))) invalid('Choose valid tools.');
  const plan = await compileRevboxPlan(req.body?.prompt, { timezone: req.body?.timezone, tools: req.body?.tools }, {
    gate: async () => { const gate = await requireAiCredits(sb, req.workspaceId); if (!gate.ok) invalid(gate.body.message ?? 'Credits are required to prepare this job.', gate.status); },
    generate: createMessage,
    meter: response => recordRevboxUsage(sb, { workspaceId:req.workspaceId, userId:req.internalUserId, boxId:req.params.id, feature:'revbox-plan', model:response.model, usage:response.usage, costUsd:computeCost(response.model,response.usage), requestId:`revbox-plan:${randomUUID()}` }),
  });
  const connections = await revboxConnections(sb, req.workspaceId, req.internalUserId);
  for (const slug of plan.tools) {
    const matches = connections.filter(c => c.slug === slug);
    if (matches.length === 1) plan.bindings[slug] = matches[0].id;
  }
  res.json({ plan });
}));
revboxesRouter.post('/:id/jobs', route(async (req, res, sb) => res.status(201).json({ job: await saveRevboxJob(sb, req.workspaceId, req.internalUserId, req.params.id, req.body) })));
revboxesRouter.put('/:id/jobs/:jobId', route(async (req, res, sb) => res.json({ job: await saveRevboxJob(sb, req.workspaceId, req.internalUserId, req.params.id, req.body, req.params.jobId) })));

revboxesRouter.get('/:id/results', route(async (req,res,sb)=>{
  const runs=await listRevboxRuns(sb,req.workspaceId,req.internalUserId,req.params.id,await allowed(sb,req));
  const costs=await revboxRunCosts(sb,req.workspaceId,req.params.id,runs.map(r=>r.id));
  const results=await Promise.all(runs.map(async run=>({...run,failure:run.state==='failed'?runFailure(run.error,[]):null,cost_usd:costs.get(run.id)??0,credits:(costs.get(run.id)??0)/REQUESTED_USD_PER_CREDIT,deliveries:await revboxDeliveries(sb,run.id)})));
  // The box's workflow-engine jobs (GET-868): their runs, with what each cost in credits.
  const routines=await listRevboxRoutines(sb,{workspaceId:req.workspaceId,revboxId:req.params.id,userId:req.internalUserId});
  const routineRuns=await revboxRoutineRuns(sb,req.workspaceId,routines,{allowed:await allowed(sb,req)});
  // A failed run that hit Slack says which Slack trouble, with its action (GET-901).
  await withRunSlackStatus(sb,req,routines,routineRuns);
  res.json({results:[...results,...routineRuns].sort((a,b)=>String(b.created_at??'').localeCompare(String(a.created_at??'')))});
}));
/**
 * Results' failed routine runs gain failure.slack (GET-901: core runSlackStatus, against the connection
 * now). Reads the connection and the box only when a failed run touched Slack. Never throws.
 */
export async function withRunSlackStatus(sb, req, routines, runs, { connectionState = slackConnectionState, box = null } = {}) {
  const failed = runs.filter(r => r.failure && (/Slack/.test(String(r.error ?? '')) || (r.step_log ?? []).some(e => e?.type === 'slack' || (e?.deliveries ?? []).some(d => d?.kind === 'slack'))));
  if (!failed.length) return runs;
  try {
    const [connection, theBox] = await Promise.all([connectionState(sb, req.workspaceId), box ?? loadRevbox(sb, req.workspaceId, req.internalUserId, req.params.id).catch(() => null)]);
    const steps = new Map(routines.map(r => [r.id, r.steps]));
    for (const run of failed) {
      const slack = runSlackStatus({ connection, run, steps: steps.get(run.job_id) ?? [], box: theBox });
      if (slack) run.failure = { ...run.failure, slack };
    }
  } catch (e) { console.warn('[revboxes] run slack status', e?.message ?? e); }
  return runs;
}
/** agent_routine_runs.status -> the Results row's `state` (revbox_runs' states, so one UI reads both). */
const ROUTINE_RUN_STATE = { running: 'running', waiting: 'running', ok: 'completed', completed: 'completed', error: 'failed', failed: 'failed', awaiting_approval: 'needs_review' };
export function routineRunState(status) {
  return ROUTINE_RUN_STATE[status] ?? (typeof status === 'string' && status ? status : 'running');
}
const CONNECTION_TOOLS = { slack: 'Slack', hubspot: 'HubSpot', gmail: 'Gmail', smtp: 'the mailbox', email: 'the mailbox' };
/**
 * Why a run failed, in words (GET-872): the failed step's own text (automationRun's REASON_TEXT,
 * e.g. "Slack isn't connected"), else the run's error without its "Step 3 · Slack: " prefix, with a
 * Reconnect link to Integrations when the cause is a connection. -> { text, fix: { label, href } | null }. Pure.
 */
export function runFailure(error, stepLog) {
  const step = (Array.isArray(stepLog) ? stepLog : []).findLast(e => e?.status === 'failed');
  let text = String(step?.detail ?? error ?? '').replace(/^Step \d+ · [^:]+: /, '').trim();
  if (!text) text = 'The run stopped before it finished.';
  const connection = /not connected|isn't connected|expired|missing a permission|can't read that object|reconnect/i.test(text);
  // "the Slack connection expired. Reconnect Slack in Sources" -> "The Slack connection expired" + Reconnect.
  if (connection) text = text.replace(/[.,]?\s*reconnect\b.*$/i, '').trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const tool = CONNECTION_TOOLS[step?.type] ?? null;
  return { text, fix: connection ? { label: /isn't connected|not connected/i.test(text) ? `Connect${tool && tool !== 'the mailbox' ? ` ${tool}` : ''}` : 'Reconnect', href: '/integrations' } : null };
}
/**
 * The box's built-in jobs as the Jobs list reads them (GET-872, GET-897): definition, what each
 * drafted lately, its agent card (core builtinJobBrief: the sentence, Starts, tools, where it
 * lands) and whether it runs (`enabled`, from builtinStateOf; null when the facts are unknown). Pure.
 */
export function builtinJobsOut(keys, activity = [], facts = null) {
  const byKey = new Map(activity.map(a => [a.key, a]));
  return REVBOX_BUILTIN_JOBS.filter(j => keys.includes(j.key)).map(({ drafts: _, ...j }) => ({
    ...j, drafts_30d: byKey.get(j.key)?.drafts ?? 0, last_draft_at: byKey.get(j.key)?.last_at ?? null,
    brief: builtinJobBrief(j.key, facts ?? {}), enabled: builtinStateOf(j.key, facts ?? {}),
  }));
}
/**
 * Is this built-in running for the workspace (GET-897)? The after-call follow-up runs where
 * follow_up_settings.enabled is on; the detectors where DETECTOR_DRAFTS_WORKSPACES lists the
 * workspace. Neither is a per-box switch, so the card shows it read-only. Null when unknown. Pure.
 */
export function builtinStateOf(key, { followUpsOn, detectorsOn } = {}) {
  const v = key === 'sales_follow_up' ? followUpsOn : detectorsOn;
  return typeof v === 'boolean' ? v : null;
}
/**
 * The workspace facts the built-in cards read (GET-897): its connected meeting recorders, whether
 * approved follow-ups sync to HubSpot, and the two switches. A fact that cannot be read is left
 * unknown (the card then names no recorder, or shows no On/Off), never guessed.
 */
export async function builtinFacts(sb, ws) {
  const [slugs, settings] = await Promise.all([
    workspaceConnectedSlugs(sb, ws).catch(() => []),
    sb.from('follow_up_settings').select('enabled, crm_writeback').eq('workspace_id', ws).maybeSingle().then(r => (r.error ? undefined : r.data), () => undefined),
  ]);
  const allow = allowedWorkspaces();
  return {
    recorders: FOLLOW_UP_RECORDERS.filter(r => slugs.includes(r)),
    crm: settings?.crm_writeback === true ? 'hubspot' : null,
    followUpsOn: settings === undefined ? undefined : settings?.enabled === true,
    // DETECTOR_DRAFTS_DISABLED is the global kill switch (routes/detectorDrafts.mjs).
    detectorsOn: !/^(1|true|yes)$/i.test(String(process.env.DETECTOR_DRAFTS_DISABLED ?? '')) && (allow === '*' || allow.has(ws)),
  };
}
/** The workspace's plan id, as resolveTeamAndPlan reads it (its team's subscription). */
export async function workspacePlanId(sb, ws) {
  const { data: w, error } = await sb.from('workspaces').select('team_id').eq('id', ws).maybeSingle();
  if (error) throw error;
  if (!w?.team_id) return null;
  const { data: subs, error: e2 } = await sb.from('subscriptions').select('*').eq('team_id', w.team_id).limit(1);
  if (e2) throw e2;
  return getPlanFromSubscription(subs?.[0] ?? null).id;
}
const ENSURE_REST_MS = 10 * 60_000;
const ensuredAt = new Map();
/**
 * Ensure a Workspace-plan workspace's default built-in boxes (core ensureDefaultBuiltinBoxes) at most
 * once per ENSURE_REST_MS per workspace and process (the plan is read at most that often too, so a
 * plan change is picked up within it). Any other plan: nothing. Never throws: the
 * list it runs before must still load. -> the ensure's result, or null when skipped or failed.
 */
export async function ensureBuiltinBoxesForPlan(sb, ws, { planId, ensure = ensureDefaultBuiltinBoxes, now = Date.now() } = {}) {
  if (!ws) return null;
  const last = ensuredAt.get(ws);
  if (last != null && now - last < ENSURE_REST_MS) return null;
  try {
    // `planId` may be a lookup, made only when a pass is due.
    const id = typeof planId === 'function' ? await planId() : planId;
    if (!id || planTier(id) !== 'custom') { ensuredAt.set(ws, now); return null; }
    const out = await ensure(sb, ws); ensuredAt.set(ws, now); return out;
  }
  catch (e) { ensuredAt.set(ws, now); console.error('[revboxes] default built-in boxes', ws, e?.message ?? e); return null; }
}
/** The last box delivery the run recorded (its revbox_delivery step's per-destination results) as Results deliveries. */
export function routineRunDeliveries(runId, stepLog) {
  const entry = (Array.isArray(stepLog) ? stepLog : []).findLast(e => Array.isArray(e?.deliveries));
  return (entry?.deliveries ?? []).map((d, i) => ({
    // The reason in words (GET-879): "slack_channel_not_found" reads as what to do about it.
    id: d?.id ?? `${runId}:${i}`, state: d?.ok ? 'sent' : 'failed', error: d?.ok ? null : reasonWords(String(d?.error ?? 'Not delivered')),
    destination: { kind: String(d?.kind ?? ''), target: String(d?.target ?? '') },
  }));
}
/** A held test's step lines (runSteps' hold, GET-873) -> [{ step, text, rows }] for Results. Pure. */
export function heldActions(stepLog) {
  return (Array.isArray(stepLog) ? stepLog : []).filter(e => e?.status === 'held').map(e => ({
    step: String(e.name ?? ''), text: String(e.detail ?? ''),
    rows: (Array.isArray(e.preview) ? e.preview : []).filter(x => x?.label).map(x => ({ label: String(x.label), value: String(x.value ?? '') })),
  }));
}
/**
 * The runs of these routines, newest first, as Results rows in the Run shape the UI reads (state,
 * result, deliveries, job_id, credits, created_at), plus routine extras. The result is the run's
 * document, only when the viewer may read it (`allowed` null = unrestricted, as listRevboxRuns).
 */
export async function revboxRoutineRuns(sb, ws, routines, { limit = 200, allowed = null } = {}) {
  if (!routines.length) return [];
  const { data, error } = await sb.from('agent_routine_runs').select('id, routine_id, status, error, started_at, finished_at, document_id, step_log, state')
    .eq('workspace_id', ws).in('routine_id', routines.map(r => r.id)).order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  const runs = data ?? [];
  const credits = await creditsForRuns(sb, ws, runs);
  const names = new Map(routines.map(r => [r.id, r.name]));
  // A scheduled run records its document on the AI step's log line only (runScheduledFlow): the last one is its output.
  const docOf = (r) => r.document_id ?? (Array.isArray(r.step_log) ? r.step_log.findLast(e => e?.document_id)?.document_id : null) ?? null;
  const docIds = [...new Set(runs.map(docOf).filter(Boolean))];
  const docs = new Map();
  for (let i = 0; i < docIds.length; i += 200) {
    const { data: rows, error: docError } = await sb.from('documents').select('id, title, body_md, subject_entity_id, status')
      .eq('workspace_id', ws).in('id', docIds.slice(i, i + 200));
    if (docError) throw docError;
    for (const d of rows ?? []) {
      const doc = d.status === 'deleted' ? null : visibleDocument({ document: d }, allowed);
      if (doc) docs.set(doc.id, doc);
    }
  }
  return runs.map(r => {
    const docId = docOf(r);
    const doc = docId ? docs.get(docId) : null;
    return {
      id: r.id, kind: 'routine', job_id: r.routine_id, job_name: names.get(r.routine_id) ?? null,
      status: r.status, state: routineRunState(r.status), error: r.error ?? null,
      created_at: r.started_at, finished_at: r.finished_at ?? null, document_id: doc ? docId : null, step_log: r.step_log ?? [],
      result: doc ? { title: String(doc.title ?? 'Job run'), body: String(doc.body_md ?? ''), kind: 'report' } : null,
      deliveries: routineRunDeliveries(r.id, r.step_log),
      failure: routineRunState(r.status) === 'failed' ? runFailure(r.error, r.step_log) : null,
      test: !!r.state?.test, trigger: r.state?.trigger ?? null, credits: credits.get(r.id)?.credits ?? 0,
      // A Test's held sends (GET-873): what each step would have done, in words, with its preview.
      held: !!r.state?.held, held_actions: heldActions(r.step_log),
    };
  });
}
revboxesRouter.post('/:id/jobs/:jobId/run', route(async (req,res,sb)=>{
  // A routine job runs now on the automation engine's Run now (startTestRun), after the box's edit check.
  const routineJob=await boxRoutineOrNull(sb,req,true);
  if(routineJob){
    await revboxCreditGate(sb,req.workspaceId);
    const out=await startTestRun(sb,req.workspaceId,routineJob.routine.id);
    if(!out.ok)invalid(out.message??'This job could not start.',out.error==='not_found'?404:409);
    return res.status(202).json({run:{id:out.run_id,job_id:routineJob.routine.id,kind:'routine',status:'running',trigger:out.trigger}});
  }
  await revboxCreditGate(sb,req.workspaceId);
  const {job,snapshot,accountIds}=await makeRevboxSnapshot(sb,req.workspaceId,req.internalUserId,req.params.id,req.params.jobId);
  const run=await queueRevboxRun(sb,req.workspaceId,req.internalUserId,req.params.id,job.id,`manual:${randomUUID()}`,snapshot,accountIds);
  res.status(202).json({run});
}));

/**
 * Test a job (GET-873): one run now, on real data (the latest real trigger, or now for a schedule),
 * with every external send HELD: Slack, email, Gmail drafts and sends, webhooks, HubSpot writes and
 * box delivery only record what they would do ("Would post to #channel"). Read and AI steps run and
 * are metered as a normal run; the output is the run's document. Results marks it Test. Box edit
 * rights, the credit gate. Workflow-engine jobs only (a legacy revbox_jobs row has no held mode).
 */
revboxesRouter.post('/:id/jobs/:jobId/test', route(async (req, res, sb) => {
  const routineJob = await boxRoutineOrNull(sb, req, true);
  if (!routineJob) invalid('Only jobs made in the builder can be tested.', 409);
  await revboxCreditGate(sb, req.workspaceId);
  const out = await startTestRun(sb, req.workspaceId, routineJob.routine.id, { holdSends: true });
  if (!out.ok) invalid(out.message ?? 'This job could not start.', out.error === 'not_found' ? 404 : 409);
  res.status(202).json({ run: { id: out.run_id, job_id: routineJob.routine.id, kind: 'routine', status: 'running', test: true, held: true, trigger: out.trigger } });
}));

revboxesRouter.put('/:id/jobs/:jobId/enabled',route(async(req,res,sb)=>{
  if(typeof req.body?.enabled!=='boolean')invalid('Choose enabled or paused.');
  const routineJob=await boxRoutineOrNull(sb,req,true);
  if(routineJob){
    // The automation endpoint's rules: a trigger with a runner, credits, and the plan's automation ladder.
    const r=routineJob.routine;
    if(req.body.enabled){
      if(!BUILDER_TRIGGERS.has(r.trigger_kind))invalid('This trigger is not connected yet.');
      await revboxCreditGate(sb,req.workspaceId);
      const {plan}=await resolveTeamAndPlan(req);
      const hit=await automationLimitHit(sb,req.workspaceId,plan.id,{excludeId:r.id});
      if(hit!==null)invalid(`Your plan (${planName(plan.id)}) includes ${hit} automation${hit===1?'':'s'}. Pause or delete one first.`,402);
    }
    // A clock job's next slot from the routine runner's scheduler, as approving computes it (core approveBuilderProposal).
    const next=req.body.enabled?nextRunAt({...r,weekdays_only:r.weekdays_only===true||r.trigger_config?.weekdays_only===true}):null;
    const {data,error}=await sb.from('agent_routines').update({enabled:req.body.enabled,...(req.body.enabled?{next_run_at:next?next.toISOString():null}:{}),updated_at:new Date().toISOString()})
      .eq('workspace_id',req.workspaceId).eq('revbox_id',req.params.id).eq('id',r.id).select('*').maybeSingle();
    if(error)throw error;
    if(!data)invalid('Job not found.',404);
    return res.json({job:routineOut(data)});
  }
  const {job}=await loadRevboxJob(sb,req.workspaceId,req.internalUserId,req.params.id,req.params.jobId,true);
  const t=job.plan.trigger;
  const next=revboxNextRunAt(t);
  if(req.body.enabled && !['clock','manual','call_ended','deal_closed_won','deal_closed_lost','deal_stage_changed','account_signal','campaign_completed','webhook_in'].includes(t.kind))invalid('This signal dispatcher is not connected yet.');
  if(req.body.enabled)await revboxCreditGate(sb,req.workspaceId);
  res.json({job:await enableRevboxJob(sb,req.workspaceId,req.internalUserId,req.params.id,job.id,req.body.enabled,next?.toISOString()??null)});
}));

revboxesRouter.post('/:id/results/:runId/approve',route(async(req,res,sb)=>{
  const run=await approveRevboxRun(sb,req.workspaceId,req.internalUserId,req.params.id,req.params.runId,await allowed(sb,req));
  if(!run)invalid('This result changed. Reload before approving.',409);
  await deliverRevboxRun(sb,run);res.json({run});
}));

// ── A job's own delivery target, edited from the Delivery rail (GET-872) ─────────────────────
const STEP_KIND = (step) => step?.type === 'gmail' ? (step.config?.send_from?.kind === 'smtp' ? 'smtp' : 'gmail') : step?.type;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function recipientsOf(v, label) {
  if (v != null && typeof v !== 'string' && !(Array.isArray(v) && v.every(x => typeof x === 'string'))) invalid(`${label} must be email addresses.`);
  const list = deliveryRecipients(v);
  const bad = list.find(a => !EMAIL_RE.test(a));
  if (bad) invalid(`"${bad.slice(0, 80)}" is not an email address.`);
  return list;
}
/**
 * The step with its new target: a Slack channel the connected bot can see (id and name, never a bare
 * name), To/Cc (up to 20) for email and Gmail, a Gmail mailbox that is the caller's own (or the one
 * it already uses), a public https webhook. The step's kind never changes here. Throws 400.
 * deps: { slackTargets() -> { connected, channels }, mailboxes() -> sendable [{ id, email }], assertUrl(url) }.
 */
export async function stepWithTarget(step, body, deps) {
  const kind = STEP_KIND(step);
  if (!['slack', 'gmail', 'email', 'webhook'].includes(kind) || (kind === 'slack' && step.config?.action === 'dm')) invalid('Change this step in the job\'s chat.');
  if (!body || typeof body !== 'object' || body.kind !== kind) invalid(`This step delivers by ${kind === 'gmail' ? 'Gmail' : kind}; change its kind in the job's chat.`);
  const c = { ...(step.config ?? {}) };
  if (kind === 'slack') {
    const id = typeof body.channel_id === 'string' ? body.channel_id.trim() : '';
    if (!id) invalid('Choose a Slack channel.');
    const targets = await deps.slackTargets();
    if (!targets?.connected) invalid("Slack isn't connected.");
    const ch = (targets.channels ?? []).find(x => x.id === id);
    if (!ch) invalid("Slack can't find that channel. Choose one from the list.");
    Object.assign(c, { action: 'channel', channel_id: ch.id, channel: ch.name });
  } else if (kind === 'webhook') {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!/^https:\/\//i.test(url) || url.length > 2000) invalid('Use an https:// webhook URL.');
    try { await deps.assertUrl(url); } catch { invalid('That webhook address is not a public host.'); }
    c.url = url;
  } else {
    const to = recipientsOf(body.to, 'To'), cc = recipientsOf(body.cc, 'Cc');
    if (!to.length) invalid('Add at least one recipient.');
    if (to.length + cc.length > 20) invalid('A step emails up to 20 people.');
    const before = { to: recipientsOf(c.to ?? '', 'To').join(', '), cc: recipientsOf(c.cc ?? '', 'Cc').join(', ') };
    c.to = to.join(', '); c.cc = cc.join(', ');
    if (kind === 'gmail') {
      const current = c.send_from?.id ?? null;
      const own = await deps.mailboxes();
      if (body.mailbox_id !== undefined && body.mailbox_id !== current) {
        const mine = own.find(m => m.id === body.mailbox_id);
        if (!mine) invalid('Choose one of your own connected Gmail mailboxes.');
        c.send_from = { ...(c.send_from ?? {}), id: mine.id, kind: 'gmail', email: mine.email ?? null };
      }
      // Only the owner of the mailbox a step writes from may change who it reaches: nobody sends from a
      // colleague's Gmail to new people (GET-872 review).
      const changed = c.to !== before.to || c.cc !== before.cc;
      if (changed && c.send_from?.id && !own.some(m => m.id === c.send_from.id)) {
        invalid("Only the owner of this mailbox can change who it sends to. Pick one of your own mailboxes first.", 403);
      }
    }
  }
  return { ...step, config: c };
}
/**
 * PUT /:id/jobs/:jobId/steps/:stepId/target: box edit rights, one of the box's routines, its slack,
 * gmail, email or webhook step. Saved as automations save (checkFlow, then the steps with edited_by;
 * the database bumps agent_routines.version and keeps the automation_versions snapshot), enabled as is,
 * guarded on the version read. -> { job_deliveries }.
 */
export async function saveJobStepTarget(sb, { workspaceId, revboxId, userId, jobId, stepId, body }, deps) {
  const { routine } = await loadRevboxRoutine(sb, { workspaceId, revboxId, userId, routineId: jobId, edit: true });
  const steps = Array.isArray(routine.steps) ? routine.steps : [];
  const at = steps.findIndex(s => s?.id === stepId);
  if (at < 0) invalid('Step not found.', 404);
  const next = steps.map((s, i) => i === at ? null : s);
  next[at] = await stepWithTarget(steps[at], body, deps);
  const checked = checkFlow({ steps: next, trigger_config: routine.trigger_config });
  if (!checked.ok) invalid(checked.message ?? 'This step is not valid.');
  let q = sb.from('agent_routines').update({ steps: next, edited_by: userId, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('revbox_id', revboxId).eq('id', routine.id);
  if (routine.version != null) q = q.eq('version', routine.version);
  const { data, error } = await q.select('*').maybeSingle();
  if (error) throw error;
  if (!data) invalid('This job changed. Reload before saving.', 409);
  return data;
}
revboxesRouter.put('/:id/jobs/:jobId/steps/:stepId/target', async (req, res, next) => {
  // Step ids are short names ("post", "slack_1"), not uuids: checked here, the rest by route().
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.stepId)) return res.status(400).json({ error: 'Invalid identifier.' });
  const { stepId, ...ids } = req.params;
  req.stepId = stepId; req.params = ids;
  return stepTarget(req, res, next);
});
const stepTarget = route(async (req, res, sb) => {
  const deps = {
    slackTargets: async () => { const cloud = await loadCloud(); return cloud?.slack ? cloud.slack.targets({ supabase: sb, workspaceId: req.workspaceId }) : { connected: false, channels: [] }; },
    mailboxes: () => sendableMailboxes(sb, req.workspaceId, req.internalUserId),
    assertUrl: assertPublicUrl,
  };
  await saveJobStepTarget(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, jobId: req.params.jobId, stepId: req.stepId, body: req.body }, deps);
  const { job_deliveries } = await listRevboxJobDeliveries(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, mailboxes: () => listMailboxes(sb, req.workspaceId) });
  res.json({ job_deliveries });
});

// ── Datasets (GET-874): the tables the box's jobs keep ──────────────────────────────────────
// Read with the box's access (any member who can open it), created and changed by an owner or editor.
// Rows about an account or deal the viewer cannot see are left out (allowed(), as the box's accounts).
revboxesRouter.get('/:id/datasets', route(async (req, res, sb) => {
  res.json({ datasets: await listRevboxDatasets(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, allowed: await allowed(sb, req) }) });
}));
revboxesRouter.post('/:id/datasets', route(async (req, res, sb) => {
  res.status(201).json({ dataset: await createRevboxDataset(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, body: req.body }) });
}));
/** A dataset key is a slug, not a uuid: checked here, the box id by route(). */
const datasetRoute = (fn) => async (req, res, next) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(req.params.key)) return res.status(400).json({ error: 'Invalid identifier.' });
  const { key, ...ids } = req.params;
  req.datasetKey = key; req.params = ids;
  return route(fn)(req, res, next);
};
const one = (v) => (typeof v === 'string' ? v : undefined);
revboxesRouter.put('/:id/datasets/:key', datasetRoute(async (req, res, sb) => {
  res.json({ dataset: await updateRevboxDataset(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, key: req.datasetKey, body: req.body }) });
}));
// ?cursor=&limit=&window=&from=&to=&q= -> { dataset, rows, next_cursor }, newest first.
revboxesRouter.get('/:id/datasets/:key/rows', datasetRoute(async (req, res, sb) => {
  const q = req.query ?? {};
  if (one(q.q) && q.q.length > 200) invalid('Search for up to 200 characters.');
  res.json(await listDatasetRows(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, key: req.datasetKey,
    cursor: one(q.cursor), limit: one(q.limit), window: one(q.window), from: one(q.from), to: one(q.to), q: one(q.q), allowed: await allowed(sb, req) }));
}));
// Every visible row (up to 10,000) as CSV, with the window and search the table shows.
revboxesRouter.get('/:id/datasets/:key/export.csv', datasetRoute(async (req, res, sb) => {
  const q = req.query ?? {};
  const out = await exportDatasetCsv(sb, { workspaceId: req.workspaceId, revboxId: req.params.id, userId: req.internalUserId, key: req.datasetKey,
    window: one(q.window), q: one(q.q)?.slice(0, 200), allowed: await allowed(sb, req) });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(`\uFEFF${out.csv}`);
}));

// Approve or deny a box job's run that waits at its approval step (GET-872), with the box's edit
// rights: the run must belong to one of this box's routines.
revboxesRouter.post('/:id/results/:runId/decide',route(async(req,res,sb)=>{
  if(typeof req.body?.approve!=='boolean')invalid('Choose approve or deny.');
  await loadRevbox(sb,req.workspaceId,req.internalUserId,req.params.id,true);
  const {data:run,error}=await sb.from('agent_routine_runs').select('id, routine_id').eq('workspace_id',req.workspaceId).eq('id',req.params.runId).maybeSingle();
  if(error)throw error;
  const routines=run?await listRevboxRoutines(sb,{workspaceId:req.workspaceId,revboxId:req.params.id,userId:req.internalUserId}):[];
  if(!run||!routines.some(r=>r.id===run.routine_id))invalid('Result not found.',404);
  const out=await decideAutomationRun(sb,req.workspaceId,run.id,{approve:req.body.approve,userId:req.internalUserId});
  if(!out.ok)invalid(out.error==='not_found'?'Result not found.':'This run was already decided. Reload to see it.',out.error==='not_found'?404:409);
  res.json(out);
}));

revboxesRouter.post('/:id/jobs/:jobId/webhook-key',route(async(req,res,sb)=>{
  const key=randomBytes(32).toString('hex');
  await setRevboxWebhookKey(sb,req.workspaceId,req.internalUserId,req.params.id,req.params.jobId,createHash('sha256').update(key).digest('hex'));
  res.json({key,path:'/hooks/revboxes',header:'x-revbox-key'});
}));

revboxesRouter.post('/:id/results/:runId/retry-delivery',route(async(req,res,sb)=>{
  const run=await loadRevboxRunForEdit(sb,req.workspaceId,req.internalUserId,req.params.id,req.params.runId,await allowed(sb,req));
  if(run.state!=='completed')invalid('Approve the result before delivering it.');
  await deliverRevboxRun(sb,run);res.json({ok:true});
}));
