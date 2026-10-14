// Local-only fixture persistence. Never imported by production authentication or API.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { COMPANIES, CONTACTS, DEALS, USERS, WS, GRAPH } from './world.mjs';
import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount, revboxExecutionRequirements } from '../../../packages/core/src/services/revboxPlan.mjs';
import { validateRevboxPatch, revboxAccess } from '../../../packages/core/src/db/revboxes.mjs';

const storePath = process.env.REVBOX_PREVIEW_STATE ?? '/private/tmp/opennous-revboxes-preview.json';
const stamp = () => new Date().toISOString();
const base = (name, objective, shared, scope) => ({ id: randomUUID(), workspace_id: WS, owner_id: 'u1', name, objective, shared, scope, blocks: [], delivery: [], revision: 1, created_at: stamp(), updated_at: stamp(), members: [] });
let state;
try { state = JSON.parse(await readFile(storePath, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const handoff = base('Customer onboarding', 'Give customer success the context to make every new customer successful.', true, { mode: 'won', account_ids: [], min_icp: 70 });
  handoff.blocks = [{ id: randomUUID(), title: 'Goals & KPIs', body: 'A complete handoff within one business day of every new win. Include the buying reason, commitments, stakeholders and first 30-day milestone.' }, { id: randomUUID(), title: 'Output format', body: 'Start with a short summary. Then: why they bought, people, promises, risks, and the first next step. Cite the source of each promise.' }];
  handoff.delivery = [{ id: randomUUID(), kind: 'slack', target: '#cs-handoffs' }];
  const followup = base('Meeting follow-ups', 'Turn every customer conversation into a clear, thoughtful next step.', false, { mode: 'icp', account_ids: [], min_icp: 70 });
  state = { boxes: [handoff, followup], jobs: [], context: [] };
  const prompt = 'When a HubSpot deal is closed won, write a customer success onboarding brief. Include the promises and risks. Post it to the CS Handoffs Slack channel.';
  state.jobs.push({ id: randomUUID(), revbox_id: handoff.id, workspace_id: WS, created_by: 'u1', name: 'Closed-won handoff', prompt, plan: proposeRevboxPlan(prompt), state: 'draft', version: 1, snapshots: [], created_at: stamp(), updated_at: stamp() });
  await writeFile(storePath, JSON.stringify(state, null, 2));
}
state.results ??= [];
state.signals ??= [];
// Signals from before GET-862 were box-scoped and keyless: give them what a workspace signal has.
for (const sg of state.signals) { sg.key ??= previewSignalKey(sg.name, state.signals.filter(x => x !== sg && x.key).map(x => x.key)); sg.sources ??= []; sg.archived_at ??= null; sg.owner_id ??= 'u1'; sg.active ??= false; sg.examples ??= ''; sg.revbox_id ??= null; }
state.routines ??= [];
// Email and Gmail draft destinations, and a job that delivers on its own (GET-868), once per state file.
state.seeded ??= {};
if (!state.seeded.delivery_kinds) {
  const onboarding = state.boxes.find(b => b.name === 'Customer onboarding');
  if (onboarding) {
    onboarding.delivery.push({ id: randomUUID(), kind: 'email', target: 'cs-leads@acme.example' },
      { id: randomUUID(), kind: 'gmail', target: 'mb-1', to: 'onboarding@acme.example', mailbox_email: 'avery@opennous.example' });
    state.routines.unshift({ id: randomUUID(), revbox_id: onboarding.id, source: 'routine', name: 'CS handoff', enabled: false, trigger_kind: 'deal_closed_won', trigger_config: {}, timezone: 'UTC', trigger_label: 'When a deal is won', last_run_at: null, version: 1, created_by: 'u1', steps: [
      { id: 'brief', type: 'agent', config: { mode: 'write', prompt: 'Write the onboarding brief.' } },
      { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0LEAD', channel: 'cs-leadership', text: '{{steps.brief.output}}' } },
      { id: 'mail', type: 'gmail', config: { mode: 'draft', to: 'champion@acme.example', body: '{{steps.brief.output}}', send_from: { id: 'mb-1', kind: 'gmail' } } },
      { id: 'notify', type: 'email', config: { to: 'implementation@acme.example', body: '{{steps.brief.output}}' } },
      { id: 'hook', type: 'webhook', config: { url: 'https://hooks.acme.example/onboarding?key=preview' } },
    ] });
  }
  state.seeded.delivery_kinds = true;
}
// Mail destinations carry To and Cc, and a Slack destination is a picked channel (GET-868), once per state file.
if (!state.seeded.delivery_cc) {
  for (const b of state.boxes) for (const d of b.delivery ?? []) {
    if (d.kind === 'email') { d.to ??= d.target; d.cc ??= b.name === 'Customer onboarding' ? 'cs-ops@acme.example' : ''; }
    if (d.kind === 'gmail') d.cc ??= '';
    if (d.kind === 'slack' && d.target === '#cs-handoffs') { d.target = 'C07CSHANDOFFS'; d.channel = 'cs-handoffs'; }
  }
  state.seeded.delivery_cc = true;
}
let writes = Promise.resolve();
async function persist() { const snapshot = JSON.stringify(state, null, 2); writes = writes.then(async () => { await writeFile(`${storePath}.next`, snapshot); await rename(`${storePath}.next`, storePath); }); await writes; }

// The core signal catalog, from the built package (src pulls in TypeScript the preview cannot run).
// Without a build, a small stand-in keeps the picker and Settings working.
let catalogModule = null;
try { catalogModule = await import('../../../packages/core/dist/services/signalCatalog.mjs'); } catch { /* not built */ }
// The job deliveries the sidebar lists (GET-868), from the same core derivation; none without a build.
let builderModule = null;
try { builderModule = await import('../../../packages/core/dist/db/revboxBuilder.mjs'); } catch { /* not built */ }
// A clock job's next slot when approving switches it on, from the routine runner's own scheduler.
let scheduleModule = null;
try { scheduleModule = await import('../../../packages/core/dist/services/routineSchedule.mjs'); } catch { /* not built */ }
// The preview user's own Gmail accounts, as /api/actions/mailboxes answers in server.mjs.
const PREVIEW_MAILBOXES = [{ id: 'mb-1', kind: 'gmail', email: 'avery@opennous.example' }, { id: 'mb-2', kind: 'gmail', email: 'test.user.0001@gmail.com' }];
function previewSignalKey(name, taken) {
  let k = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k)) k = `signal_${k}`.replace(/_+$/, '');
  k = k.slice(0, 63) || 'signal';
  let out = k; for (let n = 2; taken.includes(out); n++) out = `${k}_${n}`;
  return out;
}
function previewCatalog() {
  const custom = state.signals;
  if (catalogModule) return { ...catalogModule.signalCatalog({ custom }), groups: catalogModule.SIGNAL_GROUPS };
  return {
    builtin: [
      { key: 'meeting.done', label: 'Meeting done', description: 'A recorded meeting ended and its notes are in.', group: 'meetings', providers: ['granola', 'fireflies', 'fathom', 'any'], trigger: { kind: 'call_ended', config: {} } },
      { key: 'deal.won', label: 'Deal won', description: 'A deal moved to closed won.', group: 'deals', trigger: { kind: 'deal_closed_won', config: {} } },
      { key: 'signal.churn_risk', label: 'Churn risk', description: 'The customer showed a risk of churning.', group: 'account', trigger: { kind: 'account_signal', config: { signals: ['churn_risk'] } } },
      { key: 'schedule', label: 'On a schedule', description: 'No signal: the job runs on a clock (the default).', group: 'schedule', trigger: { kind: 'clock', config: {} } },
    ],
    custom: custom.filter(d => !d.archived_at).map(d => ({ key: `custom.${d.key}`, label: d.name, description: d.rule, group: 'custom', id: d.id, active: !!d.active, version: d.version, sources: d.sources, trigger: { kind: 'account_signal', config: { signals: [`custom_${d.id}`] } } })),
  };
}
/** /api/signals (GET-862): catalog, list, create, edit/review, archive, reprocess. Same rules as core. */
async function signalsPreview(req, res, json, parts, payload, uid) {
  const [id, action] = parts;
  if (id === 'catalog' && req.method === 'GET') return json(res, previewCatalog());
  if (!id && req.method === 'GET') return json(res, { signals: state.signals.map(sg => ({ ...sg, archived: !!sg.archived_at, hits: sg.active && !sg.archived_at ? (sg.name.length * 7) % 23 : 0 })) });
  if (!id && req.method === 'POST') {
    if (!payload.name?.trim() || !payload.rule?.trim()) fail(400, 'Choose a name, rules and examples within the limits.');
    const taken = state.signals.map(sg => sg.key);
    if (payload.key != null && !/^[a-z][a-z0-9_]{1,62}$/.test(payload.key)) fail(400, 'A key is 2-63 lowercase letters, digits or underscores, starting with a letter.');
    if (payload.key != null && taken.includes(payload.key)) fail(409, 'This workspace already used that key. Choose another.');
    const signal = { id: randomUUID(), key: payload.key ?? previewSignalKey(payload.name, taken), name: payload.name.trim(), rule: payload.rule.trim(), examples: payload.examples ?? '', sources: payload.sources ?? [], owner_id: payload.owner_id ?? uid, revbox_id: payload.revbox_id ?? null, active: payload.active === true, version: 1, archived_at: null, created_at: stamp(), updated_at: stamp() };
    state.signals.push(signal); await persist(); return json(res, { signal: { ...signal, archived: false } }, 201);
  }
  const old = state.signals.find(sg => sg.id === id);
  if (!old) fail(404, 'Signal not found.');
  if (old.owner_id !== uid) fail(403, 'Only the signal owner can change it.');
  if (action === 'archive' && req.method === 'POST') { if (!old.archived_at) Object.assign(old, { active: false, archived_at: stamp(), version: old.version + 1 }); await persist(); return json(res, { signal: { ...old, archived: true } }); }
  if (old.archived_at) fail(409, 'This signal is archived. Create a new signal instead.');
  if (action === 'reprocess' && req.method === 'POST') { if (!old.active) fail(400, 'Activate the reviewed rule before reprocessing.'); old.version += 1; await persist(); return json(res, { signal: { ...old, archived: false } }); }
  if (!action && req.method === 'PUT') {
    if (payload.version !== old.version) fail(409, 'This signal changed. Reload before saving.');
    if (payload.key != null && payload.key !== old.key) fail(400, 'A signal key cannot change after it is created.');
    if (!payload.name?.trim() || !payload.rule?.trim()) fail(400, 'Choose a name, rules and examples within the limits.');
    Object.assign(old, { name: payload.name.trim(), rule: payload.rule.trim(), examples: payload.examples ?? '', sources: payload.sources ?? old.sources, owner_id: payload.owner_id ?? old.owner_id, active: payload.active === true, version: old.version + 1, updated_at: stamp() });
    await persist(); return json(res, { signal: { ...old, archived: false } });
  }
  fail(404, 'Not found.');
}

export const previewRevboxAccounts = COMPANIES.map((c, i) => {
  const deals = DEALS.filter(d => d.company_id === c.id);
  const pattern = GRAPH.nodes.find(n => n.i === c.id)?.pat?.[0];
  return { ...c, people_count: CONTACTS.filter(p => p.company_id === c.id).length, deal_count: deals.length, won_deals: deals.filter(d => d.status === 'won').length, lost_deals: deals.filter(d => d.status === 'lost').length, last_activity_at: CONTACTS.filter(p => p.company_id === c.id).map(p => p.last_activity_at).filter(Boolean).sort().at(-1) ?? null, latest_signal: pattern ? { title: pattern.label, kind: pattern.cat, at: stamp() } : null };
});
const refs = [{ id: 'doc-email-voice', title: 'Email voice', body: 'Write like a helpful colleague. Short paragraphs, concrete next steps, no filler. Do not promise anything that was not agreed.' }, { id: 'doc-cs-playbook', title: 'Customer onboarding playbook', body: 'Before kickoff, confirm the champion, implementation owner, key promises and success measure. Highlight open risks and who owns the first next step.' }];
const connections = ['granola', 'hubspot', 'gmail', 'slack'].map(slug => ({ id: `preview-${slug}`, slug, name: slug, email: slug === 'gmail' ? USERS[0].email : null }));
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => { raw += c; if (raw.length > 400000) reject(Object.assign(new Error('Reference is too large.'), { status: 413 })); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); } }); }); }
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export async function handleRevboxPreview(req, res, url, json) {
  const path = url.pathname;
  if (!path.startsWith('/api/revboxes') && path !== '/api/account-overview' && path !== '/api/signals' && !path.startsWith('/api/signals/')) return false;
  const uid = req.headers['x-preview-user'] === 'u2' ? 'u2' : 'u1';
  try {
    if (url.searchParams.get('workspaceId') !== WS) fail(403, 'Workspace not found.');
    const parts = path.split('/').filter(Boolean).slice(2);
    const payload = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await body(req) : {};
    if (path === '/api/signals' || path.startsWith('/api/signals/')) { await signalsPreview(req, res, json, parts, payload, uid); return true; }
    if (path === '/api/account-overview') { json(res, { accounts: previewRevboxAccounts.filter(a => payload.ids?.includes(a.id)) }); return true; }
    if (parts[0] === 'context-library') { json(res, { groups: state.boxes.filter(b => revboxAccess(b, uid, b.members)).map(b => ({ id: b.id, name: b.name, shared: b.shared, blocks: b.blocks, context: state.context.filter(c => c.revbox_id === b.id) })) }); return true; }
    if (parts[0] === 'signals') {
      if(req.method==='GET')json(res,{signals:state.signals});
      else {const old=state.signals.find(s=>s.id===parts[1]);if(old&&old.owner_id!==uid)fail(403,'Only the signal owner can edit.');if(!payload.name?.trim()||!payload.rule?.trim())fail(400,'Add a name and rules.');const signal={...payload,id:old?.id??randomUUID(),version:(old?.version??0)+1};if(old)Object.assign(old,signal);else state.signals.push(signal);await persist();json(res,{signal});}return true;
    }
    if (parts[0] === 'catalog') { json(res, { accounts: previewRevboxAccounts, members: USERS, documents: refs.map(({ body, ...r }) => r), connections }); return true; }
    if (!parts.length) {
      if (req.method === 'POST') { const box = base('Untitled RevBox', '', false, { mode: 'selected', account_ids: [], min_icp: 70 }); box.owner_id = uid; state.boxes.unshift(box); await persist(); json(res, { box: { ...box, access: 'owner' } }, 201); }
      else json(res, { boxes: state.boxes.filter(b => revboxAccess(b, uid, b.members)).map(b => ({ ...b, access: revboxAccess(b, uid, b.members) })) });
      return true;
    }
    const box = state.boxes.find(b => b.id === parts[0]);
    const access = revboxAccess(box, uid, box?.members ?? []);
    if (!access) fail(404, 'RevBox not found.');
    if (req.method !== 'GET' && access === 'viewer') fail(403, 'Only an owner or editor can change this RevBox.');
    if (parts[1] === 'builder') { await builderPreview(req, res, json, box, parts, payload, uid); return true; }
    const routine = parts[1] === 'jobs' && parts[2] ? state.routines.find(r => r.revbox_id === box.id && r.id === parts[2]) : null;
    if (routine && parts[3] === 'enabled') { routine.enabled = !!payload.enabled; await persist(); json(res, { job: routine }); return true; }
    if (routine && parts[3] === 'run') {
      const run = { id: randomUUID(), revbox_id: box.id, job_id: routine.id, state: 'completed', created_at: stamp(), error: null, credits: 1.8, deliveries: box.delivery.map(d => ({ id: randomUUID(), state: 'sent', error: null, destination: d })), result: { title: routine.name, kind: 'report', body: 'Preview output — no model, HubSpot or Slack was called.\n\nCredit Check pulls yesterday: 1,284 (+6% vs the day before). Biggest movers: Northside Motors (+41), Lakeshore Auto (-18).' } };
      state.results.unshift(run); routine.last_run_at = run.created_at; await persist(); json(res, { run }); return true;
    }
    const jobs = () => state.jobs.filter(j => j.revbox_id === box.id);
    const context = () => state.context.filter(c => c.revbox_id === box.id);
    let output;
    if (parts.length === 1 && req.method === 'GET') {
      const routines = state.routines.filter(r => r.revbox_id === box.id);
      output = { box: { ...box, access }, jobs: [...routines, ...jobs()], context: context(), job_deliveries: builderModule?.revboxJobDeliveries(routines, { mailboxes: PREVIEW_MAILBOXES }) ?? [] };
    }
    else if (parts.length === 1 && req.method === 'PATCH') {
      const error = validateRevboxPatch(payload); if (error) fail(400, error);
      if (payload.revision !== box.revision) fail(409, 'This RevBox changed. Reload before saving.');
      if ('shared' in payload && access !== 'owner') fail(403, 'Only the owner can change sharing.');
      // As the API's checkDeliveryMailboxes: a new or changed Gmail destination is one of your own mailboxes, its address set here.
      if (Array.isArray(payload.delivery)) payload.delivery = payload.delivery.map(d => {
        if (d?.kind !== 'gmail' || !d.target) return d;
        const old = box.delivery.find(x => x.id === d.id && x.kind === 'gmail' && x.target === d.target);
        if (old) return { ...d, mailbox_email: old.mailbox_email ?? null };
        const mine = PREVIEW_MAILBOXES.find(m => m.id === d.target);
        if (!mine) fail(400, 'Choose one of your own connected Gmail mailboxes for this destination.');
        return { ...d, mailbox_email: mine.email };
      });
      Object.assign(box, payload, { revision: box.revision + 1, updated_at: stamp() }); output = { box: { ...box, access } };
    } else if (parts[1] === 'members') {
      if (access !== 'owner') fail(403, 'Only the owner can manage members.');
      if (!USERS.some(u => u.id === parts[2]) || box.owner_id === parts[2]) fail(400, 'Choose a workspace member.');
      box.members = box.members.filter(m => m.user_id !== parts[2]);
      if (payload.role) box.members.push({ user_id: parts[2], role: payload.role }); output = { ok: true };
    } else if (parts[1] === 'accounts') output = { accounts: previewRevboxAccounts.filter(a => revboxMatchesAccount(box.scope, a)), box: { id: box.id, name: box.name, scope: box.scope } };
    else if (parts[1] === 'graph') {
      const accounts = previewRevboxAccounts.filter(a => revboxMatchesAccount(box.scope, a)); const ids = new Set(accounts.map(a => a.id));
      const people = CONTACTS.filter(p => ids.has(p.company_id)); const deals = DEALS.filter(d => ids.has(d.company_id));
      output = { nodes: [...accounts.map(a => ({ id: a.id, label: a.name, type: 'account', icp: a.icp_score })), ...people.map(p => ({ id: p.id, label: `${p.first_name} ${p.last_name}`, type: 'person' })), ...deals.map(d => ({ id: d.id, label: d.name, type: 'deal' }))], edges: [...people.map(p => ({ s: p.id, t: p.company_id, type: 'works_at' })), ...deals.map(d => ({ s: d.id, t: d.company_id, type: 'deal_of' }))] };
    } else if (parts[1] === 'context') {
      if (req.method === 'DELETE') { state.context = state.context.filter(c => c.revbox_id !== box.id || c.id !== parts[2]); output = { ok: true }; }
      else { const ref = payload.document_id ? refs.find(r => r.id === payload.document_id) : null; if (payload.document_id && !ref) fail(404, 'Document not found.'); const entry = { id: randomUUID(), revbox_id: box.id, title: ref?.title ?? payload.title, body: ref?.body ?? payload.body, document_id: payload.document_id ?? null }; state.context.push(entry); output = { context: entry }; }
    } else if (parts[1] === 'plan') {
      const plan = proposeRevboxPlan(payload.prompt, { timezone: payload.timezone, tools: payload.tools });
      for (const slug of plan.tools) { const connection = connections.find(c => c.slug === slug); if (connection) plan.bindings[slug] = connection.id; }
      output = { plan };
    }
    else if (parts[1] === 'results') {if(parts[3]==='approve'){const run=state.results.find(r=>r.revbox_id===box.id&&r.id===parts[2]);if(!run)fail(404,'Result not found.');if(run.state!=='needs_review')fail(409,'This result was already reviewed.');run.state='completed';output={run};}else output={results:state.results.filter(r=>r.revbox_id===box.id)};}
    else if (parts[1] === 'jobs' && parts[3] === 'enabled') {
      const job=jobs().find(j=>j.id===parts[2]);if(!job)fail(404,'Job not found.');
      if(payload.enabled){const error=revboxExecutionRequirements(job,box);if(error)fail(400,error);if(job.plan.questions.length)fail(400,'Resolve the open questions before enabling this job.');}
      if(payload.enabled&&job.state!=='reviewed')fail(400,'Approve the job first.');
      job.enabled=payload.enabled;output={job};
    }
    else if (parts[1] === 'jobs' && parts[3] === 'run') {
      const job=jobs().find(j=>j.id===parts[2]);if(!job)fail(404,'Job not found.');
      const error=revboxExecutionRequirements(job,box);if(error)fail(400,error);if(job.plan.questions.length)fail(400,'Resolve the open questions before running this job.');
      if(job.state!=='reviewed')fail(400,'Approve the job first.');
      const accounts=previewRevboxAccounts.filter(a=>revboxMatchesAccount(box.scope,a));
      if(!accounts.length)fail(400,'Add accounts to this RevBox before running this job.');
      const run={id:randomUUID(),revbox_id:box.id,job_id:job.id,state:job.plan.tools.includes('gmail')||job.plan.steps.some(s=>s.type==='approval')?'needs_review':'completed',created_at:stamp(),error:null,deliveries:[],result:{title:job.name,kind:job.plan.tools.includes('gmail')?'draft':'report',body:`Preview output — no model or external delivery was called.\n\nAccounts in scope: ${accounts.map(a=>a.name).join(', ')}.\n\nInstructions: ${job.prompt}`}};
      state.results.unshift(run);output={run};
    }
    else if (parts[1] === 'jobs') {
      const error = validateRevboxPlan(payload.plan); if (error) fail(400, error);
      if (!payload.name?.trim() || !payload.prompt?.trim()) fail(400, 'A job needs a name and instructions.');
      const old = parts[2] ? jobs().find(j => j.id === parts[2]) : null;
      if (parts[2] && !old) fail(404, 'Job not found.');
      if (old && payload.version !== old.version) fail(409, 'This job changed. Reload before saving.');
      const updated = { enabled:false,id: old?.id ?? randomUUID(), revbox_id: box.id, name: payload.name, prompt: payload.prompt, plan: { ...payload.plan, execution_enabled: false }, state: payload.state, version: (old?.version ?? 0) + 1, reviewed_at: payload.state === 'reviewed' ? stamp() : null, snapshots: [...(old?.snapshots ?? []), ...(payload.state === 'reviewed' ? [{ version: (old?.version ?? 0) + 1, plan: structuredClone(payload.plan), scope: structuredClone(box.scope), blocks: structuredClone(box.blocks), delivery: structuredClone(box.delivery), context: structuredClone(context()), reviewed_at: stamp() }] : [])] };
      if (old) Object.assign(old, updated); else state.jobs.push(updated); output = { job: updated };
    } else fail(404, 'Not found.');
    if (req.method !== 'GET' && parts[1] !== 'plan') { box.updated_at = stamp(); await persist(); }
    json(res, output);
  } catch (e) { json(res, { error: e.message }, e.status ?? 500); }
  return true;
}

// ─── Job Builder preview (GET-868) ───────────────────────────────────────────────────────────
// A scripted builder, so the chat, the ask card and the proposal can be seen without the API or a
// model. Same routes and events as the real builder: POST /:id/builder starts a session,
// /:id/builder/:sid continues, /:id/builder/:sid/approve creates the routine and switches it on.
// The first message picks a script (scriptFor), as the real agent would read the request:
// - report: a daily/weekly report from HubSpot, the Credit Check reference case
//   (docs/revboxes/JOB_BUILDER.md). Asks the channel and the content, and the time only when the
//   words did not give one; proposes with a HubSpot access warning.
// - meeting: "after every meeting…". Starts on Meeting done (an event, so never a time question),
//   at most one question (the Slack channel, unless named), then follow-up draft -> Gmail and
//   summary -> Slack.
// - won: "when a deal is won…". deal.won, a handoff layout to the box's Slack channel, no question.
// - other: one clarifying question (where the result goes), then a sensible proposal.
// Every script emits `integrations` (the tools it settled on) so the composer attaches them. Any
// later message revises the proposal. Each session keeps `log`, the chat as the server's history
// items, so Edit (POST /:id/builder { job_id }, no message) can reopen it: a new session seeded from
// the job's last approved one, answered as JSON { session_id, job_id, history, proposal }. Sessions
// persist with the state file, so Edit still works after the fake API restarts.
state.builder_sessions ??= {};
const sessions = { get: id => state.builder_sessions[id], set: (id, v) => { state.builder_sessions[id] = v; } };
const pause = ms => new Promise(r => setTimeout(r, ms));
const unrec = v => String(v ?? '').replace(/\s*\(recommended\)\s*$/i, '');
const REPORT_QUESTIONS = [
  { id: 'channel', header: 'Channel', question: 'Which Slack channel should get the report?', multi: false, options: [
    { label: '#credit-check-cs-handoff (Recommended)', description: 'Matches the name you gave · 14 members' },
    { label: '#cs-handoffs', description: 'Already a destination of this box' },
    { label: 'DM me instead', description: 'Sent to you only' } ] },
  { id: 'content', header: 'Report', question: 'What should the report include?', multi: true, options: [
    { label: 'Change vs the day before (Recommended)', description: 'Per dealer, all five Credit Check counts' },
    { label: 'Top 5 movers', description: 'The dealers whose pulls moved most' },
    { label: 'Dealers with no data', description: 'Flags dealers that went quiet' } ] },
  { id: 'time', header: 'Time', question: 'When should it arrive?', multi: false, options: [
    { label: '08:00 Toronto (Recommended)', description: 'Every day, before the CS stand-up' },
    { label: '07:00 Toronto', description: 'Every day' },
    { label: '08:00 Toronto, weekdays only', description: 'Skips Saturday and Sunday' } ] },
];
// The workspace's Slack as the fake knows it: facts name channels from here, never from the proposal.
const PREVIEW_CHANNELS = { C07TU1HANDOFF: 'credit-check-cs-handoff', C07CSHANDOFFS: 'cs-handoffs' };
const channelId = name => Object.entries(PREVIEW_CHANNELS).find(([, n]) => n === String(name ?? '').replace(/^#/, ''))?.[0] ?? null;
/** A channel the words name ("#cs-handoffs", "the cs handoffs channel"), or null. */
function namedChannel(words) {
  const flat = String(words ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, '-');
  return Object.values(PREVIEW_CHANNELS).sort((a, b) => b.length - a.length).find(n => flat.includes(n)) ?? null;
}
const channelQuestion = question => ({ id: 'channel', header: 'Channel', question, multi: false, options: [
  { label: '#cs-handoffs (Recommended)', description: 'Where the CS team works · 9 members' },
  { label: '#credit-check-cs-handoff', description: '14 members' } ] });
const OTHER_QUESTIONS = [
  { id: 'output', header: 'Result', question: 'Where should the result go?', multi: false, options: [
    { label: 'Post it to Slack (Recommended)', description: 'To #cs-handoffs' },
    { label: 'Draft an email in Gmail', description: 'From your mailbox, sent only after you approve' },
    { label: 'Just keep it in this box', description: 'Shows under Results' } ] },
];
/** "8am", "7:30", "18:00", "at 9" -> "HH:MM", or null when the words give no time. */
function timeIn(words) {
  const m = String(words ?? '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? String(words ?? '').match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = Number(m[1]); const min = m[2] ?? '00';
  if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
  if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  return h > 23 || Number(min) > 59 ? null : `${String(h).padStart(2, '0')}:${min}`;
}
/** Which script a request gets: the composer's signal first, then the words. */
function scriptFor(words, hinted) {
  if (hinted?.startsWith('meeting.done')) return 'meeting';
  if (hinted === 'deal.won') return 'won';
  if (/\bmeetings?\b|\bcalls?\b/i.test(words)) return 'meeting';
  if (/closed[- ]?won|\bdeals? (is |are |gets? )?(won|closes)\b|\bwin a deal\b|\bwe win\b/i.test(words)) return 'won';
  if (hinted === 'schedule' || /\b(daily|weekly|monthly|every (morning|day|week|monday|tuesday|wednesday|thursday|friday|weekday)|report|digest)\b|hubspot/i.test(words)) return 'report';
  return 'other';
}
/** The server's facts (core proposalFacts), restated for the steps this fake proposes. */
function factsFor(steps) {
  return steps.map(st => {
    const c = st.config ?? {};
    const base = { step_id: st.id, type: st.type, external: false };
    if (st.type === 'hubspot') return { ...base, action: c.action, access: c.action === 'read' ? 'read' : 'write', object: c.object, fields: c.fields ?? [], target: `HubSpot: Read Company Daily Stats (${c.object}): ${(c.fields ?? []).join(', ')}` };
    if (st.type === 'agent') return { ...base, model: c.model ?? 'opennous', mode: c.mode, target: `AI (${c.model ?? 'opennous'})` };
    if (st.type === 'slack') {
      const real = PREVIEW_CHANNELS[c.channel_id];
      return { ...base, action: 'channel', channel_id: c.channel_id, channel: real ?? null, target: real ? `#${real} (${c.channel_id})` : `Slack channel ${c.channel_id}` };
    }
    if (st.type === 'gmail' || st.type === 'email') {
      const mailbox = c.send_from?.email ?? 'cs@tu.example';
      // A template To ({{person.email}}) is the meeting's attendees at run time.
      const to = /\{\{/.test(String(c.to ?? '')) ? ['the meeting’s attendees'] : String(c.to ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
      return { ...base, external: true, recipients: to, sends_to: to, mailbox, mode: c.mode, target: `Draft to ${to.join(', ')} from ${mailbox}` };
    }
    if (st.type === 'webhook') { const host = new URL(c.url).host; return { ...base, external: true, url: c.url, host, sends_to: [host], target: `POST ${c.url}` }; }
    return { ...base, target: `${st.type} step` };
  });
}
const MAILBOX = PREVIEW_MAILBOXES[0];
const PROVIDER_NAME = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom' };
function meetingTrigger(key) {
  const provider = key?.split(':')[1];
  return { signal_key: key ?? 'meeting.done', kind: 'call_ended', config: provider ? { provider, tools: [provider] } : {}, label: `After every meeting${provider ? ` (${PROVIDER_NAME[provider] ?? provider})` : ''}` };
}
function meetingProposal(s) {
  const channel = s.channel ?? 'cs-handoffs';
  const format = s.format ?? 'notification';
  const steps = [
    { id: 'followup', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write a short follow-up email to the people on the call: thank them, restate what was agreed and who owns each next step, with dates. Use the box’s email voice. Subject line first.' } },
    { id: 'draft', type: 'gmail', config: { mode: 'draft', to: '{{person.email}}', body: '{{steps.followup.output}}', send_from: { id: MAILBOX.id, kind: 'gmail', email: MAILBOX.email } } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Summarize the meeting for the team: who was on it, what was decided, open risks, and the next steps with owners.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: channelId(channel) ?? 'C07CSHANDOFFS', channel, format, text: '{{steps.summary.output}}' } },
  ];
  return {
    name: s.name ?? 'Meeting follow-up and summary',
    summary: `After every meeting recorded in ${PROVIDER_NAME[s.signal?.split(':')[1]] ?? 'your recorder'}: draft the follow-up to the attendees in your Gmail (from ${MAILBOX.email}), and post a summary to #${channel}.`,
    trigger: meetingTrigger(s.signal),
    steps,
    facts: factsFor(steps),
    display: [
      { step_id: 'followup', tool: 'agent', title: 'Write the follow-up', detail: 'Agreed points, owners and dates · your email voice' },
      { step_id: 'draft', tool: 'gmail', title: 'Draft it in Gmail', detail: `To the meeting’s attendees · from ${MAILBOX.email} · you send it` },
      { step_id: 'summary', tool: 'agent', title: 'Summarize the meeting', detail: 'Decisions, risks, next steps with owners' },
      { step_id: 'post', tool: 'slack', title: `Post to #${channel}`, detail: format === 'report' ? 'Report layout' : 'Notification layout' },
    ],
    uses_box_delivery: false,
    warnings: [],
    assumptions: ['Internal-only meetings (no one from outside the company) are skipped.', ...(s.changes ?? [])],
    estimated_credits_per_run: 2,
  };
}
function wonProposal(s) {
  const channel = s.channel ?? 'cs-handoffs';
  const steps = [
    { id: 'brief', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the customer success handoff for the deal that was just won: why they bought, the people, what was promised (cite the source), risks, and the first next step with its owner.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: channelId(channel) ?? 'C07CSHANDOFFS', channel, format: 'handoff', text: '{{steps.brief.output}}' } },
  ];
  return {
    name: s.name ?? 'Closed-won handoff to CS',
    summary: `When a deal is won: write the customer success handoff and post it to #${channel}.`,
    trigger: { signal_key: 'deal.won', kind: 'deal_closed_won', config: {}, label: 'When a deal is won' },
    steps,
    facts: factsFor(steps),
    display: [
      { step_id: 'brief', tool: 'agent', title: 'Write the CS handoff', detail: 'Why they bought, people, promises, risks, first step' },
      { step_id: 'post', tool: 'slack', title: `Post to #${channel}`, detail: 'Handoff layout' },
    ],
    uses_box_delivery: false,
    warnings: [],
    assumptions: ['Uses the deal’s HubSpot record and its calls as the source.', ...(s.changes ?? [])],
    estimated_credits_per_run: 1,
  };
}
function otherProposal(s) {
  const output = unrec(s.answers?.output ?? 'Post it to Slack');
  const toSlack = /slack/i.test(output), toGmail = /gmail|email/i.test(output);
  const task = String(s.request ?? 'the job you described').slice(0, 160);
  const steps = [
    { id: 'work', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: `Do this for the box's accounts: ${task}` } },
    ...(toSlack ? [{ id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C07CSHANDOFFS', channel: 'cs-handoffs', format: 'report', text: '{{steps.work.output}}' } }] : []),
    ...(toGmail ? [{ id: 'draft', type: 'gmail', config: { mode: 'draft', to: USERS[0].email, body: '{{steps.work.output}}', send_from: { id: MAILBOX.id, kind: 'gmail', email: MAILBOX.email } } }] : []),
  ];
  const trigger = s.signal && s.signal !== 'schedule' && s.signal !== 'deal.won' && !s.signal.startsWith('meeting.done')
    ? { signal_key: s.signal, ...(previewCatalog().builtin.concat(previewCatalog().custom).find(e => e.key === s.signal)?.trigger ?? { kind: 'account_signal', config: {} }), label: `When ${s.signal}` }
    : { signal_key: 'schedule', kind: 'clock', config: { frequency: 'weekly', at: '08:00', day_of_week: 1 }, timezone: 'America/Toronto', label: 'Every Monday at 08:00 (Toronto)' };
  return {
    name: s.name ?? 'Weekly account job',
    summary: `${trigger.label}: ${task}${toSlack ? ', then post it to #cs-handoffs' : toGmail ? ', then draft it to you in Gmail' : ', kept in this box'}.`,
    trigger, steps, facts: factsFor(steps),
    display: [
      { step_id: 'work', tool: 'agent', title: 'Do the work', detail: task },
      ...(toSlack ? [{ step_id: 'post', tool: 'slack', title: 'Post to #cs-handoffs', detail: 'Report layout' }] : []),
      ...(toGmail ? [{ step_id: 'draft', tool: 'gmail', title: 'Draft it to you', detail: `From ${MAILBOX.email}` }] : []),
    ],
    uses_box_delivery: !toSlack && !toGmail,
    warnings: [],
    assumptions: [...(trigger.kind === 'clock' ? ['Runs weekly on Monday morning; say another time to change it.'] : []), ...(s.changes ?? [])],
    estimated_credits_per_run: 1,
  };
}
function reportProposal(s) {
  const at = s.answers?.time?.match(/\d{2}:\d{2}/)?.[0] ?? '08:00';
  const weekdays = s.answers?.time?.includes('weekdays');
  const channel = unrec(s.answers?.channel ?? '#credit-check-cs-handoff');
  const label = `${weekdays ? 'Weekdays' : 'Every day'} at ${at} (Toronto)`;
  const id = channel === '#cs-handoffs' ? 'C07CSHANDOFFS' : 'C07TU1HANDOFF';
  const steps = [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: '2-100000001', fields: ['credit_check_pulls', 'credit_check_approved', 'credit_check_declined', 'credit_check_pending', 'credit_check_errors'], group_by: 'company_name', date_property: 'date', window: 'yesterday', compare: true } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the VP summary of yesterday\'s Credit Check activity…' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: id, channel, format: 'report', text: '{{steps.summary.output}}' } },
    // "Also email the VP" adds a Gmail draft, so the card's "Sends data to" line can be seen.
    ...(s.emailVp ? [{ id: 'mail', type: 'gmail', config: { mode: 'draft', to: 'vp@tu.example', body: '{{steps.summary.output}}', send_from: { id: 'mbx-cs', kind: 'gmail' } } }] : []),
  ];
  return {
    name: s.name ?? 'Credit Check daily summary',
    summary: `${weekdays ? 'Every weekday' : 'Every morning'} at ${at} Toronto time: read yesterday's Credit Check numbers per dealer from HubSpot, write the VP summary, post it to ${channel}.`,
    trigger: { signal_key: 'schedule', kind: 'clock', config: { frequency: 'daily', at, ...(weekdays ? { weekdays_only: true } : {}) }, timezone: 'America/Toronto', label },
    steps,
    facts: factsFor(steps),
    display: [
      { step_id: 'read', tool: 'hubspot', title: 'Read Company Daily Stats', detail: '5 Credit Check fields · per dealer · yesterday vs the day before' },
      { step_id: 'summary', tool: 'agent', title: 'Write the VP summary', detail: unrec(s.answers?.content ?? 'Change vs the day before').replace(/\s*\(recommended\)/ig, '') },
      { step_id: 'post', tool: 'slack', title: `Post to ${channel}`, detail: 'Report layout · as the OpenNous app' },
      ...(s.emailVp ? [{ step_id: 'mail', tool: 'gmail', title: 'Draft the summary to the VP' }] : []),
    ],
    uses_box_delivery: true,
    warnings: [{ kind: 'missing_access', message: 'The HubSpot connection was not granted the custom-object read scope, so the first step may return nothing.', fix: { label: 'Reconnect HubSpot', href: '/company-sources?connect=hubspot' } }],
    assumptions: ['Weekends are reported as quiet days.', ...(s.changes ?? [])],
    estimated_credits_per_run: 2,
  };
}
function proposalFor(s) {
  if (s.script === 'meeting') return meetingProposal(s);
  if (s.script === 'won') return wonProposal(s);
  if (s.script === 'other') return otherProposal(s);
  return reportProposal(s);
}
function integrationsFor(s) {
  if (s.script === 'meeting') return [s.signal?.split(':')[1] ?? 'granola', 'gmail', 'slack'];
  if (s.script === 'won') return ['hubspot', 'slack'];
  if (s.script === 'other') { const o = String(s.answers?.output ?? ''); return /slack/i.test(o) ? ['slack'] : /gmail|email/i.test(o) ? ['gmail'] : []; }
  return ['hubspot', 'slack', ...(s.emailVp ? ['gmail'] : [])];
}
async function builderPreview(req, res, json, box, parts, payload, uid) {
  const sid = parts[2];
  if (sid && parts[3] === 'approve') {
    const s = sessions.get(sid);
    if (!s || s.box !== box.id || !s.proposal) { json(res, { error: 'Nothing to approve in this session.' }, 404); return; }
    if (s.state === 'approved') { json(res, { error: 'This proposal was already approved.' }, 409); return; }
    const p = { ...s.proposal, name: payload.name?.trim() || s.proposal.name };
    const old = s.job_id ? state.routines.find(r => r.id === s.job_id) : null;
    // Approving switches it on, as the real approve does when the checks pass. A proposal named with
    // "(off)" shows the other path: saved, off, with the reason.
    const reason = /\(off\)/i.test(p.name) ? 'Your plan includes 3 automations. Pause or delete one, then switch this job on.' : null;
    const routine = { id: old?.id ?? randomUUID(), revbox_id: box.id, source: 'routine', name: p.name, enabled: !reason, trigger_kind: p.trigger.kind, trigger_config: p.trigger.config, timezone: p.trigger.timezone, trigger_label: p.trigger.label, steps: p.steps, last_run_at: old?.last_run_at ?? null, version: (old?.version ?? 0) + 1, created_by: uid };
    const next = !reason && p.trigger.kind === 'clock' ? scheduleModule?.nextRunAt({ trigger_kind: 'clock', timezone: p.trigger.timezone, frequency: p.trigger.config?.frequency ?? 'daily', at_time: p.trigger.config?.at ?? '08:00', weekdays_only: p.trigger.config?.weekdays_only === true }) : null;
    routine.next_run_at = next ? next.toISOString() : null;
    if (old) Object.assign(old, routine); else state.routines.unshift(routine);
    s.state = 'approved'; s.job_id = routine.id; s.proposal = p; s.approved_at = stamp();
    const last = [...(s.log ?? [])].reverse().find(i => i.kind === 'proposal');
    if (last) { last.proposal = p; last.approved = true; }
    await persist(); json(res, { routine, enabled: !reason, ...(reason ? { reason } : {}) }); return;
  }
  // Edit: a new session on the job, seeded from its last approved chat.
  if (!sid && payload.job_id && payload.message === undefined && payload.answers === undefined) {
    const job = state.routines.find(r => r.revbox_id === box.id && r.id === payload.job_id);
    if (!job) { json(res, { error: 'Job not found.' }, 404); return; }
    const source = Object.values(state.builder_sessions).filter(x => x.box === box.id && x.job_id === job.id && x.state === 'approved')
      .sort((a, b) => String(b.approved_at ?? '').localeCompare(String(a.approved_at ?? '')))[0];
    const fresh = { id: randomUUID(), box: box.id, job_id: job.id, user: uid, state: 'open', stage: source ? 2 : 0, script: source?.script, request: source?.request, channel: source?.channel, format: source?.format, questions: source?.questions, answers: source?.answers, emailVp: source?.emailVp, signal: source?.signal, changes: source?.changes, name: source?.proposal?.name, proposal: source?.proposal ?? null, log: structuredClone(source?.log ?? []) };
    sessions.set(fresh.id, fresh); await persist();
    json(res, { session_id: fresh.id, job_id: job.id, history: fresh.log, proposal: fresh.proposal }, 201); return;
  }
  const s = sid ? sessions.get(sid) : { id: randomUUID(), box: box.id, job_id: payload.job_id ?? null, user: uid, state: 'open', stage: 0, log: [] };
  if (!s || s.box !== box.id) { json(res, { error: 'Builder session not found.' }, 404); return; }
  if (s.state === 'approved') { json(res, { error: 'This builder session is closed. Start a new one.', code: 'session_closed' }, 409); return; }
  s.log ??= [];
  // Sessions from before the scripts were all the report script.
  s.script ??= s.stage > 0 ? 'report' : undefined;
  // The chat as Edit shows it later: the user's words (answers fill the open ask), prose, asks, proposals.
  if (payload.answers) {
    const ask = [...s.log].reverse().find(i => i.kind === 'ask');
    const asked = s.questions ?? REPORT_QUESTIONS;
    if (ask) ask.answers = payload.answers.map(a => ({ question: asked.find(q => q.id === a.id)?.question ?? a.id, answer: [...(a.selected ?? []), ...(a.other ? [`Other: ${a.other}`] : [])].join('; ') }));
  } else if (payload.message) s.log.push({ role: 'user', text: payload.message });
  if (!sid) sessions.set(s.id, s);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let closed = false; req.on('close', () => { closed = true; });
  const send = async (ev, ms = 0) => { if (ms) await pause(ms); if (!closed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const tool = async (status, name, summary) => { await send({ type: 'status', text: status }, 250); await send({ type: 'tool', name, state: 'start' }, 80); await send({ type: 'tool', name, state: 'done', summary }, 650); };
  const prose = async text => { s.log.push({ role: 'assistant', text }); for (const word of text.split(/(?<= )/)) await send({ type: 'text', text: word }, 28); };
  const ask = async questions => { s.questions = questions; s.log.push({ kind: 'ask', questions, answers: [] }); await send({ type: 'ask', questions }, 200); s.stage = 1; };
  const propose = async () => { s.proposal = proposalFor(s); s.log.push({ kind: 'proposal', proposal: s.proposal, approved: false }); await send({ type: 'proposal', proposal: s.proposal }, 300); s.stage = 2; };
  const settleIntegrations = async () => { const slugs = integrationsFor(s); if (slugs.length) await send({ type: 'integrations', slugs }, 120); };
  if (!sid) await send({ type: 'session', session_id: s.id });
  // What starts the job: the composer's pick wins; otherwise "meeting" in the words means a meeting
  // signal (Granola when named), anything else a schedule. Emitted as the real builder does.
  const hinted = payload.hints && 'signal' in payload.hints ? payload.hints.signal : null;
  const words = payload.message ?? '';
  const meant = /\bmeetings?\b|\bcalls?\b/i.test(words) ? (/fireflies/i.test(words) ? 'meeting.done:fireflies' : /fathom/i.test(words) ? 'meeting.done:fathom' : 'meeting.done:granola') : null;
  const announceTrigger = async (key) => {
    s.signal = key;
    const entry = key ? previewCatalog().builtin.concat(previewCatalog().custom).find(e => e.key === key.split(':')[0]) : null;
    const provider = key?.split(':')[1];
    const label = !key || key === 'schedule' ? 'On a schedule' : `${entry?.label ?? key}${provider ? ` · ${PROVIDER_NAME[provider] ?? provider}` : ''}`;
    await send({ type: 'trigger', signal: key === 'schedule' ? 'schedule' : key, label }, 150);
  };
  const attached = payload.hints?.integrations?.length ? ` · you attached ${payload.hints.integrations.join(', ')}` : '';
  if (s.stage === 0) {
    s.script = scriptFor(words, hinted);
    s.request = words;
    await tool('Reading this box’s context…', 'revbox_context', `Read ${box.name} · ${box.blocks.length} context blocks`);
    if (s.script === 'meeting') {
      const key = hinted?.startsWith('meeting.done') ? hinted : meant ?? 'meeting.done:granola';
      const recorder = PROVIDER_NAME[key.split(':')[1]] ?? 'your recorder';
      await tool('Checking connected tools…', 'workspace_connections', `${recorder}, Gmail and Slack are connected${attached}`);
      await announceTrigger(key);
      await tool('Checking mailboxes…', 'mailboxes', `Gmail connected · drafts from ${MAILBOX.email}`);
      await tool('Finding the Slack channel…', 'slack_channels', `Slack connected · ${Object.keys(PREVIEW_CHANNELS).length} channels`);
      s.format = /\breport\b/i.test(words) ? 'report' : 'notification';
      s.channel = namedChannel(words);
      await settleIntegrations();
      if (s.channel) {
        await prose(`After every meeting ${recorder} records, I’ll draft the follow-up to the attendees in your Gmail and post a summary to #${s.channel}:`);
        await propose();
      } else {
        await prose(`After every meeting ${recorder} records, I’ll draft the follow-up to the attendees in your Gmail (from ${MAILBOX.email}) and post a summary to Slack. One thing I can’t tell:`);
        await ask([channelQuestion('Which Slack channel should get the meeting summary?')]);
      }
    } else if (s.script === 'won') {
      await tool('Checking connected tools…', 'workspace_connections', `HubSpot and Slack are connected${attached}`);
      await announceTrigger('deal.won');
      await tool('Checking HubSpot access…', 'hubspot_access', 'Deals and their associations are readable');
      s.channel = namedChannel(words) ?? PREVIEW_CHANNELS[box.delivery.find(d => d.kind === 'slack')?.target] ?? 'cs-handoffs';
      await tool('Finding the Slack channel…', 'slack_channels', `#${s.channel} · ${channelId(s.channel)}`);
      await settleIntegrations();
      await prose(`Every time a deal is won, I’ll write the CS handoff and post it to #${s.channel} in the handoff layout:`);
      await propose();
    } else if (s.script === 'report') {
      await tool('Checking connected tools…', 'workspace_connections', `HubSpot, Slack, Gmail and Granola are connected${attached}`);
      await announceTrigger(hinted && !hinted.startsWith('meeting.done') && hinted !== 'deal.won' ? hinted : 'schedule');
      await tool('Looking for Credit Check in HubSpot…', 'hubspot_find', 'Found Company Daily Stats · 5 Credit Check fields');
      await tool('Previewing yesterday’s numbers…', 'hubspot_preview', 'Yesterday: 42 dealers with Credit Check activity');
      await settleIntegrations();
      // The time is asked only when the words did not give one.
      const at = timeIn(words);
      if (at) s.answers = { ...(s.answers ?? {}), time: `${at} Toronto${/weekday/i.test(words) ? ', weekdays only' : ''}` };
      const questions = REPORT_QUESTIONS.filter(q => q.id !== 'time' || !at);
      await prose(`The numbers live in the HubSpot custom object Company Daily Stats, and yesterday has real data for 42 dealers. ${questions.length === 3 ? 'Three' : 'Two'} things I can’t work out on my own:`);
      await ask(questions);
    } else {
      await tool('Checking connected tools…', 'workspace_connections', `HubSpot, Slack, Gmail and Granola are connected${attached}`);
      if (hinted) await announceTrigger(hinted);
      await prose('I can set that up. One thing first:');
      await ask(OTHER_QUESTIONS);
    }
  } else if (s.stage === 1 && payload.answers) {
    const picked = Object.fromEntries(payload.answers.map(a => [a.id, [...(a.selected ?? []), ...(a.other ? [a.other] : [])].join(', ')]));
    s.answers = { ...(s.answers ?? {}), ...picked };
    if (s.script === 'meeting') {
      // A channel the fake does not know falls back to the box's own, as the real one would ask again.
      s.channel = namedChannel(picked.channel) ?? 'cs-handoffs';
      await tool('Resolving the Slack channel…', 'slack_channels', `#${s.channel} · ${channelId(s.channel) ?? 'C07CSHANDOFFS'}`);
      await prose('Here’s the job:');
      await propose();
    } else if (s.script === 'other') {
      if (!s.signal) await announceTrigger('schedule');
      await settleIntegrations();
      await prose('Here’s the job. It runs weekly unless you tell me otherwise:');
      await propose();
    } else {
      await tool('Resolving the Slack channel…', 'slack_channels', `${unrec(s.answers.channel || '#credit-check-cs-handoff')} · C07TU1HANDOFF`);
      await tool('Checking what the HubSpot connection can read…', 'hubspot_access', 'Companies and deals readable · custom objects not granted');
      await prose('Here’s the job. One thing to fix before it can run reliably:');
      await propose();
    }
  } else {
    const text = payload.message ?? '';
    await send({ type: 'status', text: 'Updating the job…' }, 300);
    const at = timeIn(text);
    if (at && s.script !== 'meeting' && s.script !== 'won') s.answers = { ...(s.answers ?? {}), time: `${at} Toronto` };
    if (/\bemail\b/i.test(text) && s.script === 'report') { s.emailVp = true; await settleIntegrations(); }
    const channel = namedChannel(text);
    if (channel && (s.script === 'meeting' || s.script === 'won')) s.channel = channel;
    if (s.script === 'meeting' && /\breport\b/i.test(text)) s.format = 'report';
    const next = hinted ?? meant;
    if (next?.startsWith('meeting.done') && s.script === 'meeting' && next !== s.signal) await announceTrigger(next);
    else if (at && s.script === 'report' && s.signal && s.signal !== 'schedule') await announceTrigger('schedule');
    s.changes = [...(s.changes ?? []), `You asked: “${text.slice(0, 120)}”`];
    await prose('Updated. Here’s the revised job:');
    await propose();
  }
  await persist();
  await send({ type: 'credits', credits: s.stage === 1 ? 2 : 1 });
  await send({ type: 'done' });
  res.end();
}
