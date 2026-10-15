// Local-only fixture persistence. Never imported by production authentication or API.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { COMPANIES, CONTACTS, DEALS, USERS, WS } from './world.mjs';
import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount, revboxExecutionRequirements } from '../../../packages/core/src/services/revboxPlan.mjs';
import { validateRevboxPatch, revboxAccess, REVBOX_BUILTIN_JOBS, builtinJobsOf, applyBuiltinOps, planDefaultBuiltinBoxes } from '../../../packages/core/src/db/revboxes.mjs';
import { normalizeDatasetColumns, datasetSlug, datasetRowsCsv, datasetValueText } from '../../../packages/core/src/services/datasetFormats.mjs';
// The job card's brief (GET-884): the server's sentence, built from the proposal's steps and facts.
import { jobBrief, builtinJobBrief } from '../../../packages/core/src/db/revboxJobBrief.mjs';
import { latestSignalView } from '../../../packages/core/src/services/signalTone.mjs';
// The built-ins' editable email voice (GET-902): the seed and how the file is recognised, as core has them.
import { emailVoiceSeed, isEmailVoiceFile, emailDraftingBuiltins, EMAIL_VOICE_TITLE } from '../../../packages/core/src/db/emailVoice.mjs';

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
// GET-872: a Credit Check-like reporting box with a daily report over many dealers, a second job with
// a failed run, a run waiting for review, one still running; built-in jobs; members with photos.
if (!state.seeded.page_polish) {
  const tu = base('Credit Check Reporting', 'Daily Credit Check reporting for the dealer network.', true, { mode: 'selected', account_ids: [], min_icp: 70 });
  tu.delivery = [{ id: randomUUID(), kind: 'slack', target: 'C07TU1HANDOFF', channel: 'credit-check-cs-handoff' }];
  tu.members = [{ user_id: 'u2', role: 'editor' }, { user_id: 'u3', role: 'viewer' }];
  tu.builtin_jobs = ['stale_deal'];
  state.boxes.unshift(tu);
  const daily = { id: randomUUID(), revbox_id: tu.id, source: 'routine', name: 'Credit Check daily summary', enabled: true, trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto', trigger_label: 'Every day at 08:00 (Toronto)', last_run_at: stamp(), version: 3, created_by: 'u1', steps: [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: '2-100000001', object_label: 'Company Daily Stats', group_by: 'company_name', window: 'yesterday' } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the daily Credit Check report.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C07TU1HANDOFF', channel: 'credit-check-cs-handoff', text: '{{steps.summary.output}}', format: 'report' } },
    { id: 'box_delivery', type: 'revbox_delivery', config: { format: 'report' } },
  ] };
  const risk = { id: randomUUID(), revbox_id: tu.id, source: 'routine', name: 'Dealer risk alert', enabled: true, trigger_kind: 'account_signal', trigger_config: {}, timezone: 'UTC', trigger_label: 'When an account signal fires', last_run_at: stamp(), version: 1, created_by: 'u1', steps: [
    { id: 'brief', type: 'agent', config: { mode: 'write', prompt: 'Say what changed and why it matters.' } },
    { id: 'approve', type: 'approval', config: {} },
    { id: 'alert', type: 'slack', config: { action: 'channel', channel_id: 'C07LEADERSHIP', channel: 'cs-leadership', text: '{{steps.brief.output}}', format: 'alert' } },
    { id: 'mail', type: 'gmail', config: { mode: 'draft', to: 'dealer-success@credit_check.example', cc: '', body: '{{steps.brief.output}}', send_from: { id: 'mb-1', kind: 'gmail' } } },
    { id: 'hook', type: 'webhook', config: { url: 'https://hooks.credit_check.example/risk?key=preview' } },
  ] };
  state.routines.unshift(daily, risk);
  const H = 3_600_000, at = (h) => new Date(Date.now() - h * H).toISOString();
  const dealers = COMPANIES.map(c => c.id);
  const report = (n) => `## Credit Check daily · ${new Date(Date.now() - n * 24 * H).toDateString()}\n\n**1,284 pulls** yesterday across 41 dealers, up 6% on the day before.\n\n| Dealer | Pulls | Change |\n|---|---:|---:|\n| Meridian Analytics | 142 | +41 |\n| Northwind Logistics | 96 | -18 |\n| Cobalt Systems | 88 | +7 |\n\n- Northwind is down for the third day: worth a call.\n- Meridian's jump follows their new F&I hire.`;
  const runs = [
    { job: daily, h: 2, state: 'completed', title: 'Credit Check daily · up 6%', body: report(0), accounts: dealers.slice(0, 14), credits: 1.8, deliveries: [{ kind: 'slack', target: '#credit-check-cs-handoff', state: 'sent' }] },
    { job: risk, h: 5, state: 'needs_review', title: 'Northwind Logistics: pulls down 3 days running', body: 'Northwind Logistics pulled 96 reports yesterday, down 18%, the third drop in a row. Their F&I manager left last week.\n\n**Suggested:** a check-in from the account owner today.', accounts: ['c2'], credits: 0.6 },
    { job: risk, h: 9, state: 'failed', title: null, error: "Step 3 · Slack: Slack isn't connected", failure: { text: "Slack isn't connected", fix: { label: 'Connect Slack', href: '/integrations' } }, accounts: ['c3'], credits: 0.4 },
    { job: daily, h: 26, state: 'completed', title: 'Credit Check daily · flat', body: report(1), accounts: dealers.slice(2, 16), credits: 1.7, deliveries: [{ kind: 'slack', target: '#credit-check-cs-handoff', state: 'sent' }] },
    { job: daily, h: 50, state: 'completed', title: 'Credit Check daily · down 2%', body: report(2), accounts: dealers.slice(4, 20), credits: 1.9, deliveries: [{ kind: 'slack', target: '#credit-check-cs-handoff', state: 'failed', error: 'channel_not_found' }] },
    { job: daily, h: 0.05, state: 'running', title: null, accounts: [], credits: 0 },
  ];
  for (const r of runs) state.results.push({ id: randomUUID(), revbox_id: tu.id, job_id: r.job.id, job_name: r.job.name, kind: 'routine', state: r.state, created_at: at(r.h), error: r.error ?? null, failure: r.failure ?? null, credits: r.credits, account_ids: r.accounts,
    result: r.title ? { title: r.title, body: r.body, kind: 'report' } : null, deliveries: (r.deliveries ?? []).map(d => ({ id: randomUUID(), state: d.state, error: d.error ?? null, destination: { kind: d.kind, target: d.target } })) });
  state.seeded.page_polish = true;
}
// GET-901: Slack trouble on a box. "Harborline daily digest" posts to a private channel the bot was
// never invited to (its last run failed: "Invite @Nous to #harborline-leadership"), and delivers to a
// box Slack destination that was archived since. Start the preview with PREVIEW_SLACK=disconnected
// (or broken) to see every Slack job, the rail and Results say "Slack disconnected · Reconnect".
if (!state.seeded.slack_health) {
  const H = 3_600_000, at = (h) => new Date(Date.now() - h * H).toISOString();
  const hb = base('Harborline daily digest', 'A morning digest of the pipeline for the leadership channel.', true, { mode: 'all', account_ids: [], min_icp: 70 });
  const archived = { id: randomUUID(), kind: 'slack', target: 'C07HBOLDOPS', channel: 'harborline-ops-2025' };
  hb.delivery = [archived];
  state.boxes.unshift(hb);
  const digest = { id: randomUUID(), revbox_id: hb.id, source: 'routine', name: 'Pipeline digest', enabled: true, trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'UTC', trigger_label: 'Every day at 08:00 (UTC)', last_run_at: at(3), version: 1, created_by: 'u1', steps: [
    { id: 'write', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the pipeline digest.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'G07HBLEAD01', channel: 'harborline-leadership', text: '{{steps.write.output}}', format: 'digest' } },
  ] };
  const box = { id: randomUUID(), revbox_id: hb.id, source: 'routine', name: 'Deal-room handoff', enabled: true, trigger_kind: 'deal_closed_won', trigger_config: {}, timezone: 'UTC', trigger_label: 'When a deal is won', last_run_at: at(20), version: 1, created_by: 'u1', steps: [
    { id: 'brief', type: 'agent', config: { mode: 'write', prompt: 'Write the handoff.' } },
    { id: 'deliver', type: 'revbox_delivery', config: { format: 'handoff' } },
  ] };
  state.routines.unshift(digest, box);
  const runs = [
    { job: digest, h: 3, state: 'failed', error: "Step 2 · Slack: Slack can't see that channel. If it's private, invite the Nous app: type /invite @Nous in the channel",
      failure: { text: "Slack can't see that channel. If it's private, invite the Nous app: type /invite @Nous in the channel", fix: null },
      step_log: [{ step: 1, id: 'write', type: 'agent', status: 'ok' }, { step: 2, id: 'post', type: 'slack', status: 'failed', reason: 'slack_channel_not_found', target: 'G07HBLEAD01', detail: "Slack can't see that channel" }] },
    { job: box, h: 20, state: 'failed', error: 'Step 2 · RevBox delivery: revbox_delivery_failed: slack C07HBOLDOPS: that channel is archived',
      failure: { text: 'Revbox delivery failed: slack C07HBOLDOPS: that channel is archived', fix: null },
      step_log: [{ step: 2, id: 'deliver', type: 'revbox_delivery', status: 'failed', deliveries: [{ id: archived.id, kind: 'slack', target: 'C07HBOLDOPS', ok: false, error: 'slack_is_archived' }] }],
      deliveries: [{ kind: 'slack', target: 'C07HBOLDOPS', state: 'failed', error: 'that channel is archived' }] },
    { job: digest, h: 27, state: 'completed', title: 'Pipeline digest', body: 'Three deals moved to evaluating yesterday; Fernpoint asked for a security review.', credits: 0.9,
      step_log: [{ step: 2, id: 'post', type: 'slack', status: 'ok', target: 'G07HBLEAD01' }] },
  ];
  for (const r of runs) state.results.push({ id: randomUUID(), revbox_id: hb.id, job_id: r.job.id, job_name: r.job.name, kind: 'routine', state: r.state, created_at: at(r.h), error: r.error ?? null, failure: r.failure ?? null, credits: r.credits ?? 0.3, account_ids: [],
    step_log: r.step_log, result: r.title ? { title: r.title, body: r.body, kind: 'report' } : null, deliveries: (r.deliveries ?? []).map(d => ({ id: randomUUID(), state: d.state, error: d.error ?? null, destination: { kind: d.kind, target: d.target } })) });
  state.seeded.slack_health = true;
}
// GET-874: a "Closed won/lost analysis" box. Job 1 analyses each won or lost deal against the box's ICP
// and adds a row to "Win/loss deals"; job 2 writes the monthly win/loss report from last month's rows;
// job 3 the quarterly one. ~25 fake rows, each linked to the deal-analysis run that added it.
state.datasets ??= [];
state.dataset_rows ??= [];
if (!state.seeded.datasets) {
  const H = 3_600_000, D = 24 * H, at = (ms) => new Date(Date.now() - ms).toISOString();
  const wl = base('Closed won/lost analysis', 'Learn why we win and lose: every closed deal analysed against our ICP, a monthly win/loss report and a quarterly review.', true, { mode: 'all', account_ids: [], min_icp: 70 });
  wl.blocks = [{ id: randomUUID(), title: 'What to look for', body: 'For every closed deal: did it fit the ICP, the one primary reason it was won or lost, and the competitor if one was in the deal.' }];
  wl.members = [{ user_id: 'u2', role: 'editor' }];
  wl.delivery = [{ id: randomUUID(), kind: 'slack', target: 'C07REVLEAD', channel: 'revenue-leadership' }];
  state.boxes.unshift(wl);
  state.context.push({ id: randomUUID(), revbox_id: wl.id, title: 'ICP.md', body: 'Ideal customer: B2B SaaS and logistics companies, 100-1,000 employees, a RevOps owner, already on HubSpot. Poor fit: under 50 employees, no CRM, agencies.', document_id: null });
  const analyse = { id: randomUUID(), revbox_id: wl.id, source: 'routine', name: 'Analyse closed deals', enabled: true, trigger_kind: 'deal_closed_won', trigger_config: {}, timezone: 'UTC', trigger_label: 'When a deal is won or lost', last_run_at: at(2 * H), version: 1, created_by: 'u1', steps: [
    { id: 'analyse', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Analyse this deal against our ICP: fit, the primary reason it was won or lost, the competitor.' } },
    { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss_deals', dedupe_from: 'deal' } },
  ] };
  const monthly = { id: randomUUID(), revbox_id: wl.id, source: 'routine', name: 'Monthly win/loss report', enabled: true, trigger_kind: 'clock', trigger_config: { frequency: 'monthly', at: '08:00' }, timezone: 'UTC', trigger_label: 'On the first of the month at 08:00 (UTC)', last_run_at: at(13 * D), version: 1, created_by: 'u1', steps: [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss_deals', window: 'last_month', limit: 200 } },
    { id: 'report', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the monthly win/loss report: win rate, value won and lost, ICP fit of wins vs losses, the top reasons and competitors, and what to change.' } },
    { id: 'box_delivery', type: 'revbox_delivery', config: { format: 'report' } },
  ] };
  const quarterly = { id: randomUUID(), revbox_id: wl.id, source: 'routine', name: 'Quarterly win/loss review', enabled: true, trigger_kind: 'clock', trigger_config: { frequency: 'quarterly', at: '08:00' }, timezone: 'UTC', trigger_label: 'At the start of each quarter at 08:00 (UTC)', last_run_at: at(13 * D), version: 1, created_by: 'u1', steps: [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss_deals', window: 'last_quarter', limit: 500 } },
    { id: 'report', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the quarterly win/loss review: trends month over month, the patterns behind wins and losses, and three recommendations.' } },
  ] };
  state.routines.unshift(analyse, monthly, quarterly);
  const ds = { id: randomUUID(), revbox_id: wl.id, key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per deal won or lost, analysed against the ICP.', created_by: 'u1', created_at: at(80 * D), updated_at: at(80 * D),
    columns: normalizeDatasetColumns([
      { key: 'deal', label: 'Deal', type: 'text' }, { key: 'outcome', label: 'Outcome', type: 'enum', options: ['Won', 'Lost'] }, { key: 'value', label: 'Value', type: 'number' },
      { key: 'close_date', label: 'Close date', type: 'date' }, { key: 'icp_fit', label: 'ICP fit', type: 'enum', options: ['Strong', 'Partial', 'Poor'] },
      { key: 'primary_reason', label: 'Primary reason', type: 'text' }, { key: 'competitor', label: 'Competitor', type: 'text' },
    ]).columns };
  state.datasets.push(ds);
  const reasons = { Won: ['Reporting depth closed it', 'Fast HubSpot rollout', 'Champion pushed it through procurement', 'Pricing fit the seat count', 'Security review passed first time'], Lost: ['Chose a cheaper point tool', 'No budget owner', 'Went quiet after the demo', 'Too small for the platform', 'Lost to the incumbent CRM add-on'] };
  const rivals = ['Lumen Track', 'Lumen Pipeline', '', 'Fernpoint CRM add-on', '', 'Harborline Insights'];
  for (let i = 0; i < 25; i++) {
    const co = COMPANIES[i % COMPANIES.length];
    const won = (i * 7) % 5 < 3;
    const outcome = won ? 'Won' : 'Lost';
    const ago = (2 + i * 3.3) * D;
    const fit = won ? (i % 4 ? 'Strong' : 'Partial') : (['Poor', 'Partial', 'Strong'][i % 3]);
    const run = { id: randomUUID(), revbox_id: wl.id, job_id: analyse.id, job_name: analyse.name, kind: 'routine', state: 'completed', created_at: at(ago), error: null, failure: null, credits: 0.7, account_ids: [co.id],
      result: { title: `${co.name}: closed ${outcome.toLowerCase()}`, kind: 'report', body: `## ${co.name} · closed ${outcome.toLowerCase()}\n\n**ICP fit: ${fit}.** ${reasons[outcome][i % 5]}.\n\n- ${co.employee_count} employees, ${co.industry}.\n- ${rivals[i % rivals.length] ? `Competing with ${rivals[i % rivals.length]}.` : 'No competitor in the deal.'}` }, deliveries: [] };
    state.results.push(run);
    state.dataset_rows.push({ id: randomUUID(), dataset_id: ds.id, entity_id: co.id, source_run_id: run.id, source_job_id: analyse.id, dedupe_key: `deal:preview-${i}`, created_at: at(ago),
      data: { deal: `${co.name} · ${['Platform', 'RevOps seats', 'Pilot', 'Expansion'][i % 4]}`, outcome, value: 6000 + ((i * 7919) % 60) * 1000, close_date: at(ago).slice(0, 10), icp_fit: fit, primary_reason: reasons[outcome][i % 5], ...(rivals[i % rivals.length] ? { competitor: rivals[i % rivals.length] } : {}) } });
  }
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
  state.results.push({ id: randomUUID(), revbox_id: wl.id, job_id: monthly.id, job_name: monthly.name, kind: 'routine', state: 'completed', created_at: at(13 * D), error: null, failure: null, credits: 1.4, account_ids: [],
    result: { title: `Win/loss report · ${month}`, kind: 'report', body: `## Win/loss report · ${month}\n\n**Won 6 of 9 deals (67%)**, $214,000 won and $61,000 lost. Win rate up from 55% the month before.\n\n| | Won | Lost |\n|---|---:|---:|\n| Strong ICP fit | 5 | 1 |\n| Partial fit | 1 | 1 |\n| Poor fit | 0 | 1 |\n\n### Why we won\n- Reporting depth closed three deals.\n- A fast HubSpot rollout mattered to logistics buyers.\n\n### Why we lost\n- Two of three losses were outside the ICP: under 50 employees, no RevOps owner.\n- Lumen Track undercut us once on price.\n\n### What to change\n- Qualify out sub-50-employee prospects before the demo.\n- Lead with the reporting walkthrough in logistics deals.` },
    deliveries: [{ id: randomUUID(), state: 'sent', error: null, destination: { kind: 'slack', target: '#revenue-leadership' } }] });
  state.seeded.datasets = true;
}

// The workspace context library (GET-875), as 2026_10_15_context_library.sql: every per-box context
// row becomes a file with the same id plus one link. Then, once, the ICP file tagged to two boxes.
state.files ??= [];
state.links ??= [];
for (const c of state.context ?? []) {
  if (!state.files.some(f => f.id === c.id)) state.files.push({ id: c.id, title: c.title, kind: 'reference', body: c.body ?? '', document_id: c.document_id ?? null, visibility: 'boxes', created_by: c.created_by ?? 'u1', created_at: c.created_at ?? stamp(), updated_at: c.created_at ?? stamp(), icp_marked_at: null });
  if (!state.links.some(l => l.revbox_id === c.revbox_id && l.file_id === c.id)) state.links.push({ revbox_id: c.revbox_id, file_id: c.id, created_at: c.created_at ?? stamp() });
}
state.context = [];
if (!state.seeded.context_library) {
  const icp = state.files.find(f => f.title === 'ICP.md') ?? (() => { const f = { id: randomUUID(), title: 'ICP.md', kind: 'reference', body: 'Ideal customer: B2B SaaS and logistics companies, 100-1,000 employees, a RevOps owner, already on HubSpot. Poor fit: under 50 employees, no CRM, agencies.', document_id: null, visibility: 'boxes', created_by: 'u1', created_at: stamp(), updated_at: stamp(), icp_marked_at: null }; state.files.push(f); return f; })();
  Object.assign(icp, { kind: 'icp', visibility: 'workspace', icp_marked_at: stamp() });
  for (const b of state.boxes.filter(b => /won\/lost|onboarding/i.test(b.name)).slice(0, 2)) if (!state.links.some(l => l.revbox_id === b.id && l.file_id === icp.id)) state.links.push({ revbox_id: b.id, file_id: icp.id, created_at: stamp() });
  state.files.push({ id: randomUUID(), title: 'Email voice', kind: 'instructions', body: 'Plain, short sentences. One ask per email. No exclamation marks.', document_id: null, visibility: 'workspace', created_by: 'u1', created_at: stamp(), updated_at: stamp(), icp_marked_at: null });
  state.seeded.context_library = true;
}
// Context as documents (GET-895): a markdown-rich library file and a markdown instruction block on the
// won/lost box, so the document sheet shows headings, lists, a table, bold and code at :8080.
if (!state.seeded.context_docs) {
  const REPORT_FORMAT = [
    '# Win/loss report format', '',
    'Every report a job in this box writes follows this shape. Lead with the **number**, then the reasons.', '',
    '## Structure', '',
    '1. **Headline**: win rate and value won, against the month before.',
    '2. **Fit table**: wins and losses by ICP fit.',
    '3. **Why we won** and **why we lost**: three bullets each, most frequent first.',
    '4. **What to change**: at most three actions, each with an owner.', '',
    '## The fit table', '',
    '| Fit | Won | Lost | Note |', '|---|---:|---:|---|',
    '| Strong | 5 | 1 | The segment to double down on |', '| Partial | 1 | 1 | Qualify harder before the demo |', '| Poor | 0 | 1 | Should not have reached a demo |', '',
    '### Style', '',
    '- Plain sentences, no jargon. *One idea per bullet.*',
    '- Name competitors exactly as they appear on the deal, e.g. `Lumen Track`.',
    '- Round money to the nearest thousand: $214,000, not $213,862.', '',
    '> If a month has fewer than five closed deals, say so and skip the percentages.',
  ].join('\n');
  const wl = state.boxes.find(b => /won\/lost/i.test(b.name));
  const f = { id: randomUUID(), title: 'Win/loss report format', kind: 'instructions', body: REPORT_FORMAT, document_id: null, visibility: 'workspace', created_by: 'u1', created_at: stamp(), updated_at: stamp(), icp_marked_at: null };
  state.files.push(f);
  if (wl) {
    state.links.push({ revbox_id: wl.id, file_id: f.id, created_at: stamp() });
    if (!wl.blocks.some(b => b.title === 'Report format')) wl.blocks.push({ id: randomUUID(), title: 'Report format', body: '## Report format\n\nOpen with the result in one sentence, then:\n\n- **Fit**: Strong, Partial or Poor, with the reason.\n- **Primary reason**: the one thing that decided it.\n- **Competitor**: as named on the deal, or "none".\n\n### Example\n\n| Deal | Fit | Reason |\n|---|---|---|\n| Platform | Strong | Reporting depth closed it |' });
  }
  state.seeded.context_docs = true;
}
// Who scores the preview workspace (GET-878): it starts on 'external' (its own model), so Mark as
// ICP and Rebuild ask first; confirming switches it to 'nous'. `icp_scorer` in the store resets it.
state.icp_scorer ??= 'external';
const ICP_SWITCH_MESSAGE = "Nous will score this workspace's accounts from this file from now on. Scores already posted from outside stay until they resolve.";
const boxFiles = (boxId) => state.links.filter(l => l.revbox_id === boxId).map(l => state.files.find(f => f.id === l.file_id)).filter(Boolean)
  .map(f => ({ id: f.id, title: f.title, body: f.body, document_id: f.document_id, kind: f.kind, visibility: f.visibility }));
/** Settings > Context and its edits, as the API's library routes (core contextLibrary.mjs). */
async function libraryPreview(req, json, parts, payload, uid) {
  const admin = USERS.find(u => u.id === uid)?.role === 'admin';
  const access = new Map(state.boxes.map(b => [b.id, revboxAccess(b, uid, b.members)]).filter(([, a]) => a));
  const tags = (f) => state.links.filter(l => l.file_id === f.id).map(l => l.revbox_id);
  const visible = (f) => f.visibility === 'workspace' || f.created_by === uid || tags(f).some(id => access.has(id));
  const editable = (f) => f.kind === 'icp' ? admin : (f.created_by === uid || admin || (tags(f).length > 0 && tags(f).every(id => ['owner', 'editor'].includes(access.get(id)))));
  const out = (f) => ({ ...f, boxes: tags(f).filter(id => access.has(id)).map(id => { const b = state.boxes.find(x => x.id === id); return { id, name: b.name, shared: b.shared }; }), hidden_boxes: tags(f).filter(id => !access.has(id)).length, can_edit: editable(f) });
  const retag = (f, ids) => {
    for (const id of ids) if (!['owner', 'editor'].includes(access.get(id)) && !tags(f).includes(id)) fail(403, 'Only an owner or editor of a RevBox can change its context.');
    state.links = state.links.filter(l => l.file_id !== f.id || !access.has(l.revbox_id) || ids.includes(l.revbox_id));
    for (const id of ids) if (!tags(f).includes(id)) state.links.push({ revbox_id: id, file_id: f.id, created_at: stamp() });
  };
  const markIcp = (f, on) => {
    if (!admin) fail(403, 'Only a workspace owner or admin can choose the ICP file.');
    if (on && state.files.some(x => x.kind === 'icp' && x.id !== f.id)) fail(409, 'This workspace already has an ICP file. Unmark it first.');
    Object.assign(f, on ? { kind: 'icp', visibility_before_icp: f.visibility, visibility: 'workspace', icp_marked_at: stamp() } : { kind: 'reference', visibility: f.visibility_before_icp ?? f.visibility, visibility_before_icp: null, icp_marked_at: null });
  };
  // As markIcpFile (api lib/icpContextFile.mjs): on 'external', confirm first (409, nothing written),
  // then switch to 'nous' and build from the file (force).
  const scorerGate = () => {
    if (!admin || state.icp_scorer !== 'external') return false;
    if (payload.confirm_scorer_switch !== true) throw Object.assign(new Error(ICP_SWITCH_MESSAGE), { status: 409, code: 'icp_scorer_switch_required' });
    return true;
  };
  const scoring = (switching, rebuild) => {
    if (switching) state.icp_scorer = 'nous';
    return switching || rebuild ? { status: 'created', signals: 20, foundation: 'mirrored', ...(switching ? { scorer: 'nous', scorer_switched: true } : {}) } : { status: 'exists', signals: 6, foundation: 'mirrored' };
  };
  if (parts[0] === 'context-library') {
    const files = state.files.filter(visible).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(out);
    return json({ files, icp_file_id: files.find(f => f.kind === 'icp')?.id ?? null, is_admin: admin, boxes: state.boxes.filter(b => access.has(b.id)).map(b => ({ id: b.id, name: b.name, shared: b.shared, access: access.get(b.id), blocks: b.blocks })) });
  }
  const file = parts[1] ? state.files.find(f => f.id === parts[1] && visible(f)) : null;
  if (parts[1] && !file) fail(404, 'Context file not found.');
  if (req.method === 'POST' && !parts[1]) {
    if (!payload.title?.trim()) fail(400, 'Give the file a title of up to 200 characters.');
    const switching = payload.kind === 'icp' ? scorerGate() : false;
    const f = { id: randomUUID(), title: payload.title.trim(), kind: payload.kind === 'instructions' ? 'instructions' : 'reference', body: payload.body ?? '', document_id: null, visibility: payload.visibility === 'workspace' ? 'workspace' : 'boxes', created_by: uid, created_at: stamp(), updated_at: stamp(), icp_marked_at: null };
    state.files.push(f); retag(f, payload.revbox_ids ?? []);
    if (payload.kind === 'icp') markIcp(f, true);
    const icp = f.kind === 'icp' ? scoring(switching, false) : null;
    await persist(); return json({ file: out(f), ...(icp ? { icp } : {}) }, 201);
  }
  if (req.method === 'POST' && parts[2] === 'icp-rebuild') { if (!admin) fail(403, 'Only a workspace owner or admin can rebuild ICP scoring.'); if (file.kind !== 'icp') fail(400, 'Mark this file as the ICP first.'); const icp = scoring(scorerGate(), true); await persist(); return json({ icp }); }
  if (req.method === 'PATCH') {
    const wasIcp = file.kind === 'icp';
    const switching = payload.kind === 'icp' && !wasIcp ? scorerGate() : false;
    if (['title', 'body', 'visibility'].some(k => k in payload) && !editable(file)) fail(403, 'You cannot change this file.');
    if ('kind' in payload && (payload.kind === 'icp') !== wasIcp) markIcp(file, payload.kind === 'icp');
    if ('kind' in payload && payload.kind !== 'icp') file.kind = payload.kind;
    if ('title' in payload) file.title = String(payload.title).trim();
    if ('body' in payload && !file.document_id) file.body = payload.body;
    if ('visibility' in payload && file.kind !== 'icp') file.visibility = payload.visibility;
    if (Array.isArray(payload.revbox_ids)) retag(file, payload.revbox_ids);
    file.updated_at = stamp(); await persist();
    return json({ file: out(file), ...(!wasIcp && file.kind === 'icp' ? { icp: scoring(switching, false) } : {}) });
  }
  if (req.method === 'DELETE') {
    if (file.kind === 'icp' ? !admin : (file.created_by !== uid && !admin)) fail(403, 'Only the person who added this file or a workspace admin can delete it.');
    state.files = state.files.filter(f => f.id !== file.id); state.links = state.links.filter(l => l.file_id !== file.id); await persist(); return json({ ok: true });
  }
  fail(404, 'Not found.');
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
// Edit on a job no chat made (GET-873/884): the job's current setup as an approved card.
let jobProposalModule = null;
try { jobProposalModule = await import('../../../packages/core/dist/db/revboxJobProposal.mjs'); } catch { /* not built */ }
let scheduleModule = null;
try { scheduleModule = await import('../../../packages/core/dist/services/routineSchedule.mjs'); } catch { /* not built */ }
// Slack trouble on the cards, the rail and Results (GET-901), derived as the API derives it.
let slackHealthModule = null;
try { slackHealthModule = await import('../../../packages/core/dist/services/slackHealth.mjs'); } catch { /* not built */ }
/** The preview's Slack connection: PREVIEW_SLACK=disconnected | broken, else connected and working. */
const previewSlackConnection = () => ({ disconnected: { connected: false, working: false }, broken: { connected: true, working: false } }[process.env.PREVIEW_SLACK] ?? { connected: true, working: true });
/** The box's Slack state, as GET /api/revboxes/:id carries it. */
function previewSlack(box, routines) {
  if (!slackHealthModule) return { routines, slack: null, deliveries: (d) => d };
  const runs = state.results.filter(r => r.revbox_id === box.id && r.kind === 'routine').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(r => ({ routine_id: r.job_id, step_log: r.step_log ?? [] }));
  const v = slackHealthModule.slackHealthView({ connection: previewSlackConnection(), routines, runs, box });
  const usesSlack = routines.some(r => slackHealthModule.jobUsesSlack(r.steps, box)) || box.delivery.some(d => d.kind === 'slack');
  const byDest = Object.fromEntries(Object.entries(v.deliveries).filter(([k]) => k.startsWith('box:')).map(([k, s]) => [k.slice(4), s]));
  return {
    routines: routines.map(r => ({ ...r, slack_status: v.jobs[r.id] ?? null })),
    slack: usesSlack ? { connection: v.connection, deliveries: byDest } : null,
    deliveries: (rows) => rows.map(j => j.kind === 'slack' && j.step_id ? { ...j, slack_status: v.deliveries[`step:${j.job_id}:${j.step_id}`] ?? v.connection ?? null } : j),
  };
}
/** A failed routine run's Slack trouble (Results), as the API adds it. */
function previewRunSlack(run, box) {
  if (!slackHealthModule || !run.failure || run.kind !== 'routine') return run;
  const steps = state.routines.find(r => r.id === run.job_id)?.steps ?? [];
  const slack = slackHealthModule.runSlackStatus({ connection: previewSlackConnection(), run, steps, box });
  return slack ? { ...run, failure: { ...run.failure, slack } } : run;
}
// The preview user's own Gmail accounts, as /api/actions/mailboxes answers in server.mjs.
const PREVIEW_MAILBOXES = [{ id: 'mb-1', kind: 'gmail', email: 'avery@opennous.example' }, { id: 'mb-2', kind: 'gmail', email: 'test.user.0001@gmail.com' }];
function previewSignalKey(name, taken) {
  let k = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k)) k = `signal_${k}`.replace(/_+$/, '');
  k = k.slice(0, 63) || 'signal';
  let out = k; for (let n = 2; taken.includes(out); n++) out = `${k}_${n}`;
  return out;
}
// The tools the preview workspace has connected (the same list as the revbox catalog's connections).
const PREVIEW_CONNECTED = ['granola', 'hubspot', 'gmail', 'slack'];
function previewCatalog() {
  const custom = state.signals;
  // Meeting signals offer only the connected recorders, and the connected tools come along (GET-892).
  if (catalogModule?.withConnectedRecorders) return { ...catalogModule.withConnectedRecorders(catalogModule.signalCatalog({ custom }), PREVIEW_CONNECTED), connected: PREVIEW_CONNECTED, groups: catalogModule.SIGNAL_GROUPS };
  if (catalogModule) return { ...catalogModule.signalCatalog({ custom }), groups: catalogModule.SIGNAL_GROUPS };
  return {
    recorders: ['granola'], connected: PREVIEW_CONNECTED,
    builtin: [
      { key: 'meeting.done', label: 'Meeting done', description: 'A recorded meeting ended and its notes are in.', group: 'meetings', providers: ['granola', 'any'], trigger: { kind: 'call_ended', config: {} } },
      { key: 'deal.won', label: 'Deal won', description: 'A deal moved to closed won.', group: 'deals', trigger: { kind: 'deal_closed_won', config: {} } },
      { key: 'signal.churn_risk', label: 'Churn risk', description: 'The customer showed a risk of churning.', group: 'account', trigger: { kind: 'account_signal', config: { signals: ['churn_risk'] } } },
      { key: 'schedule', label: 'On a schedule', description: 'No signal: the job runs on a clock.', group: 'schedule', trigger: { kind: 'clock', config: {} } },
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

// Each account's latest signal as account_signals holds it (GET-894): the API adds label, tone and
// text with core's latestSignalView, so the Accounts table shows the same tinted tags here.
const PREVIEW_SIGNALS = {
  c1: { kind: 'competitor_evaluating', title: 'Gong pilot', content: 'Four weeks into a Gong pilot on the enterprise team; wants a side-by-side before renewal.', quote: "We're four weeks into a Gong pilot." },
  c2: { kind: 'churn_risk', title: null, content: 'Switching to a cheaper provider after renewal unless reps stop updating the CRM by hand.', quote: 'we would have to displace it' },
  c3: { kind: 'stakeholder_identified', title: 'New VP Sales', content: 'The new VP Sales signs off on tooling over 20 seats.', quote: null },
  c4: { kind: 'expansion_signal', title: 'Trade', content: 'Asked to add the support team, about 40 more seats, next quarter.', quote: 'can we bring support on too' },
  c5: { kind: 'budget_discussed', title: 'Monthly Cost Need', content: 'No line item until the January planning cycle; asked for monthly billing.', quote: null },
  c6: { kind: 'objection_raised', title: 'Pricing pushback', content: 'The number works for next year, not this one.', quote: null },
  c7: { kind: 'next_step', title: 'Send the security questionnaire', content: 'Send the security questionnaire by Friday.', quote: null },
  c8: { kind: 'buying_signal', title: 'Wants setup', content: 'Wants to get set up before the quarter closes.', quote: 'I just want to get set up' },
};
export const previewRevboxAccounts = COMPANIES.map((c, i) => {
  const deals = DEALS.filter(d => d.company_id === c.id);
  const raw = PREVIEW_SIGNALS[c.id];
  return { ...c, people_count: CONTACTS.filter(p => p.company_id === c.id).length, deal_count: deals.length, won_deals: deals.filter(d => d.status === 'won').length, lost_deals: deals.filter(d => d.status === 'lost').length, last_activity_at: CONTACTS.filter(p => p.company_id === c.id).map(p => p.last_activity_at).filter(Boolean).sort().at(-1) ?? null, latest_signal: raw ? latestSignalView({ ...raw, at: stamp() }) : null };
});
// Profile photos for the Owners rail (GET-872): inline SVGs, so the preview needs no network.
const face = (a, b) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="25" r="11" fill="#fff" fill-opacity=".85"/><path d="M12 60c3-12 11-18 20-18s17 6 20 18" fill="#fff" fill-opacity=".85"/></svg>`)}`;
const AVATARS = { u1: face('#f59e0b', '#b45309'), u2: face('#60a5fa', '#1d4ed8') };   // u3 has none: initials
function previewPeople(box) {
  const list = [{ user_id: box.owner_id, role: 'owner' }, ...(box.members ?? []).filter(m => m.user_id !== box.owner_id)];
  return list.map(m => { const u = USERS.find(x => x.id === m.user_id); return { id: m.user_id, role: m.role, name: u?.name ?? null, email: u?.email ?? null, avatar_url: AVATARS[m.user_id] ?? null }; });
}
/** As core revboxRunAccounts: accounts the box's runs touched in the last 30 days, most runs first. */
function previewRunAccounts(box) {
  const since = Date.now() - 30 * 86_400_000;
  const runs = state.results.filter(r => r.revbox_id === box.id && Date.parse(r.created_at) >= since);
  const counts = new Map();
  for (const r of runs) for (const id of new Set(r.account_ids ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1);
  const accounts = [...counts].map(([id, n]) => { const c = COMPANIES.find(x => x.id === id); return c ? { id, name: c.name, domain: c.domain, runs: n } : null; }).filter(Boolean)
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return { run_accounts: accounts, run_accounts_total: accounts.length, run_accounts_runs: runs.length, run_accounts_linked: accounts.length > 0 };
}
/**
 * As core revboxWorkedAccounts (GET-891): what the box's Accounts card counts and its Accounts page
 * and Account graph open on: the selected scope plus the accounts its runs worked on in 30 days (a
 * report run's account_ids stand for the dealers its HubSpot read and its table named).
 */
export function previewWorkedAccounts(box) {
  const worked = new Set([...previewRunAccounts(box).run_accounts.map(a => a.id), ...previewBuiltinAccounts(box)]);
  const selected = new Set(previewRevboxAccounts.filter(a => revboxMatchesAccount(box.scope, a)).map(a => a.id));
  const accounts = previewRevboxAccounts.filter(a => selected.has(a.id) || worked.has(a.id)).map(a => ({ ...a, selected: selected.has(a.id), worked_on: worked.has(a.id) }));
  return { accounts, breakdown: { selected: accounts.filter(a => a.selected).length, worked_on: accounts.filter(a => a.worked_on).length } };
}
/**
 * As core revboxBuiltinEntityIds (GET-902): the accounts a box's built-ins worked on in 30 days (the
 * follow-up's cards, the detectors' drafts). The preview's activity, as fixed slices of its accounts.
 */
const BUILTIN_ACCOUNTS = { sales_follow_up: [0, 9], stale_deal: [9, 13], deal_signals: [12, 15], deal_risk: [15, 17], expansion: [17, 17] };
function previewBuiltinAccounts(box) {
  return builtinJobsOf(box).flatMap(k => previewRevboxAccounts.slice(...(BUILTIN_ACCOUNTS[k] ?? [0, 0])).map(a => a.id));
}
/** The box behind /accounts?revbox=<id> in the preview, or null. */
export const previewRevboxById = (id) => state.boxes.find(b => b.id === id) ?? null;
const AGO = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const BUILTIN_ACTIVITY = { sales_follow_up: [12, 3], stale_deal: [7, 30], deal_signals: [4, 5], deal_risk: [2, 52], expansion: [0, null] };
function previewBuiltins(box) {
  const keys = builtinJobsOf(box);
  return { builtin_jobs: REVBOX_BUILTIN_JOBS.filter(j => keys.includes(j.key)).map(({ drafts: _, ...j }) => ({ ...j, drafts_30d: BUILTIN_ACTIVITY[j.key][0], last_draft_at: BUILTIN_ACTIVITY[j.key][1] == null ? null : AGO(BUILTIN_ACTIVITY[j.key][1]),
      brief: builtinJobBrief(j.key, PREVIEW_BUILTIN_FACTS), enabled: previewBuiltinOn(j.key) })),
    builtin_taken: state.boxes.filter(b => b.id !== box.id).flatMap(b => builtinJobsOf(b).map(key => ({ key, box_id: b.id, box_name: b.name }))) };
}
/**
 * As the API's ensure-on-read (core planDefaultBuiltinBoxes, GET-897): the preview workspace is on
 * the Workspace plan, so every built-in sits in a box, "Meetings Follow-up" holding the after-call
 * follow-up. Applied on each list read, like the API; a box with the default name gains its built-in.
 */
function ensurePreviewBuiltinBoxes() {
  let changed = false;
  for (const step of planDefaultBuiltinBoxes(state.boxes)) {
    if (step.add) { const b = state.boxes.find(x => x.id === step.add); b.builtin_jobs = applyBuiltinOps(builtinJobsOf(b), { add: step.keys }); b.revision += 1; }
    else { const b = base(step.create, step.objective, true, { mode: 'all', account_ids: [], min_icp: 0 }); b.builtin_jobs = step.keys; state.boxes.push(b); }
    changed = true;
  }
  return changed;
}
/** A built-in's On/Off in the preview: Expansion signals starts off; the follow-up's chat can switch it (GET-902). */
const previewBuiltinOn = (key) => (key === 'sales_follow_up' && state.follow_up_off ? false : key !== 'expansion');
/**
 * As the API's box read (GET-902, withBoxEmailVoice): a box holding an email-drafting built-in gets its
 * "Email voice" file once, seeded with the voice its drafter used until now, tagged to it. -> { id, created } | null.
 */
function ensurePreviewEmailVoice(box) {
  const keys = emailDraftingBuiltins(box);
  if (!keys.length) return null;
  const have = boxFiles(box.id).find(isEmailVoiceFile);
  if (have) return { id: have.id, created: false };
  const f = { id: randomUUID(), title: EMAIL_VOICE_TITLE, kind: 'instructions', body: emailVoiceSeed(keys), document_id: null, visibility: 'boxes', created_by: box.owner_id, created_at: stamp(), updated_at: stamp(), icp_marked_at: null };
  state.files.push(f); state.links.push({ revbox_id: box.id, file_id: f.id, created_at: stamp() });
  return { id: f.id, created: true };
}
// The preview's connected recorders and CRM write-back, as the API's builtinFacts reads them.
const PREVIEW_BUILTIN_FACTS = { recorders: ['granola', 'fireflies'], crm: 'hubspot' };
/** The connected Slack as /api/slack/targets answers in the preview (server.mjs). */
export const PREVIEW_SLACK = { connected: true,
  team: { id: 'T07OPENNOUS', name: 'OpenNous', icon: face('#111827', '#4b5563') },
  channels: [
    { id: 'C07CSHANDOFFS', name: 'cs-handoffs', private: false, member: true },
    { id: 'C07TU1HANDOFF', name: 'credit-check-cs-handoff', private: false, member: true },
    { id: 'C07LEADERSHIP', name: 'cs-leadership', private: true, member: true },
    { id: 'C07GENERAL', name: 'general', private: false, member: false },
  ], people: [{ id: 'U07AVERY', name: 'Avery Example', email: 'avery@opennous.example' }] };
const refs = [{ id: 'doc-email-voice', title: 'Email voice', body: 'Write like a helpful colleague. Short paragraphs, concrete next steps, no filler. Do not promise anything that was not agreed.' }, { id: 'doc-cs-playbook', title: 'Customer onboarding playbook', body: 'Before kickoff, confirm the champion, implementation owner, key promises and success measure. Highlight open risks and who owns the first next step.' }];
const connections = PREVIEW_CONNECTED.map(slug => ({ id: `preview-${slug}`, slug, name: slug, email: slug === 'gmail' ? USERS[0].email : null }));
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => { raw += c; if (raw.length > 400000) reject(Object.assign(new Error('Reference is too large.'), { status: 413 })); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); } }); }); }
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** /api/revboxes/:id/datasets (GET-874): list, create, rename/columns, rows (cursor, q), export.csv. As the API. */
async function datasetsPreview(req, res, json, box, access, parts, payload, url, uid) {
  const [, , key, action] = parts;
  const mine = () => state.datasets.filter(d => d.revbox_id === box.id);
  const rowsOf = (d) => state.dataset_rows.filter(r => r.dataset_id === d.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  const out = (d) => { const r = rowsOf(d); return { ...d, row_count: r.length, row_count_capped: false, last_added_at: r[0]?.created_at ?? null }; };
  if (!key && req.method === 'GET') return json(res, { datasets: mine().map(out) });
  if (!key && req.method === 'POST') {
    if (typeof payload.name !== 'string' || !payload.name.trim()) fail(400, 'Choose a name of up to 120 characters.');
    const c = normalizeDatasetColumns(payload.columns); if (c.error) fail(400, c.error);
    const taken = new Set(mine().map(d => d.key)); const b = datasetSlug(payload.name, 56) || 'dataset';
    let k = payload.key ?? b; if (payload.key && taken.has(k)) fail(409, `This RevBox already has a dataset with the key "${k}".`);
    for (let n = 2; taken.has(k); n++) k = `${b}_${n}`;
    const d = { id: randomUUID(), revbox_id: box.id, key: k, name: payload.name.trim(), description: String(payload.description ?? ''), columns: c.columns, created_by: uid, created_at: stamp(), updated_at: stamp() };
    state.datasets.push(d); await persist(); return json(res, { dataset: out(d) }, 201);
  }
  const d = mine().find(x => x.key === key);
  if (!d) fail(404, 'Dataset not found.');
  if (!action && req.method === 'PUT') {
    if (access === 'viewer') fail(403, 'Only an owner or editor can change this RevBox.');
    if ('key' in payload) fail(400, "A dataset's key cannot change: jobs read it by that key.");
    if ('columns' in payload) { const c = normalizeDatasetColumns(payload.columns); if (c.error) fail(400, c.error); d.columns = c.columns; }
    if ('name' in payload) { if (!String(payload.name ?? '').trim()) fail(400, 'Choose a name of up to 120 characters.'); d.name = payload.name.trim(); }
    if ('description' in payload) d.description = String(payload.description ?? '');
    d.updated_at = stamp(); await persist(); return json(res, { dataset: out(d) });
  }
  const words = String(url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = rowsOf(d).filter(r => !words.length || words.every(w => d.columns.map(c => datasetValueText(c, r.data[c.key])).join(' ').toLowerCase().includes(w)));
  if (action === 'export.csv' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${d.key}-${stamp().slice(0, 10)}.csv"` });
    return res.end(`\uFEFF${datasetRowsCsv(d, all)}`);
  }
  if (action === 'rows' && req.method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const start = Number(url.searchParams.get('cursor') || 0) || 0;
    const page = all.slice(start, start + limit);
    return json(res, { dataset: d, rows: page.map(({ dedupe_key: _, dataset_id: __, ...r }) => r), next_cursor: start + limit < all.length ? String(start + limit) : null });
  }
  fail(404, 'Not found.');
}

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
    if (parts[0] === 'context-library' || parts[0] === 'context-files') { await libraryPreview(req, (body, status) => json(res, body, status), parts, payload, uid); return true; }
    if (parts[0] === 'signals') {
      if(req.method==='GET')json(res,{signals:state.signals});
      else {const old=state.signals.find(s=>s.id===parts[1]);if(old&&old.owner_id!==uid)fail(403,'Only the signal owner can edit.');if(!payload.name?.trim()||!payload.rule?.trim())fail(400,'Add a name and rules.');const signal={...payload,id:old?.id??randomUUID(),version:(old?.version??0)+1};if(old)Object.assign(old,signal);else state.signals.push(signal);await persist();json(res,{signal});}return true;
    }
    if (parts[0] === 'catalog') { json(res, { accounts: previewRevboxAccounts, members: USERS, documents: refs.map(({ body, ...r }) => r), connections }); return true; }
    if (!parts.length) {
      if (req.method === 'POST') { const box = base('Untitled RevBox', '', false, { mode: 'selected', account_ids: [], min_icp: 70 }); box.owner_id = uid; state.boxes.unshift(box); await persist(); json(res, { box: { ...box, access: 'owner' } }, 201); }
      else { if (ensurePreviewBuiltinBoxes()) await persist(); json(res, { boxes: state.boxes.filter(b => revboxAccess(b, uid, b.members)).map(b => ({ ...b, access: revboxAccess(b, uid, b.members) })) }); }
      return true;
    }
    // Which box holds each built-in (GET-897), for the Priorities chip.
    if (parts[0] === 'builtins') { json(res, { homes: state.boxes.flatMap(b => builtinJobsOf(b).map(key => ({ key, box_id: b.id, box_name: revboxAccess(b, uid, b.members) ? b.name : null }))) }); return true; }
    const box = state.boxes.find(b => b.id === parts[0]);
    const access = revboxAccess(box, uid, box?.members ?? []);
    if (!access) fail(404, 'RevBox not found.');
    if (req.method !== 'GET' && access === 'viewer') fail(403, 'Only an owner or editor can change this RevBox.');
    if (parts[1] === 'builder') { await builderPreview(req, res, json, box, parts, payload, uid); return true; }
    const routine = parts[1] === 'jobs' && parts[2] ? state.routines.find(r => r.revbox_id === box.id && r.id === parts[2]) : null;
    if (routine && parts[3] === 'steps' && parts[5] === 'target' && req.method === 'PUT') {
      // As the API's saveJobStepTarget (GET-872): the kind is fixed, the target is checked, the job is versioned.
      const step = (routine.steps ?? []).find(s => s.id === decodeURIComponent(parts[4]));
      if (!step) fail(404, 'Step not found.');
      const kind = step.type === 'gmail' ? (step.config?.send_from?.kind === 'smtp' ? 'smtp' : 'gmail') : step.type;
      if (!['slack', 'gmail', 'email', 'webhook'].includes(kind) || (kind === 'slack' && step.config?.action === 'dm')) fail(400, "Change this step in the job's chat.");
      if (payload.kind !== kind) fail(400, `This step delivers by ${kind}; change its kind in the job's chat.`);
      const c = { ...step.config };
      if (kind === 'slack') { const ch = PREVIEW_SLACK.channels.find(x => x.id === payload.channel_id); if (!ch) fail(400, "Slack can't find that channel. Choose one from the list."); Object.assign(c, { action: 'channel', channel_id: ch.id, channel: ch.name }); }
      else if (kind === 'webhook') { if (!/^https:\/\/[^/]+\.[^/]+/.test(payload.url ?? '') || /localhost|\/\/(10|127|169\.254|192\.168)\./.test(payload.url)) fail(400, 'That webhook address is not a public host.'); c.url = payload.url.trim(); }
      else {
        const list = (v) => String(v ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
        const to = list(payload.to), cc = list(payload.cc);
        if (!to.length) fail(400, 'Add at least one recipient.');
        const bad = [...to, ...cc].find(a => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)); if (bad) fail(400, `"${bad}" is not an email address.`);
        c.to = to.join(', '); c.cc = cc.join(', ');
        if (kind === 'gmail' && payload.mailbox_id && payload.mailbox_id !== c.send_from?.id) { const m = PREVIEW_MAILBOXES.find(x => x.id === payload.mailbox_id); if (!m) fail(400, 'Choose one of your own connected Gmail mailboxes.'); c.send_from = { id: m.id, kind: 'gmail', email: m.email }; }
      }
      step.config = c; routine.version = (routine.version ?? 1) + 1; routine.edited_by = uid;
      await persist();
      json(res, { job_deliveries: builderModule?.revboxJobDeliveries(state.routines.filter(r => r.revbox_id === box.id), { mailboxes: PREVIEW_MAILBOXES }) ?? [] });
      return true;
    }
    if (routine && parts[3] === 'enabled') { routine.enabled = !!payload.enabled; await persist(); json(res, { job: routine }); return true; }
    if (routine && parts[3] === 'test' && req.method === 'POST') {
      // As POST /:id/jobs/:jobId/test (GET-873): one run on real data, every send held and listed instead.
      const held = (routine.steps ?? []).filter(s => ['slack', 'gmail', 'email', 'webhook'].includes(s.type)).map(s => ({ step: s.id, text: s.type === 'slack' ? `Would post to #${s.config?.channel ?? 'channel'}` : s.type === 'webhook' ? 'Would call the webhook' : `Would draft to ${s.config?.to || 'the recipient'}` }));
      const run = { id: randomUUID(), revbox_id: box.id, job_id: routine.id, kind: 'routine', state: 'completed', test: true, held: true, held_actions: held, created_at: stamp(), error: null, credits: 1.2, deliveries: [], result: { title: `${routine.name} (test)`, kind: 'report', body: 'Preview test: no model, HubSpot or Slack was called, and nothing was sent.' } };
      state.results.unshift(run); await persist(); json(res, { run: { id: run.id, job_id: routine.id, kind: "routine", status: "running", test: true, held: true } }, 202); return true;
    }
    if (routine && parts[3] === 'run') {
      const run = { id: randomUUID(), revbox_id: box.id, job_id: routine.id, state: 'completed', created_at: stamp(), error: null, credits: 1.8, deliveries: box.delivery.map(d => ({ id: randomUUID(), state: 'sent', error: null, destination: d })), result: { title: routine.name, kind: 'report', body: 'Preview output — no model, HubSpot or Slack was called.\n\nCredit Check pulls yesterday: 1,284 (+6% vs the day before). Biggest movers: Northside Motors (+41), Lakeshore Auto (-18).' } };
      state.results.unshift(run); routine.last_run_at = run.created_at; await persist(); json(res, { run }); return true;
    }
    if (parts[1] === 'datasets') { await datasetsPreview(req, res, json, box, access, parts, payload, url, uid); return true; }
    const jobs = () => state.jobs.filter(j => j.revbox_id === box.id);
    const context = () => boxFiles(box.id);
    let output;
    if (parts.length === 1 && req.method === 'GET') {
      const voice = ensurePreviewEmailVoice(box);
      if (voice?.created) await persist();
      const emailVoiceId = voice?.id ?? null;
      const routines = state.routines.filter(r => r.revbox_id === box.id);
      const sl = previewSlack(box, routines);
      output = { box: { ...box, builtin_jobs: builtinJobsOf(box), access }, jobs: [...sl.routines, ...jobs()], context: context(), job_deliveries: sl.deliveries(builderModule?.revboxJobDeliveries(routines, { mailboxes: PREVIEW_MAILBOXES }) ?? []),
        slack: sl.slack, people: previewPeople(box), ...previewRunAccounts(box), ...previewBuiltins(box), email_voice_id: emailVoiceId };
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
      // Built-in changes as operations on the box as stored (core patchRevbox, GET-897).
      const { builtin_add: add, builtin_remove: remove } = payload; delete payload.builtin_add; delete payload.builtin_remove;
      if (add || remove) payload.builtin_jobs = applyBuiltinOps(builtinJobsOf(box), { add, remove });
      // A built-in job is in one box per workspace (core patchRevbox, GET-872).
      const added = (payload.builtin_jobs ?? []).filter(k => !builtinJobsOf(box).includes(k));
      const clash = state.boxes.find(b => b.id !== box.id && builtinJobsOf(b).some(k => added.includes(k)));
      if (clash) fail(409, `${REVBOX_BUILTIN_JOBS.find(j => added.includes(j.key) && builtinJobsOf(clash).includes(j.key)).name} is already in the RevBox "${clash.name}".`);
      Object.assign(box, payload, { revision: box.revision + 1, updated_at: stamp() }); output = { box: { ...box, access } };
    } else if (parts[1] === 'members') {
      if (access !== 'owner') fail(403, 'Only the owner can manage members.');
      if (!USERS.some(u => u.id === parts[2]) || box.owner_id === parts[2]) fail(400, 'Choose a workspace member.');
      box.members = box.members.filter(m => m.user_id !== parts[2]);
      if (payload.role) box.members.push({ user_id: parts[2], role: payload.role }); output = { ok: true };
    } else if (parts[1] === 'accounts') {
      const selectedOnly = url.searchParams.get('scope') === 'selected';
      const worked = previewWorkedAccounts(box);
      const accounts = selectedOnly ? worked.accounts.filter(a => a.selected) : worked.accounts;
      output = { accounts, count: accounts.length, accounts_count: accounts.length, accounts_breakdown: worked.breakdown, days: 30, box: { id: box.id, name: box.name, scope: box.scope } };
    } else if (parts[1] === 'graph') {
      // The same accounts the card counts (GET-891); ?source=runs only the run accounts; ?scope=selected the scope.
      const ran = url.searchParams.get('source') === 'runs' ? new Set(previewRunAccounts(box).run_accounts.map(a => a.id)) : null;
      const card = new Set(previewWorkedAccounts(box).accounts.filter(a => url.searchParams.get('scope') !== 'selected' || a.selected).map(a => a.id));
      const accounts = previewRevboxAccounts.filter(a => ran ? ran.has(a.id) : card.has(a.id)); const ids = new Set(accounts.map(a => a.id));
      const people = CONTACTS.filter(p => ids.has(p.company_id)); const deals = DEALS.filter(d => ids.has(d.company_id));
      output = { nodes: [...accounts.map(a => ({ id: a.id, label: a.name, type: 'account', icp: a.icp_score })), ...people.map(p => ({ id: p.id, label: `${p.first_name} ${p.last_name}`, type: 'person' })), ...deals.map(d => ({ id: d.id, label: d.name, type: 'deal' }))], edges: [...people.map(p => ({ s: p.id, t: p.company_id, type: 'works_at' })), ...deals.map(d => ({ s: d.id, t: d.company_id, type: 'deal_of' }))] };
    } else if (parts[1] === 'context') {
      // GET-875: untag from this box (the file stays in the library); add = a new library file tagged here, or an existing one.
      if (req.method === 'DELETE') { state.links = state.links.filter(l => l.revbox_id !== box.id || l.file_id !== parts[2]); output = { ok: true }; }
      else if (payload.file_id) { const f = state.files.find(x => x.id === payload.file_id); if (!f) fail(404, 'Context file not found.'); if (!state.links.some(l => l.revbox_id === box.id && l.file_id === f.id)) state.links.push({ revbox_id: box.id, file_id: f.id, created_at: stamp() }); output = { context: f }; }
      else { const ref = payload.document_id ? refs.find(r => r.id === payload.document_id) : null; if (payload.document_id && !ref) fail(404, 'Document not found.'); const f = { id: randomUUID(), title: ref?.title ?? payload.title, kind: 'reference', body: ref?.body ?? payload.body, document_id: payload.document_id ?? null, visibility: 'boxes', created_by: uid, created_at: stamp(), updated_at: stamp(), icp_marked_at: null }; state.files.push(f); state.links.push({ revbox_id: box.id, file_id: f.id, created_at: stamp() }); output = { context: f }; }
    } else if (parts[1] === 'plan') {
      const plan = proposeRevboxPlan(payload.prompt, { timezone: payload.timezone, tools: payload.tools });
      for (const slug of plan.tools) { const connection = connections.find(c => c.slug === slug); if (connection) plan.bindings[slug] = connection.id; }
      output = { plan };
    }
    else if (parts[1] === 'results' && parts[3] === 'decide') {
      // A routine run waiting at its approval step (GET-872): approve or deny it.
      const run = state.results.find(r => r.revbox_id === box.id && r.id === parts[2] && r.kind === 'routine');
      if (!run) fail(404, 'Result not found.');
      if (run.state !== 'needs_review') fail(409, 'This run was already decided. Reload to see it.');
      run.state = payload.approve ? 'completed' : 'rejected';
      if (payload.approve) run.deliveries = [{ id: randomUUID(), state: 'sent', error: null, destination: { kind: 'slack', target: '#cs-leadership' } }];
      output = { ok: true, status: payload.approve ? 'ok' : 'rejected' };
    }
    else if (parts[1] === 'results') {if(parts[3]==='approve'){const run=state.results.find(r=>r.revbox_id===box.id&&r.id===parts[2]);if(!run)fail(404,'Result not found.');if(run.state!=='needs_review')fail(409,'This result was already reviewed.');run.state='completed';output={run};}else output={results:state.results.filter(r=>r.revbox_id===box.id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).map(r=>previewRunSlack(r,box))};}
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
  } catch (e) { json(res, { error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status ?? 500); }
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
// - winloss (GET-874): "analyse every closed deal into a table, then monthly and quarterly reports".
//   Reads the box's tables, starts on Deal won + Deal lost (no question), proposes the analysis job
//   with its table (the box's own when it has one) and next_jobs; approving creates the table and
//   answers next_session_id, and that session proposes the monthly report, then the quarterly one.
// Every script emits `integrations` (the tools it settled on) so the composer attaches them. Any
// later message revises the proposal. Each session keeps `log`, the chat as the server's history
// items. Clicking a job (POST /:id/builder { job_id }, no message) opens the person's own chat on it
// (GET-889), as core openBuilderSessionForJob does: their open session on the job is reused as it
// is, every turn in `history`; with none open, a new one is seeded from the job's last approved chat
// (or its current setup), and THAT one is reused next time. Answered as JSON { session_id, job_id,
// history, proposal }. A message with "fail" in it (e.g. "simulate a failure") plays a provider
// error: the message is kept, reopening shows it as failed, and Try again ({ retry: true }) answers
// it. Sessions persist with the state file, so a job's chat survives the fake API restarting.
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
// What starts the job, asked when the words name no start and no signal was picked (GET-892): the
// real builder never defaults it. The fitting starts from the catalog, the pick first, plus "Something else".
const TRIGGER_QUESTION = { id: 'start', header: 'Starts', question: 'What should start this job?', multi: false, options: [
  { label: 'Every weekday morning (Recommended)', description: 'On a schedule, before the day starts' },
  { label: 'When a deal is won', description: 'As soon as a deal moves to closed won' },
  { label: 'When a Granola meeting ends', description: 'After every meeting Granola records' },
  { label: 'Something else', description: 'Tell me in your own words' } ] };
/** The signal an answer to TRIGGER_QUESTION picked (the schedule unless it names an event). */
const triggerFromAnswer = (a) => /deal is won/i.test(a ?? '') ? 'deal.won' : /meeting/i.test(a ?? '') ? 'meeting.done:granola' : 'schedule';
/** Words that already say it runs on a schedule. */
const SCHEDULE_WORDS = /\b(daily|weekly|monthly|quarterly|mornings?|weekdays?|every (morning|day|week|monday|tuesday|wednesday|thursday|friday|weekday|month))\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i;
const EVENT_LABEL = { 'deal.won': 'When a deal is won' };
/** An event signal's trigger for the scripted proposals (a meeting recorder, a deal, an account signal). */
function eventTrigger(key) {
  if (key.startsWith('meeting.done')) return meetingTrigger(key);
  const entry = previewCatalog().builtin.concat(previewCatalog().custom).find(e => e.key === key);
  return { signal_key: key, ...(entry?.trigger ?? { kind: 'account_signal', config: {} }), label: EVENT_LABEL[key] ?? `When ${entry?.label ?? key}` };
}
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
  if (/closed deals?|won (and|or) lost|win\/loss|win-loss|(into|to|in) a table|log of (closed|won|lost)/i.test(words)) return 'winloss';
  if (hinted?.startsWith('meeting.done')) return 'meeting';
  if (hinted === 'deal.won') return 'won';
  if (/\bmeetings?\b|\bcalls?\b/i.test(words)) return 'meeting';
  if (/closed[- ]?won|\bdeals? (is |are |gets? )?(won|closes)\b|\bwin a deal\b|\bwe win\b/i.test(words)) return 'won';
  if (hinted === 'schedule' || /\b(daily|weekly|monthly|every (morning|day|week|monday|tuesday|wednesday|thursday|friday|weekday)|report|digest)\b|hubspot/i.test(words)) return 'report';
  return 'other';
}
/** The server's facts (core proposalFacts), restated for the steps this fake proposes. */
function factsFor(steps, tables = new Map()) {
  return steps.map(st => {
    const c = st.config ?? {};
    const base = { step_id: st.id, type: st.type, external: false };
    if (st.type === 'dataset_append' || st.type === 'dataset_read') {
      const t = tables.get(c.dataset_key);
      const named = t ? `the table "${t.name}" (${c.dataset_key}${t.exists ? '' : ', new'})` : `the table ${c.dataset_key}`;
      const fact = { ...base, action: st.type === 'dataset_append' ? 'append' : 'read', dataset_key: c.dataset_key, dataset: t?.name ?? null, new_dataset: !!t && !t.exists };
      return st.type === 'dataset_append' ? { ...fact, dedupe_from: c.dedupe_from ?? 'deal', target: `Add a row to ${named}, one per deal` } : { ...fact, window: c.window ?? 'all', target: `Read ${named}: ${String(c.window ?? 'all').replace(/_/g, ' ')}` };
    }
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
  const trigger = s.signal && s.signal !== 'schedule'
    ? eventTrigger(s.signal)
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
    assumptions: [...(trigger.kind === 'clock' ? ['Runs on Monday morning; say another time to change it.'] : []), ...(s.changes ?? [])],
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
    summary: `${s.signal && s.signal !== 'schedule' ? eventTrigger(s.signal).label : `${weekdays ? 'Every weekday' : 'Every morning'} at ${at} Toronto time`}: read yesterday's Credit Check numbers per dealer from HubSpot, write the VP summary, post it to ${channel}.`,
    // An event the user picked when asked what starts it (GET-892), else the schedule.
    trigger: s.signal && s.signal !== 'schedule' ? eventTrigger(s.signal) : { signal_key: 'schedule', kind: 'clock', config: { frequency: 'daily', at, ...(weekdays ? { weekdays_only: true } : {}) }, timezone: 'America/Toronto', label },
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
// The closed won/lost analysis (GET-874): the table its jobs share, the analysis job, the two reports.
const WIN_LOSS_TABLE = { key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per deal won or lost, analysed against the ICP.', columns: [
  { key: 'deal', label: 'Deal', type: 'text' }, { key: 'outcome', label: 'Outcome', type: 'enum', options: ['Won', 'Lost'] }, { key: 'value', label: 'Value', type: 'number' },
  { key: 'close_date', label: 'Close date', type: 'date' }, { key: 'icp_fit', label: 'ICP fit', type: 'enum', options: ['Strong', 'Partial', 'Poor'] },
  { key: 'primary_reason', label: 'Primary reason', type: 'text' }, { key: 'competitor', label: 'Competitor', type: 'text' },
] };
const WIN_LOSS_REPORTS = [
  { name: 'Monthly win/loss report', frequency: 'monthly', window: 'last_month', label: 'On the first of the month at 08:00 (UTC)', prompt: 'Write the monthly win/loss report from {{steps.rows.output}}: win rate, value won and lost, ICP fit of wins vs losses, the top reasons and competitors, and what to change.' },
  { name: 'Quarterly win/loss review', frequency: 'quarterly', window: 'last_quarter', label: 'At the start of each quarter at 08:00 (UTC)', prompt: 'Write the quarterly win/loss review from {{steps.rows.output}}: trends month over month, the patterns behind wins and losses, and three recommendations.' },
];
const boxTables = (boxId) => state.datasets.filter(d => d.revbox_id === boxId);
const tableMap = (boxId, proposed = []) => new Map([...proposed.map(d => [d.key, { name: d.name, exists: false }]), ...boxTables(boxId).map(d => [d.key, { name: d.name, exists: true }])]);
function winLossProposal(s) {
  const has = boxTables(s.box).some(d => d.key === WIN_LOSS_TABLE.key);
  const datasets = has ? [] : [WIN_LOSS_TABLE];
  const steps = [
    { id: 'analyse', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Analyse this closed deal against our ICP (the box context): the fit, the one primary reason it was won or lost, and the competitor if one was in the deal.' } },
    { id: 'row', type: 'dataset_append', config: { dataset_key: WIN_LOSS_TABLE.key, dedupe_from: 'deal' } },
  ];
  return {
    name: s.name ?? 'Analyse closed deals',
    summary: `When a deal is won or lost: analyse it against the ICP and add one row to ${WIN_LOSS_TABLE.name}${has ? '' : ' (a new table)'}.`,
    trigger: { signal_key: 'deal.won', signal_keys: ['deal.won', 'deal.lost'], kind: 'deal_closed_won', config: { also: [{ kind: 'deal_closed_lost', config: {} }] }, label: 'When a deal is won or lost' },
    ...(datasets.length ? { datasets } : {}),
    steps, facts: factsFor(steps, tableMap(s.box, datasets)),
    display: [
      { step_id: 'analyse', tool: 'ai', title: 'Analyse the deal against the ICP', detail: 'Fit, primary reason, competitor' },
      { step_id: 'row', tool: 'dataset_append', title: `Add a row to ${WIN_LOSS_TABLE.name}` },
    ],
    uses_box_delivery: false, warnings: [],
    assumptions: ['A deal that closes twice (won, then lost) gets a row for each outcome.', ...(s.changes ?? [])],
    ...(s.wantsReports ? { next_jobs: WIN_LOSS_REPORTS.map(r => r.name) } : {}),
    estimated_credits_per_run: 1,
  };
}
function winLossReportProposal(s) {
  const r = WIN_LOSS_REPORTS[s.report ?? 0];
  const steps = [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: WIN_LOSS_TABLE.key, window: r.window, limit: 500 } },
    { id: 'report', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: r.prompt } },
  ];
  const later = WIN_LOSS_REPORTS.slice((s.report ?? 0) + 1).map(x => x.name);
  return {
    name: s.name ?? r.name,
    summary: `${r.label}: read ${r.window === 'last_month' ? 'last month’s' : 'last quarter’s'} rows from ${WIN_LOSS_TABLE.name}, write the ${r.frequency === 'monthly' ? 'report' : 'review'}, and send it to the box’s destinations.`,
    trigger: { signal_key: 'schedule', kind: 'clock', config: { frequency: r.frequency, at: '08:00' }, timezone: 'UTC', label: r.label },
    steps, facts: factsFor(steps, tableMap(s.box)),
    display: [
      { step_id: 'rows', tool: 'dataset_read', title: `Read ${WIN_LOSS_TABLE.name}` },
      { step_id: 'report', tool: 'ai', title: `Write the ${r.frequency} ${r.frequency === 'monthly' ? 'report' : 'review'}` },
    ],
    uses_box_delivery: true, box_delivery_format: 'report', warnings: [], assumptions: [...(s.changes ?? [])],
    ...(later.length ? { next_jobs: later } : {}),
    estimated_credits_per_run: 2,
  };
}
/** A proposal with the server's brief (core jobBrief), as propose_job and Edit hand it out. */
const withBrief = (p) => (p ? { ...p, brief: jobBrief(p, p.facts) } : p);
function proposalFor(s) { return withBrief(scriptedProposal(s)); }
function scriptedProposal(s) {
  if (s.script === 'winloss') return winLossProposal(s);
  if (s.script === 'winloss_report') return winLossReportProposal(s);
  if (s.script === 'meeting') return meetingProposal(s);
  if (s.script === 'won') return wonProposal(s);
  if (s.script === 'other') return otherProposal(s);
  return reportProposal(s);
}
function integrationsFor(s) {
  if (s.script === 'winloss' || s.script === 'winloss_report') return [];
  if (s.script === 'meeting') return [s.signal?.split(':')[1] ?? 'granola', 'gmail', 'slack'];
  if (s.script === 'won') return ['hubspot', 'slack'];
  if (s.script === 'other') { const o = String(s.answers?.output ?? ''); return /slack/i.test(o) ? ['slack'] : /gmail|email/i.test(o) ? ['gmail'] : []; }
  return ['hubspot', 'slack', ...(s.emailVp ? ['gmail'] : [])];
}
/** A session's chat as the server's history items: proposals with their brief, a failed last turn marked. */
function historyOf(s) {
  const items = (s.log ?? []).map(i => (i.kind === 'proposal' ? { ...i, proposal: withBrief(i.proposal) } : i));
  return s.failed ? [...items, { kind: 'failed', text: 'This message did not get an answer. Try again.' }] : items;
}
async function builderPreview(req, res, json, box, parts, payload, uid) {
  const sid = parts[2];
  if (sid && parts[3] === 'approve') {
    const s = sessions.get(sid);
    if (!s || s.box !== box.id || !s.proposal) { json(res, { error: 'Nothing to approve in this session.' }, 404); return; }
    if (s.state === 'approved') { json(res, { error: 'This proposal was already approved.' }, 409); return; }
    const p = withBrief({ ...s.proposal, name: payload.name?.trim() || s.proposal.name });
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
    // GET-874: the proposed tables are created first (a key the box has is reused, never changed).
    const tables = (p.datasets ?? []).map(d => {
      const had = boxTables(box.id).find(t => t.key === d.key);
      if (had) return { key: had.key, name: had.name, created: false };
      state.datasets.push({ id: randomUUID(), revbox_id: box.id, key: d.key, name: d.name, description: d.description ?? '', columns: normalizeDatasetColumns(d.columns).columns, created_by: uid, created_at: stamp(), updated_at: stamp() });
      return { key: d.key, name: d.name, created: true };
    });
    // Chaining: the chat goes on in a new session that proposes the next job.
    let chain = {};
    if (p.next_jobs?.length) {
      const report = s.script === 'winloss_report' ? (s.report ?? 0) + 1 : 0;
      const nextSession = { id: randomUUID(), box: box.id, job_id: null, user: uid, state: 'open', stage: 0, script: 'winloss_report', report, request: s.request, chained: true, log: structuredClone(s.log) };
      sessions.set(nextSession.id, nextSession);
      chain = { next_session_id: nextSession.id, next_jobs: p.next_jobs };
    }
    await persist(); json(res, { routine, enabled: !reason, ...(reason ? { reason } : {}), ...(tables.length ? { datasets: tables } : {}), ...chain }); return;
  }
  // A built-in job's chat (GET-902): the person's open chat on it in this box, reused; else a new one
  // whose first item is its card. Never a routine: approving a proposal here creates a new job.
  if (!sid && payload.builtin && payload.message === undefined && payload.answers === undefined) {
    if (!builtinJobsOf(box).includes(payload.builtin)) { json(res, { error: 'This built-in job is not in this RevBox.' }, 404); return; }
    const open = Object.values(state.builder_sessions).find(x => x.box === box.id && x.builtin === payload.builtin && x.user === uid && x.state === 'open');
    const chat = open ?? { id: randomUUID(), box: box.id, job_id: null, builtin: payload.builtin, user: uid, state: 'open', stage: 0, log: [{ kind: 'builtin', key: payload.builtin }], updated_at: stamp() };
    if (!open) { sessions.set(chat.id, chat); await persist(); }
    json(res, { session_id: chat.id, builtin: chat.builtin, history: historyOf(chat) }, 201); return;
  }
  // Open a job's chat: the person's open session on it, reused; else a new one seeded from its last approved chat.
  if (!sid && payload.job_id && payload.message === undefined && payload.answers === undefined) {
    const job = state.routines.find(r => r.revbox_id === box.id && r.id === payload.job_id);
    if (!job) { json(res, { error: 'Job not found.' }, 404); return; }
    const mine = Object.values(state.builder_sessions).filter(x => x.box === box.id && x.job_id === job.id && x.user === uid && x.state === 'open' && x.log?.length)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))[0];
    if (mine) { json(res, { session_id: mine.id, job_id: job.id, history: historyOf(mine), proposal: mine.proposal ? withBrief(mine.proposal) : null }, 201); return; }
    const source = Object.values(state.builder_sessions).filter(x => x.box === box.id && x.job_id === job.id && x.state === 'approved')
      .sort((a, b) => String(b.approved_at ?? '').localeCompare(String(a.approved_at ?? '')))[0];
    const fresh = { id: randomUUID(), box: box.id, job_id: job.id, user: uid, state: 'open', stage: source ? 2 : 0, script: source?.script, request: source?.request, channel: source?.channel, format: source?.format, questions: source?.questions, answers: source?.answers, emailVp: source?.emailVp, signal: source?.signal, changes: source?.changes, name: source?.proposal?.name, proposal: source?.proposal ?? null, log: structuredClone(source?.log ?? []) };
    // No chat made it (a seeded job): it opens on its current setup as an approved card, with no
    // line about where it was set up (GET-884), as core openBuilderSessionForJob does.
    if (!source && jobProposalModule) {
      const current = jobProposalModule.proposalFromRoutine(job);
      fresh.proposal = { ...current, facts: factsFor(current.steps, tableMap(box.id)) };
      fresh.log = [{ kind: 'proposal', proposal: fresh.proposal, approved: true }];
      fresh.stage = 2; fresh.script = job.steps?.some(x => x.type === 'dataset_append') ? 'winloss' : 'report';
    }
    fresh.updated_at = stamp();
    sessions.set(fresh.id, fresh); await persist();
    json(res, { session_id: fresh.id, job_id: job.id, history: historyOf(fresh), proposal: withBrief(fresh.proposal) }, 201); return;
  }
  const s = sid ? sessions.get(sid) : { id: randomUUID(), box: box.id, job_id: payload.job_id ?? null, user: uid, state: 'open', stage: 0, log: payload.builtin ? [{ kind: 'builtin', key: payload.builtin }] : [], ...(payload.builtin ? { builtin: payload.builtin } : {}) };
  if (!s || s.box !== box.id) { json(res, { error: 'Builder session not found.' }, 404); return; }
  if (s.state === 'approved') { json(res, { error: 'This builder session is closed. Start a new one.', code: 'session_closed' }, 409); return; }
  if (payload.retry === true && !s.failed) { json(res, { error: 'There is nothing to try again: the last message was answered.', code: 'nothing_to_retry' }, 409); return; }
  // Try again (GET-889): the message that got no answer runs again; it is already in the log.
  const message = payload.retry === true ? s.failedText : payload.message;
  const retrying = payload.retry === true;
  s.failed = false;
  s.log ??= [];
  // Sessions from before the scripts were all the report script.
  s.script ??= s.stage > 0 ? 'report' : undefined;
  // The chat as Edit shows it later: the user's words (answers fill the open ask), prose, asks, proposals.
  if (payload.answers) {
    const ask = [...s.log].reverse().find(i => i.kind === 'ask');
    const asked = s.questions ?? REPORT_QUESTIONS;
    if (ask) ask.answers = payload.answers.map(a => ({ question: asked.find(q => q.id === a.id)?.question ?? a.id, answer: [...(a.selected ?? []), ...(a.other ? [`Other: ${a.other}`] : [])].join('; ') }));
  } else if (message && !retrying) s.log.push({ role: 'user', text: message });
  s.updated_at = stamp();
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
  // A provider failure, played: the message stays in the chat with no answer.
  if (!retrying && /\bfail(ure)?\b/i.test(message ?? '')) {
    await send({ type: 'status', text: 'Thinking…' }, 400);
    s.failed = true; s.failedText = message; await persist();
    await send({ type: 'error', code: 'model_busy', message: "The job builder's AI model is busy right now. Try again in a moment." }, 600);
    await send({ type: 'done' }); res.end(); return;
  }
  // What starts the job: the composer's pick wins; otherwise "meeting" in the words means a meeting
  // signal (Granola when named), anything else a schedule. Emitted as the real builder does.
  // hints.signals (GET-873; the preview plays the first), or an older composer's hints.signal.
  const hinted = payload.hints?.signals?.length ? payload.hints.signals[0] : payload.hints && 'signal' in payload.hints ? payload.hints.signal : null;
  let words = message ?? '';
  // A built-in's chat (GET-902), scripted: it explains the built-in, rewrites its email voice, switches
  // the follow-up on or off, and offers a custom job for what it cannot do (then builds it as usual).
  if (s.builtin && !s.building) {
    const def = REVBOX_BUILTIN_JOBS.find(j => j.key === s.builtin);
    const brief = builtinJobBrief(s.builtin, PREVIEW_BUILTIN_FACTS);
    const builtinTool = async (status, summary) => tool(status, 'builtin_job', summary);
    if (s.offered && /^\s*(yes|yep|sure|ok(ay)?|please|do it|go ahead)\b/i.test(words)) {
      // They want the custom job: built the normal way, from what they asked for.
      s.building = true; s.offered = false; words = s.offerRequest ?? words;
    } else if (/concise|shorter|formal|relaxed|casual|friendl|warm|tone|voice|wordy|longer/i.test(words)) {
      const shown = boxFiles(box.id).find(isEmailVoiceFile);
      const file = shown ? state.files.find(f => f.id === shown.id) : null;
      await builtinTool('Reading this built-in job…', `${def.name}: ${previewBuiltinOn(s.builtin) ? 'on' : 'off'}`);
      if (!file) { await prose(`${def.name} drafts no email here, so it has no email voice to change.`); }
      else {
        const asks = [/concise|shorter|wordy/i.test(words) && 'Keep it short: at most 80 words, two short paragraphs.', /formal/i.test(words) && 'Formal and polite; no slang, no exclamation marks.', /relaxed|casual|friendl|warm/i.test(words) && 'Relaxed and friendly, like a note to a colleague.', /longer/i.test(words) && 'A little more detail is fine: up to 150 words.'].filter(Boolean);
        file.body = `${file.body.trim()}\n\nChanged ${new Date().toISOString().slice(0, 10)}:\n${(asks.length ? asks : [`As asked: ${words.trim()}`]).map(x => `- ${x}`).join('\n')}`;
        file.updated_at = stamp();
        await builtinTool('Updating the email voice…', 'Email voice updated');
        await send({ type: 'builtin', key: s.builtin, email_voice: true }, 60);
        await prose(`Done. New ${def.name.toLowerCase()} drafts follow the updated Email voice (${asks.length ? asks.join(' ').toLowerCase() : 'as you asked'}). Drafts already in Priorities stay as they are; the voice is in this box's Context if you want to read or edit it.`);
      }
    } else if (/\b(switch|turn) (it )?(off|on)\b|\bpause\b|\bstop\b|\bresume\b/i.test(words)) {
      const on = /\b(on|resume)\b/i.test(words) && !/\boff\b/i.test(words);
      if (s.builtin !== 'sales_follow_up') await prose(`OpenNous switches ${def.name} on or off for the whole workspace, so I can't do it here. Ask OpenNous and it is done the same day.`);
      else {
        await builtinTool(`Switching it ${on ? 'on' : 'off'}…`, `Switched ${on ? 'on' : 'off'}`);
        state.follow_up_off = !on;
        await send({ type: 'builtin', key: s.builtin, enabled: on }, 60);
        await prose(on ? `${def.name} is on again: after the next meeting, its card waits in Priorities.` : `${def.name} is off for the whole workspace. What it already drafted stays in Priorities.`);
      }
    } else if (/slack|post|report|hubspot|notion|send it|webhook|summar/i.test(words)) {
      s.offered = true; s.offerRequest = words;
      await prose(`${def.name} can't do that: it only drafts ${s.builtin === 'sales_follow_up' ? 'the follow-up, its tasks and CRM updates' : 'a follow-up email'} for you to approve in Priorities. I can set up a custom job in this box that does it, alongside ${def.name}. Want me to?`);
    } else {
      await builtinTool('Reading this built-in job…', `${def.name}: ${previewBuiltinOn(s.builtin) ? 'on' : 'off'}`);
      await prose(`${brief.text} ${brief.details.join(' ')} You can ask me to change its email voice${s.builtin === 'sales_follow_up' ? ', switch it off or on' : ''}, or to set up a custom job in this box for something it does not do.`);
    }
    if (!s.building) { s.updated_at = stamp(); await persist(); await send({ type: 'done' }); res.end(); return; }
  }
  const meant = /\bmeetings?\b|\bcalls?\b/i.test(words) ? (/fireflies/i.test(words) ? 'meeting.done:fireflies' : /fathom/i.test(words) ? 'meeting.done:fathom' : 'meeting.done:granola') : null;
  const announceTrigger = async (key) => {
    s.signal = key;
    const entry = key ? previewCatalog().builtin.concat(previewCatalog().custom).find(e => e.key === key.split(':')[0]) : null;
    const provider = key?.split(':')[1];
    const label = !key || key === 'schedule' ? 'On a schedule' : `${entry?.label ?? key}${provider ? ` · ${PROVIDER_NAME[provider] ?? provider}` : ''}`;
    await send({ type: 'trigger', signal: key === 'schedule' ? 'schedule' : key, signals: key ? [key] : [], label }, 150);
  };
  const attached = payload.hints?.integrations?.length ? ` · you attached ${payload.hints.integrations.join(', ')}` : '';
  const tablesTool = async () => {
    const mine = boxTables(box.id);
    const count = (d) => state.dataset_rows.filter(r => r.dataset_id === d.id).length;
    await tool('Reading this box’s tables…', 'revbox_datasets', mine.length ? `${mine.length} ${mine.length === 1 ? 'table' : 'tables'}: ${mine.slice(0, 3).map(d => `${d.name} (${count(d)} rows)`).join(', ')}` : 'No tables yet');
  };
  if (s.stage === 0 && s.chained) {
    // The chat after an approval (GET-874): the next report on the table the first job fills.
    const r = WIN_LOSS_REPORTS[s.report ?? 0];
    await tablesTool();
    await announceTrigger('schedule');
    await prose(`Next, the ${r.frequency} ${r.frequency === 'monthly' ? 'report' : 'review'}: on a schedule, reading ${WIN_LOSS_TABLE.name} and sending the result to this box’s destinations.`);
    await propose();
  } else if (s.stage === 0) {
    s.script = scriptFor(words, hinted);
    s.request = words;
    await tool('Reading this box’s context…', 'revbox_context', `Read ${box.name} · ${box.blocks.length} context blocks`);
    if (s.script === 'winloss') {
      s.wantsReports = /monthly|quarterly|reports?/i.test(words);
      await tablesTool();
      // Deal won + deal lost: an event job, so no time question.
      s.signal = 'deal.won';
      await send({ type: 'trigger', signal: 'deal.won', signals: ['deal.won', 'deal.lost'], label: 'When a deal is won or lost' }, 150);
      const has = boxTables(box.id).some(d => d.key === WIN_LOSS_TABLE.key);
      await prose(`Every time a deal is won or lost, I’ll analyse it against the ICP in this box’s context and add a row to ${WIN_LOSS_TABLE.name}${has ? '' : ', a new table'}.${s.wantsReports ? ' The monthly report and the quarterly review follow after you approve this one.' : ''}`);
      await propose();
    } else if (s.script === 'meeting') {
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
      // No pick and no schedule in the words: the start is asked with the rest, never defaulted (GET-892).
      s.askStart = !hinted && !SCHEDULE_WORDS.test(words);
      if (!s.askStart) await announceTrigger(hinted && !hinted.startsWith('meeting.done') && hinted !== 'deal.won' ? hinted : 'schedule');
      await tool('Looking for Credit Check in HubSpot…', 'hubspot_find', 'Found Company Daily Stats · 5 Credit Check fields');
      await tool('Previewing yesterday’s numbers…', 'hubspot_preview', 'Yesterday: 42 dealers with Credit Check activity');
      await settleIntegrations();
      // The time is asked only when the words did not give one.
      const at = timeIn(words);
      if (at) s.answers = { ...(s.answers ?? {}), time: `${at} Toronto${/weekday/i.test(words) ? ', weekdays only' : ''}` };
      const questions = [...(s.askStart ? [TRIGGER_QUESTION] : []), ...REPORT_QUESTIONS.filter(q => q.id !== 'time' || (!at && !s.askStart))];
      await prose(`The numbers live in the HubSpot custom object Company Daily Stats, and yesterday has real data for 42 dealers. ${questions.length === 3 ? 'Three' : 'Two'} things I can’t work out on my own:`);
      await ask(questions);
    } else {
      await tool('Checking connected tools…', 'workspace_connections', `HubSpot, Slack, Gmail and Granola are connected${attached}`);
      if (hinted) await announceTrigger(hinted);
      await prose(hinted ? 'I can set that up. One thing first:' : 'I can set that up. Two things first:');
      await ask([...(hinted ? [] : [TRIGGER_QUESTION]), ...OTHER_QUESTIONS]);
    }
  } else if (s.stage === 1 && payload.answers) {
    const picked = Object.fromEntries(payload.answers.map(a => [a.id, [...(a.selected ?? []), ...(a.other ? [a.other] : [])].join(', ')]));
    s.answers = { ...(s.answers ?? {}), ...picked };
    // The answer to "What should start this job?" settles the trigger (GET-892).
    if (picked.start) {
      const key = triggerFromAnswer(picked.start);
      if (key === 'schedule' && /weekday/i.test(picked.start)) s.answers.time = '08:00 Toronto, weekdays only';
      await announceTrigger(key);
    }
    if (s.script === 'meeting') {
      // A channel the fake does not know falls back to the box's own, as the real one would ask again.
      s.channel = namedChannel(picked.channel) ?? 'cs-handoffs';
      await tool('Resolving the Slack channel…', 'slack_channels', `#${s.channel} · ${channelId(s.channel) ?? 'C07CSHANDOFFS'}`);
      await prose('Here’s the job:');
      await propose();
    } else if (s.script === 'other') {
      await settleIntegrations();
      await prose('Here’s the job:');
      await propose();
    } else {
      await tool('Resolving the Slack channel…', 'slack_channels', `${unrec(s.answers.channel || '#credit-check-cs-handoff')} · C07TU1HANDOFF`);
      await tool('Checking what the HubSpot connection can read…', 'hubspot_access', 'Companies and deals readable · custom objects not granted');
      await prose('Here’s the job. One thing to fix before it can run reliably:');
      await propose();
    }
  } else {
    const text = message ?? '';
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
