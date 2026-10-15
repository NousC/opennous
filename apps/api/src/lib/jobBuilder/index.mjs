// The RevBox Job Builder (GET-868), wired: sessions, the turn, approve. See
// docs/revboxes/JOB_BUILDER.md; the turn itself is loop.mjs, the tools tools.mjs.
//
// Both doors use this: the in-app SSE route (routes/api/revboxBuilder.mjs) and the public
// API (routes/v2/revboxes.mjs, the same turn non-streaming). Same access, credits and validation
// either way, on every edition (GET-905).
//
// Sessions and approve are the engine's (packages/core/src/db/revboxBuilder.mjs). They are looked
// up on the core namespace at call time, so this module loads, and answers 503
// job_builder_not_ready, on a build whose core does not carry them yet.
import * as core from '@nous/core';
import { claudeClientOptions, routeClaudeClient } from '@nous/core';
import Anthropic from 'useleak';
import { jobBuilderModel } from '../model.mjs';
import { computeCost, costToCredits } from '../llmUsage.mjs';
import { revboxCreditGate } from '../revboxRuntime.mjs';
import { providerAlert, noProviderMessage } from '../providerAlert.mjs';
import { runBuilderTurn, FEATURE, idsForValidation, withUserTurn, canRetry } from './loop.mjs';
import { defaultHelpers, memo } from './tools.mjs';

export { collectTurn } from './loop.mjs';

const ENGINE = ['createBuilderSession', 'getBuilderSession', 'saveBuilderSession', 'approveBuilderProposal', 'validateBuilderProposal', 'listRevboxRoutines'];
const fail = (status, error, message) => { throw Object.assign(new Error(message), { status, code: error }); };

// The extended cache TTL is behind a beta header on Anthropic direct, as in playgroundAgent.mjs.
// OpenRouter takes cache_control.ttl in the body and gets no beta header.
const ANTHROPIC_BETA = { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' };

/**
 * The builder's Claude client -> { client, provider }. OpenRouter's Anthropic-compatible Messages
 * endpoint when OPENROUTER_API_KEY is set, Anthropic direct only without it (GET-885); the same
 * Messages format either way, so the loop is unchanged. Throws when neither key is set.
 */
export async function builderClient({ env = process.env, SDK = Anthropic } = {}) {
  const route = claudeClientOptions({ env, headers: ANTHROPIC_BETA });
  if (!route) throw Object.assign(new Error('no model provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY)'), { noProvider: true });
  const wrapper = new SDK(route.options);
  return { client: routeClaudeClient(await wrapper.getClient(), route.provider), provider: route.provider };
}

/**
 * The builder with its collaborators. Tests pass overrides (engine, client, helpers, gate, …);
 * production uses the defaults.
 */
export function makeJobBuilder(o = {}) {
  const engine = () => {
    const e = o.engine ?? core;
    const missing = ENGINE.filter(n => typeof e[n] !== 'function');
    if (missing.length) fail(503, 'job_builder_not_ready', 'The job builder is not available on this build yet.');
    return e;
  };

  /** -> { session, isNew }. Throws { status, code } before any stream opens. */
  async function openSession({ sb, workspaceId, userId, revboxId, sessionId = null, jobId = null }) {
    const e = engine();
    if (!sessionId) return { session: await e.createBuilderSession(sb, { workspaceId, revboxId, userId, jobId }), isNew: true };
    const session = await e.getBuilderSession(sb, { workspaceId, userId, sessionId, revboxId });
    if (!session || session.revbox_id !== revboxId) fail(404, 'session_not_found', 'This builder session was not found.');
    if (session.state !== 'open') fail(409, 'session_closed', 'This builder session is closed. Start a new one.');
    return { session, isNew: false };
  }

  /** The turn's events (async iterable). Never throws: failures are error events. */
  async function* runTurn({ sb, workspaceId, userId, revboxId, session, isNew = false, message = null, answers = null, hints = null, retry = false, signal = null }) {
    const e = engine();
    // Two tabs on one chat (GET-889): a turn saves only over the transcript it read. If the other
    // tab saved first, this turn's save is refused and says so, instead of silently replacing it.
    const readAt = session.updated_at ?? null;
    const save = async ({ messages, proposal }) => {
      const wrote = await e.saveBuilderSession(sb, { workspaceId, sessionId: session.id, userId, messages, proposal, expectUpdatedAt: readAt });
      if (wrote !== false) return;
      const now = await e.getBuilderSession(sb, { workspaceId, userId, sessionId: session.id, revboxId }).catch(() => null);
      // Approved meanwhile: a turn that finishes after approval changes nothing, as before.
      if (now && now.state === 'open') throw Object.assign(new Error('This chat changed in another tab. Open the job again to see the latest.'), { builderCode: 'session_conflict' });
    };
    let client = o.client ?? null;
    let provider = o.provider ?? null;
    let job = null;
    let builtin = null;
    try {
      if (!client) ({ client, provider } = await builderClient());
      if (session.job_id) {
        const routines = await e.listRevboxRoutines(sb, { workspaceId, revboxId, userId });
        const r = (routines ?? []).find(x => x.id === session.job_id);
        if (r) job = { id: r.id, name: r.name, trigger: { kind: r.trigger_kind, config: r.trigger_config ?? {}, timezone: r.timezone ?? null }, steps: r.steps ?? [] };
      } else {
        // A built-in job's chat (GET-902): never a routine (no job_id), so approve only ever creates a
        // new job; the built-in's facts and the builtin_job tool come from the box as it is now.
        const key = (e.builtinOfTranscript ?? core.builtinOfTranscript)?.(session.messages ?? []) ?? null;
        if (key) builtin = await Promise.resolve((o.helpers ?? defaultHelpers()).builtinInfo?.({ sb, workspaceId, userId, revboxId }, key))
          .catch(err => { console.error('[job-builder] built-in', err?.message ?? err); return null; }) ?? null;
      }
    } catch (err) {
      console.error('[job-builder] setup', err?.message ?? err);
      if (isNew) yield { type: 'session', session_id: session.id };
      // The message is kept even so (GET-889): it shows on reopen, with Try again.
      if (!retry || !canRetry(session.messages)) {
        const said = typeof message === 'string' ? message.trim() : '';
        if (said) await save({ messages: withUserTurn(session.messages ?? [], { said, userText: said }), proposal: session.proposal ?? null }).catch(e2 => console.error('[job-builder] save failed', e2?.message ?? e2));
      }
      if (err?.noProvider) {
        // No model key at all is an outage ops must hear about, like a rejected one.
        (o.alert ?? providerAlert)({ provider: 'none', kind: 'auth', feature: FEATURE, err });
        yield { type: 'error', code: 'model_unavailable', message: noProviderMessage("The job builder's AI model", o.selfHosted === undefined ? undefined : { selfHosted: o.selfHosted }) };
      } else {
        yield { type: 'error', code: 'unavailable', message: 'The job builder is not available right now.' };
      }
      yield { type: 'done' };
      return;
    }
    yield* runBuilderTurn({
      session, isNew, message, answers, hints, retry,
      ctx: { sb, workspaceId, userId, revboxId },
      deps: {
        client,
        model: o.model ?? jobBuilderModel(),
        helpers: o.helpers ?? defaultHelpers(),
        gate: o.gate ?? (() => revboxCreditGate(sb, workspaceId)),
        meter: o.meter ?? (({ response, requestId, costUsd }) => core.recordRevboxUsage(sb, {
          workspaceId, userId, boxId: revboxId, feature: FEATURE, model: response.model, usage: response.usage, costUsd, requestId,
        })),
        costOf: o.costOf ?? computeCost,
        toCredits: o.toCredits ?? costToCredits,
        validate: (proposal, ids) => e.validateBuilderProposal(proposal, ids),
        // No `state`: a turn never opens, closes or reopens a session (approve does).
        save,
        job, builtin, signal, today: o.today,
        provider: provider ?? 'anthropic', ...(o.alert ? { alert: o.alert } : {}),
      },
    });
  }

  /**
   * Approve the session's latest proposal -> { routine, facts?, enabled, reason?, warnings? }. A new job
   * is switched on, an Edit keeps the job on or paused as it was (core); a job that will be on gets
   * the enable endpoint's checks (core checks the trigger has a runner): the credit gate, and the
   * plan's automation limit (`limitHit(opts)`, automationLimitHit's options: an existing job passes
   * { excludeId } so it does not count itself, as the enable endpoint does). A failed check saves the
   * job off and says why in `reason`; it never refuses the approval. When the job ends in box
   * delivery, the owners of the box's Gmail destination mailboxes go to core (`mailboxOwners`), which
   * warns about a mailbox the approver does not own (review 8).
   */
  async function approve({ sb, workspaceId, userId, revboxId, sessionId, name = null, limitHit = null }) {
    const e = engine();
    const session = await e.getBuilderSession(sb, { workspaceId, userId, sessionId, revboxId });
    if (!session || session.revbox_id !== revboxId) fail(404, 'session_not_found', 'This builder session was not found.');
    if (!session.proposal) fail(409, 'no_proposal', 'There is no proposal to approve yet.');
    // An inline rename on the card replaces the proposal's name; nothing else is taken from the client.
    const rename = typeof name === 'string' ? name.trim().slice(0, 120) : '';
    const proposal = rename ? { ...session.proposal, name: rename } : session.proposal;
    const gate = o.gate ?? (() => revboxCreditGate(sb, workspaceId));
    const enableCheck = async ({ isNew, routineId = null }) => {
      await gate();   // throws the credit gate's message, which becomes the reason
      // The plan's automation limit, as the enable endpoint checks it: an existing job is not counted twice.
      if (limitHit) {
        const hit = await limitHit(isNew || !routineId ? {} : { excludeId: routineId });
        if (hit !== null && hit !== undefined) return `Your plan includes ${hit} automation${hit === 1 ? '' : 's'}. Pause or delete one, then switch this job on.`;
      }
      return null;
    };
    // Targets are re-checked now: a channel or mailbox can disappear between proposal and approval,
    // and a box destination can be added. The facts the session carried are the card's; approve
    // derives its own from the steps.
    const { facts: _shown, brief: _brief, ...toApprove } = proposal;
    const h = o.helpers ?? defaultHelpers();
    const ctx = { sb, workspaceId, userId, revboxId };
    const cached = memo(h, ctx);
    const ids = await idsForValidation(toApprove, cached);
    const owners = toApprove.uses_box_delivery === true ? await mailboxOwnersFor(ids.boxDestinations, cached, (uids) => (h.userNames ? h.userNames(ctx, uids) : new Map())) : null;
    return e.approveBuilderProposal(sb, { workspaceId, revboxId, userId, sessionId, proposal: toApprove, ...ids, ...(owners ? { mailboxOwners: owners } : {}), enableCheck });
  }

  /**
   * Open a job's chat: this user's own conversation on it (GET-889: their open session reused, else
   * one seeded from their last chat or the job's approved setup), with every turn as `history` for
   * the UI -> { session, history, source_session_id }. No model call.
   */
  async function openForJob({ sb, workspaceId, userId, revboxId, jobId }) {
    const e = o.engine ?? core;
    if (typeof e.openBuilderSessionForJob !== 'function') fail(503, 'job_builder_not_ready', 'The job builder is not available on this build yet.');
    return e.openBuilderSessionForJob(sb, { workspaceId, revboxId, userId, jobId });
  }

  /**
   * Open a built-in job's chat (GET-902): this person's chat on it in this box (reused), seeded with
   * its card, on a session with no job -> { session, history }. 404 when the box does not list it.
   * No model call.
   */
  async function openForBuiltin({ sb, workspaceId, userId, revboxId, key }) {
    const e = o.engine ?? core;
    if (typeof e.openBuilderSessionForBuiltin !== 'function') fail(503, 'job_builder_not_ready', 'The job builder is not available on this build yet.');
    const info = await (o.helpers ?? defaultHelpers()).builtinInfo({ sb, workspaceId, userId, revboxId }, key);
    if (!info) fail(404, 'builtin_not_found', 'This built-in job is not in this RevBox.');
    const card = { name: info.name, text: info.brief?.text ?? null, details: info.brief?.details ?? [], enabled: info.enabled };
    return e.openBuilderSessionForBuiltin(sb, { workspaceId, revboxId, userId, key, card });
  }

  return { openSession, runTurn, approve, openForJob, openForBuiltin };
}

export const jobBuilder = makeJobBuilder();

/**
 * The mailboxes behind the box's Gmail destinations with their owners: [{ id, email, user_id,
 * user_name }], or null when there is no Gmail destination. A lookup that fails warns about nothing.
 */
export async function mailboxOwnersFor(boxDestinations, cached, names) {
  const wanted = new Set((Array.isArray(boxDestinations) ? boxDestinations : []).filter(d => d?.kind === 'gmail' && d.target).map(d => String(d.target).trim()));
  if (!wanted.size) return null;
  const boxes = (await cached.mailboxes().catch(() => [])).filter(m => wanted.has(String(m.id)) && m.owner_user_id);
  if (!boxes.length) return [];
  const uids = [...new Set(boxes.map(m => m.owner_user_id))];
  const byId = await Promise.resolve(names(uids)).catch(() => new Map());
  return boxes.map(m => ({ id: m.id, email: m.email ?? null, user_id: m.owner_user_id, user_name: byId?.get?.(m.owner_user_id) ?? null }));
}

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const SIGNAL_KEY = /^[a-z0-9][a-z0-9_.:-]{0,119}$/i;

/**
 * The composer's optional `hints: { integrations: [slug], signals: [key] }` -> a clean copy, or null
 * when absent. An older composer's `signal: key | null` is one signal (GET-873 made it a list); the
 * copy carries both, `signal` being the first. Shape only: the keys are checked against the catalog
 * in the turn.
 */
export function parseHints(raw) {
  if (raw === undefined || raw === null) return null;
  const bad = () => fail(400, 'invalid_hints', 'hints must be { integrations: [slugs], signals: [keys] } (or signal: key | null).');
  if (typeof raw !== 'object' || Array.isArray(raw)) bad();
  const integrations = raw.integrations ?? [];
  if (!Array.isArray(integrations) || integrations.length > 12 || integrations.some(x => typeof x !== 'string' || !SLUG.test(x.trim()))) bad();
  const key = (k) => typeof k === 'string' && SIGNAL_KEY.test(k.trim());
  const signal = raw.signal ?? null;
  if (signal !== null && !key(signal)) bad();
  const given = raw.signals ?? null;
  if (given !== null && (!Array.isArray(given) || given.length > 20 || !given.every(key))) bad();
  const signals = [...new Set((given ?? (signal === null ? [] : [signal])).map(k => k.trim()))];
  return { integrations: [...new Set(integrations.map(x => x.trim().toLowerCase()))], signal: signals[0] ?? null, signals };
}

/**
 * Request body -> { message, answers, hints, retry } or a 400. Shared by the SSE route and /v2.
 * `{ retry: true }` (GET-889) runs the last unanswered turn again (it is already saved).
 */
export function turnInput(body) {
  if (body?.retry === true) {
    if (body.message !== undefined || body.answers !== undefined) fail(400, 'invalid_retry', 'A retry carries no message or answers.');
    return { message: null, answers: null, hints: null, retry: true };
  }
  const hints = parseHints(body?.hints);
  const answers = body?.answers;
  if (answers !== undefined) {
    if (!Array.isArray(answers) || !answers.length || answers.length > 10 || answers.some(a => !a || typeof a !== 'object')) fail(400, 'invalid_answers', 'answers must be a list of { id, selected, other? }.');
    return { message: null, answers, hints, retry: false };
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) fail(400, 'message_required', 'Send a message or answers.');
  if (message.length > 8000) fail(413, 'message_too_long', 'That message is too long.');
  return { message, answers: null, hints, retry: false };
}
