// Slack trouble, named (GET-901). Pure: what a failed Slack post means, what a run's Slack posts did,
// and the one state a job card, the Delivery rail and Results show for it, with its action.
//
// A daily RevBox report failed twice without anyone being told: once because the bot was not in the
// private channel after Slack was reconnected, once because the workspace's Slack connection had been
// removed. Both read as a red dot until someone opened Results. Now each surface says which it is:
//
//   disconnected  no Slack connection             "Slack disconnected" · Reconnect
//   broken        the connection stopped working  "Slack connection stopped working" · Reconnect
//                 (invalid_auth, account_inactive, token_revoked, not_authed, missing_scope, ...)
//   invite        not_in_channel, channel_not_found on a channel
//                                                 "Invite @Nous to #channel" + the /invite command to copy
//   archived      is_archived                     "Channel archived"
//
// The state is derived from the connection as it is NOW plus the latest Slack outcome on record, so a
// reconnect clears a connection problem at once and an invite clears on the next run that posts.

export const SLACK_RECONNECT_HREF = '/company-sources?connect=slack';
export const SLACK_INVITE_COMMAND = '/invite @Nous';

// The Slack Web API errors that mean the connection itself no longer works: a reconnect is the fix.
export const SLACK_CONNECTION_ERRORS = new Set([
  'invalid_auth', 'account_inactive', 'token_revoked', 'not_authed', 'missing_scope', 'token_expired',
  'app_uninstalled', 'tokens_revoked', 'team_access_not_granted', 'org_login_required', 'ekm_access_denied',
]);

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

/**
 * What a Slack failure means. Takes a step reason ('slack_invalid_auth'), Slack's own error
 * ('not_in_channel'), or the words an older step log kept ("Slack isn't connected").
 * -> { kind: 'disconnected' | 'broken' | 'not_in_channel' | 'channel_not_found' | 'archived' | 'other', connection, error } | null
 * `connection`: the connection is the problem (alert the workspace and ops), not the channel.
 */
export function classifySlackFailure(reason) {
  const r = String(reason ?? '').trim();
  if (!r) return null;
  const code = r.replace(/^slack_/, '');
  if (code === 'not_connected') return { kind: 'disconnected', connection: true, error: 'not_connected' };
  if (SLACK_CONNECTION_ERRORS.has(code)) return { kind: 'broken', connection: true, error: code };
  if (code === 'not_in_channel') return { kind: 'not_in_channel', connection: false, error: code };
  if (code === 'channel_not_found') return { kind: 'channel_not_found', connection: false, error: code };
  if (code === 'is_archived') return { kind: 'archived', connection: false, error: code };
  // The words a step log kept before it kept the reason (automationRun REASON_TEXT, older wording too).
  if (/isn't connected|not connected/i.test(r)) return { kind: 'disconnected', connection: true, error: 'not_connected' };
  if (/connection expired|missing a permission|stopped working|revoked|uninstalled/i.test(r)) return { kind: 'broken', connection: true, error: null };
  if (/isn't in that channel|not in that channel/i.test(r)) return { kind: 'not_in_channel', connection: false, error: 'not_in_channel' };
  if (/can't see that channel|can't find that channel|invite the nous app/i.test(r)) return { kind: 'channel_not_found', connection: false, error: 'channel_not_found' };
  if (/archived/i.test(r)) return { kind: 'archived', connection: false, error: 'is_archived' };
  return { kind: 'other', connection: false, error: null };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * What a run's Slack posts did, from its step log: one outcome per place it posts, the last word for
 * each. A Slack step's line is keyed `step:<routine>:<step>`; a box delivery's Slack destination
 * `box:<destination>`. Held (test) lines are not outcomes. `steps` are the job's steps now and `box`
 * the box now, for channel names and to drop an outcome whose target has since changed.
 * -> [{ key, ok, reason, kind, channel, channel_id, dm }]
 */
export function slackOutcomes(stepLog, { routineId = null, steps = [], box = null } = {}) {
  const byId = new Map(list(steps).filter(s => s && s.id).map(s => [s.id, s]));
  const dests = new Map(list(box?.delivery).filter(d => d && d.id).map(d => [d.id, d]));
  const out = new Map();
  for (const e of list(stepLog)) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'slack' && (e.status === 'ok' || e.status === 'failed')) {
      const step = byId.get(e.id);
      const c = step?.config ?? {};
      if (step && step.type !== 'slack') continue;
      const dm = c.action === 'dm';
      const now = str(c.channel_id) || str(c.channel).replace(/^#/, '');
      // The line names where it posted (GET-901); a step pointed elsewhere since is not this outcome.
      if (e.target && now && !dm && String(e.target).replace(/^#/, '') !== now) continue;
      const reason = e.status === 'ok' ? null : (e.reason ?? e.detail ?? null);
      out.set(`step:${routineId ?? ''}:${e.id ?? ''}`, {
        key: `step:${routineId ?? ''}:${e.id ?? ''}`, ok: e.status === 'ok', reason,
        kind: e.status === 'ok' ? null : classifySlackFailure(reason)?.kind ?? 'other',
        channel: str(c.channel).replace(/^#/, '') || null, channel_id: str(c.channel_id) || null, dm,
      });
    }
    for (const d of list(e.deliveries)) {
      if (!d || d.kind !== 'slack') continue;
      const dest = d.id ? dests.get(d.id) : null;
      if (box && (!dest || (dest.target && d.target && dest.target !== d.target))) continue;
      const key = `box:${d.id ?? d.target ?? ''}`;
      out.set(key, {
        key, ok: !!d.ok, reason: d.ok ? null : (d.error ?? null),
        kind: d.ok ? null : classifySlackFailure(d.error)?.kind ?? 'other',
        channel: str(dest?.channel).replace(/^#/, '') || (CHANNEL_ID.test(str(d.target)) ? null : str(d.target).replace(/^#/, '') || null),
        channel_id: CHANNEL_ID.test(str(d.target)) ? str(d.target) : null, dm: false,
      });
    }
  }
  return [...out.values()];
}

const reconnect = { label: 'Reconnect', href: SLACK_RECONNECT_HREF };

/** The connection's own state as a status, or null when it works. connection: { connected, working }. */
export function slackConnectionStatus(connection) {
  if (!connection) return null;
  if (!connection.connected) return { kind: 'disconnected', text: 'Slack disconnected', fix: reconnect };
  if (connection.working === false) return { kind: 'broken', text: 'Slack connection stopped working', fix: reconnect };
  return null;
}

/**
 * One outcome as a status, given the connection now. A connection failure that a reconnect has since
 * fixed is no longer a status; a channel problem stays until a run posts there again.
 * -> { kind, text, fix?, copy?, channel? } | null
 */
export function slackStatus({ connection = null, outcome = null } = {}) {
  const conn = slackConnectionStatus(connection);
  if (conn) return conn;
  if (!outcome || outcome.ok) return null;
  const channel = outcome.channel ? `#${outcome.channel}` : null;
  if ((outcome.kind === 'not_in_channel' || outcome.kind === 'channel_not_found') && !outcome.dm) {
    return { kind: 'invite', text: channel ? `Invite @Nous to ${channel}` : 'Invite @Nous to the channel', copy: SLACK_INVITE_COMMAND, channel: outcome.channel ?? null };
  }
  if (outcome.kind === 'archived') return { kind: 'archived', text: channel ? `Channel archived · ${channel}` : 'Channel archived', channel: outcome.channel ?? null };
  return null;
}

/** Does this job post to Slack: a Slack step, or box delivery into a box with a Slack destination. */
export function jobUsesSlack(steps, box = null) {
  const s = list(steps);
  return s.some(x => x?.type === 'slack') || (s.some(x => x?.type === 'revbox_delivery') && list(box?.delivery).some(d => d?.kind === 'slack'));
}

/**
 * The Slack state for a box's job cards and its Delivery rail (GET-901), from the connection now and
 * the runs on record (newest first; the first outcome per place wins). Test runs are skipped.
 * routines: [{ id, steps }], runs: [{ routine_id, step_log, state? }].
 * -> { connection: status | null, jobs: { [routineId]: status }, deliveries: { [key]: status } }
 */
export function slackHealthView({ connection = null, routines = [], runs = [], box = null } = {}) {
  const users = list(routines).filter(r => r?.id && jobUsesSlack(r.steps, box));
  const anySlack = users.length > 0 || list(box?.delivery).some(d => d?.kind === 'slack');
  const conn = anySlack ? slackConnectionStatus(connection) : null;
  const latest = new Map();
  const steps = new Map(list(routines).map(r => [r?.id, r?.steps]));
  for (const run of list(runs)) {
    if (!run || run.state?.test || run.state?.held) continue;
    for (const o of slackOutcomes(run.step_log, { routineId: run.routine_id, steps: steps.get(run.routine_id) ?? [], box })) {
      if (!latest.has(o.key)) latest.set(o.key, o);
    }
  }
  const deliveries = {};
  for (const [key, o] of latest) {
    const s = conn ?? slackStatus({ connection, outcome: o });
    if (s) deliveries[key] = s;
  }
  const jobs = {};
  for (const r of users) {
    if (conn) { jobs[r.id] = conn; continue; }
    const keys = list(r.steps).filter(s => s?.type === 'slack').map(s => `step:${r.id}:${s.id ?? ''}`);
    if (list(r.steps).some(s => s?.type === 'revbox_delivery')) keys.push(...list(box?.delivery).filter(d => d?.kind === 'slack').map(d => `box:${d.id}`));
    const hit = keys.map(k => deliveries[k]).find(Boolean);
    if (hit) jobs[r.id] = hit;
  }
  return { connection: conn, jobs, deliveries };
}

/**
 * Why one failed run's Slack post failed, as a status (Results, GET-901): the run's own Slack
 * outcome, against the connection now. Null when Slack was not the problem or it is fixed.
 */
export function runSlackStatus({ connection = null, run = null, steps = [], box = null } = {}) {
  const failed = slackOutcomes(run?.step_log, { routineId: run?.routine_id ?? run?.job_id ?? null, steps, box: null }).filter(o => !o.ok);
  // A step that failed before a line was written: the run's error is the only word.
  if (!failed.length) {
    const why = classifySlackFailure(/Slack:/.test(String(run?.error ?? '')) ? String(run.error).replace(/^.*?Slack:\s*/, '') : null);
    if (!why || why.kind === 'other') return null;
    failed.push({ ok: false, kind: why.kind, channel: null, dm: false });
  }
  for (const o of failed) {
    if (o.kind === 'disconnected' || o.kind === 'broken') { const s = slackConnectionStatus(connection); if (s) return s; continue; }
    const named = o.channel ? o : { ...o, channel: list(box?.delivery).find(d => d?.kind === 'slack' && o.channel_id && d.target === o.channel_id)?.channel?.replace(/^#/, '') ?? null };
    const s = slackStatus({ connection: null, outcome: named });
    if (s) return s;
  }
  return null;
}
