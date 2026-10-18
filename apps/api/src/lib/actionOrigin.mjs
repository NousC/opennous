// Where a waiting draft came from (GET-681): which automation, play or conversation wrote a
// pending_actions row, when, and why — so the Priorities inbox can say "Drafted by Stale deal
// detection · 14:05" instead of showing an anonymous email.
//
// pending_actions has no "source" column, and this change does not add one. Every path that
// writes a draft already leaves a trail in a table it owns, so the origin is READ BACK from
// those trails, most specific first:
//
//   play      — an Autopilot play's draft step records the draft it made:
//               workflow_node_runs.output.action_id → workflow_runs.play_key.
//   routine   — a custom automation (agent_routines) runs an agent turn and stores the turn's
//               tool calls on the run's thread; a propose_email result carries action_id:
//               agent_routine_runs.thread_id → playground_messages.tool_calls[].output.action_id.
//               (The run's thread is written AFTER the turn, so the draft's own thread_id is
//               null; matching on the thread alone would miss every routine draft.)
//   rec       — a draft made from a recommendation (Focus / Home) carries rec_id:
//               ri_recommendations.rec_key says which detector raised it, evidence.why says why.
//   chat      — a draft with a thread_id that no routine owns was proposed in Ask Nous.
//   agent     — /v2/drafts (the plugin, incl. the headless after-call GitHub Action) mirrors
//               every draft into ri_decisions with surface 'agent'.
//
// Everything here is best-effort: a lookup that fails leaves the origin unknown, never the
// list empty. The pure part (originOf) is what tests pin.

// The detectors behind Home's recommendations, by the automation that names them on the
// Automations page (lib/templates.ts, the locked defaults). A recommendation kind with no
// automation of its own is named for what it is.
export const REC_ORIGIN = {
  follow_up_call: 'Sales follow-up',
  follow_up_quiet: 'Stale deal detection',
  reach_out: 'Reach out',
  meeting_brief: 'Meeting brief',
};

// The built-in job behind a detector's ledger row (GET-897): rec_key 'automation.<detector>'
// (lib/detectorDrafts.mjs) -> the built-in job's key, so Priorities can say which job made it.
export const REC_BUILTIN = {
  'automation.stale_deal': 'stale_deal', 'automation.deal_risk': 'deal_risk',
  'automation.deal_signal': 'deal_signals', 'automation.expansion_signal': 'expansion',
};

// Autopilot plays by key — the labels in lib/motion.mjs PLAYS (not imported: that module pulls
// in the whole agent).
export const PLAY_ORIGIN = { nurture: 'Nurture', 'deal-rescue': 'Deal rescue', 'multi-thread': 'Multi-thread' };

// A routine's trigger, where it says something the draft's own rationale does not ("on its
// schedule" says nothing; the rationale carries the real reason).
const TRIGGER_WHY = {
  before_meeting: 'Before your meeting',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** The action ids a run's stored tool calls drafted. */
export function draftedIds(toolCalls) {
  const out = [];
  for (const t of Array.isArray(toolCalls) ? toolCalls : []) {
    const id = t?.output?.action_id;
    if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}

/**
 * One action's origin from the trails already loaded. Pure.
 * Returns { source, name, why, at, run_id?, routine_id?, play_key?, thread_id?, rec_id? }.
 */
export function originOf(action, { plays = new Map(), routines = new Map(), recs = new Map(), decisions = new Map(), routineThreads = new Set() } = {}) {
  const at = action.created_at ?? null;
  const play = plays.get(action.id);
  if (play) {
    return { source: 'play', name: PLAY_ORIGIN[play.play_key] ?? play.play_key ?? 'Autopilot', why: null, at, run_id: play.run_id ?? null, play_key: play.play_key ?? null };
  }
  const routine = routines.get(action.id);
  if (routine) {
    return {
      source: 'routine', name: routine.name || 'Automation', why: TRIGGER_WHY[routine.trigger_kind] ?? null, at,
      run_id: routine.run_id ?? null, routine_id: routine.routine_id ?? null, thread_id: routine.thread_id ?? null,
    };
  }
  const rec = action.rec_id ? recs.get(action.rec_id) : null;
  if (rec) {
    return {
      source: 'rec', name: REC_ORIGIN[rec.rec_key] ?? rec.text ?? 'Recommendation', why: rec.evidence?.why ?? null, at, rec_id: rec.id, builtin: REC_BUILTIN[rec.rec_key] ?? null,
      // A snooze holds the draft it was set on, never a later one on the same ledger row (GET-944).
      signal: signalOf(rec), snoozed_until: rec.evidence?.snoozed_action_id === action.id ? rec.evidence?.snoozed_until ?? null : null,
    };
  }
  if (action.thread_id && !routineThreads.has(action.thread_id)) {
    return { source: 'chat', name: 'Ask Nous', why: null, at, thread_id: action.thread_id };
  }
  const d = decisions.get(action.id);
  // A canvas automation's own step (GET-543): the step runner marks the draft with its name.
  if (d && d.surface === 'automation' && d.payload?.automation_name) {
    return { source: 'routine', name: d.payload.automation_name, why: d.payload.why ?? null, at, routine_id: d.payload.routine_id ?? null };
  }
  if (d && d.surface === 'agent') return { source: 'agent', name: 'Your agent', why: null, at };
  return { source: 'app', name: 'OpenNous', why: null, at };
}

/**
 * The signal behind a Deal signals draft (GET-944), as the inbox's From signals pane reads it: what
 * was said, by whom and when, and what the play found out about the person it named. Pure.
 */
export function signalOf(rec) {
  const t = rec?.rec_key === 'automation.deal_signal' ? rec.evidence?.trigger : null;
  if (!t?.kind) return null;
  const r = t.research;
  return {
    kind: t.kind, label: t.label ?? null, said_at: t.said_at ?? null, text: t.text ?? null,
    quote: t.quote ?? rec.evidence?.quote ?? null, speaker: t.speaker ?? null, role: t.role ?? null,
    research: r?.name ? { name: r.name, title: r.title ?? null, source_url: r.source_url ?? null, source_title: r.source_title ?? null, contact_id: r.contact_id ?? null } : null,
  };
}

/** The account a draft is for — the company behind a person — for the row's logo. Pure. */
export function accountOf(entityId, { companies = new Map(), contacts = new Map() } = {}) {
  if (!entityId) return null;
  const co = companies.get(entityId);
  if (co) return { id: co.id, name: co.name ?? null, domain: co.domain ?? null, person: null };
  const ct = contacts.get(entityId);
  if (!ct) return null;
  const person = [ct.first_name, ct.last_name].filter(Boolean).join(' ') || null;
  const parent = ct.company_id ? companies.get(ct.company_id) : null;
  return parent
    ? { id: parent.id, name: parent.name ?? null, domain: parent.domain ?? null, person }
    : { id: null, name: null, domain: ct.domain ?? null, person };
}

const settle = (p) => Promise.resolve(p).then((r) => r?.data ?? [], () => []);

/**
 * Load every trail for these actions and return them with `origin` and `account` added.
 * Additive: each action keeps every field it had.
 */
export async function withOrigins(supabase, workspaceId, actions) {
  if (!actions.length) return actions;
  const ids = actions.map((a) => a.id);
  const recIds = uniq(actions.map((a) => a.rec_id)).filter((x) => UUID.test(x));
  const oldest = actions.reduce((m, a) => (a.created_at && a.created_at < m ? a.created_at : m), actions[0].created_at ?? new Date().toISOString());
  // A routine's run starts before its draft is written; an hour of slack covers a long turn.
  const since = new Date(Date.parse(oldest) - 3600_000).toISOString();
  const entityIds = uniq(actions.map((a) => a.entity_id));

  const [nodes, runs, recs, decisions, companies, contacts] = await Promise.all([
    settle(supabase.from('workflow_node_runs').select('run_id, output').in('output->>action_id', ids)),
    settle(supabase.from('agent_routine_runs').select('id, routine_id, thread_id, started_at')
      .eq('workspace_id', workspaceId).gte('started_at', since).not('thread_id', 'is', null).limit(200)),
    recIds.length ? settle(supabase.from('ri_recommendations').select('id, rec_key, text, evidence').in('id', recIds)) : [],
    settle(supabase.from('ri_decisions').select('decision_id, surface, agent, payload').eq('workspace_id', workspaceId).in('decision_id', ids.map((i) => `app:${i}`))),
    entityIds.length ? settle(supabase.from('companies').select('id, name, domain').in('id', entityIds)) : [],
    entityIds.length ? settle(supabase.from('contacts').select('id, first_name, last_name, company_id, domain').in('id', entityIds)) : [],
  ]);

  const runIds = uniq(nodes.map((n) => n.run_id));
  const threadIds = uniq(runs.map((r) => r.thread_id));
  const routineIds = uniq(runs.map((r) => r.routine_id));
  const parentIds = uniq(contacts.map((c) => c.company_id)).filter((id) => !companies.some((c) => c.id === id));
  const [playRuns, messages, routineRows, parents] = await Promise.all([
    runIds.length ? settle(supabase.from('workflow_runs').select('id, play_key').in('id', runIds)) : [],
    threadIds.length ? settle(supabase.from('playground_messages').select('thread_id, tool_calls')
      .in('thread_id', threadIds).eq('role', 'assistant').not('tool_calls', 'is', null)) : [],
    routineIds.length ? settle(supabase.from('agent_routines').select('id, name, trigger_kind').in('id', routineIds)) : [],
    parentIds.length ? settle(supabase.from('companies').select('id, name, domain').in('id', parentIds)) : [],
  ]);

  const playKey = new Map(playRuns.map((r) => [r.id, r.play_key]));
  const plays = new Map(nodes.map((n) => [n.output?.action_id, { run_id: n.run_id, play_key: playKey.get(n.run_id) ?? null }]));
  const runByThread = new Map(runs.map((r) => [r.thread_id, r]));
  const routineById = new Map(routineRows.map((r) => [r.id, r]));
  const routines = new Map();
  for (const m of messages) {
    const run = runByThread.get(m.thread_id);
    const routine = run && routineById.get(run.routine_id);
    if (!routine) continue;
    for (const id of draftedIds(m.tool_calls)) {
      routines.set(id, { name: routine.name, trigger_kind: routine.trigger_kind, run_id: run.id, routine_id: routine.id, thread_id: run.thread_id });
    }
  }
  // A draft whose own thread is a routine run's thread is that routine's, too.
  for (const a of actions) {
    const run = a.thread_id && runByThread.get(a.thread_id);
    const routine = run && routineById.get(run.routine_id);
    if (routine && !routines.has(a.id)) routines.set(a.id, { name: routine.name, trigger_kind: routine.trigger_kind, run_id: run.id, routine_id: routine.id, thread_id: run.thread_id });
  }
  const trails = {
    plays, routines,
    recs: new Map(recs.map((r) => [r.id, r])),
    decisions: new Map(decisions.map((d) => [String(d.decision_id).replace(/^app:/, ''), d])),
    routineThreads: new Set(threadIds),
  };
  const labels = {
    companies: new Map([...companies, ...parents].map((c) => [c.id, c])),
    contacts: new Map(contacts.map((c) => [c.id, c])),
  };
  return actions.map((a) => ({ ...a, origin: originOf(a, trails), account: accountOf(a.entity_id, labels) }));
}
