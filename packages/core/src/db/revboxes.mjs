import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount } from '../services/revboxPlan.mjs';
import { revboxContextRows, addBoxContext, unlinkContext } from './contextLibrary.mjs';
import { accountNamesInText, resolveAccountNames, normalizeAccountName } from './accountNames.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const now = () => new Date().toISOString();
const clean = (s, n) => typeof s === 'string' ? s.trim().slice(0, n) : '';

export function revboxAccess(box, userId, members) {
  if (!box || !userId) return null;
  if (box.owner_id === userId) return 'owner';
  return members.find(m => m.user_id === userId)?.role ?? (box.shared ? 'viewer' : null);
}

export async function revboxMembership(sb, ws, uid) {
  if (!ws || !uid) fail(401, 'Sign in to continue.');
  const member = await one(sb.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', uid).maybeSingle());
  if (!member) fail(403, 'You are not a member of this workspace.');
}

export async function loadRevbox(sb, ws, uid, id, edit = false) {
  await revboxMembership(sb, ws, uid);
  const box = await one(sb.from('revboxes').select('*').eq('workspace_id', ws).eq('id', id).maybeSingle());
  if (!box) fail(404, 'RevBox not found.');
  const members = await rows(sb.from('revbox_members').select('user_id, role').eq('workspace_id', ws).eq('revbox_id', id));
  const access = revboxAccess(box, uid, members);
  if (!access) fail(404, 'RevBox not found.');
  if (edit && access === 'viewer') fail(403, 'Only an owner or editor can change this RevBox.');
  return { ...box, members, access };
}

export async function listRevboxes(sb, ws, uid) {
  await revboxMembership(sb, ws, uid);
  const boxes = await rows(sb.from('revboxes').select('*').eq('workspace_id', ws).order('updated_at', { ascending: false }).limit(500));
  const memberships = await rows(sb.from('revbox_members').select('revbox_id, user_id, role').eq('workspace_id', ws).eq('user_id', uid));
  return boxes.filter(b => revboxAccess(b, uid, memberships.filter(m => m.revbox_id === b.id))).map(b => ({ ...b, access: revboxAccess(b, uid, memberships.filter(m => m.revbox_id === b.id)) }));
}

export async function createRevbox(sb, ws, uid) {
  await revboxMembership(sb, ws, uid);
  return one(sb.from('revboxes').insert({ workspace_id: ws, owner_id: uid }).select('*').single());
}

/** Box delivery kinds (GET-868: email and Gmail draft next to Slack and webhooks). */
export const DELIVERY_KINDS = ['slack', 'email', 'gmail', 'webhook'];
const MAX_DELIVERY_RECIPIENTS = 20;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** A destination's recipients: a comma/semicolon-separated string or a list, trimmed. Pure. */
export const deliveryRecipients = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map(x => String(x).trim()).filter(Boolean);
/**
 * Recipients are stored as one "a@x, b@y" string, whichever way they came in. Both mail kinds carry
 * `to` and `cc` (GET-868); an email destination's `target` mirrors its `to` (older readers use it).
 */
const joined = (v) => deliveryRecipients(v).join(', ');
const storedDelivery = (list) => list.map(d => d.kind === 'email' ? { ...d, target: joined(d.to ?? d.target), to: joined(d.to ?? d.target), cc: joined(d.cc) }
  : d.kind === 'gmail' ? { ...d, to: joined(d.to), cc: joined(d.cc) } : d);

export function validateRevboxPatch(body) {
  const keys = ['name', 'objective', 'shared', 'scope', 'blocks', 'delivery', 'builtin_jobs', 'revision'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) return 'Unsupported RevBox field.';
  if (!Number.isInteger(body.revision) || body.revision < 1) return 'A saved revision is required.';
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120)) return 'Choose a name of up to 120 characters.';
  if ('objective' in body && (typeof body.objective !== 'string' || body.objective.length > 4000)) return 'The objective is too long.';
  if ('shared' in body && typeof body.shared !== 'boolean') return 'Shared must be a boolean.';
  if (body.scope && (!['all', 'selected', 'won', 'lost', 'icp'].includes(body.scope.mode) || !Array.isArray(body.scope.account_ids) || body.scope.account_ids.length > 1000 || body.scope.account_ids.some(id => typeof id !== 'string') || !Number.isFinite(body.scope.min_icp) || body.scope.min_icp < 0 || body.scope.min_icp > 100)) return 'Choose a valid account scope.';
  if ('scope' in body && (!body.scope || typeof body.scope !== 'object')) return 'Choose a valid account scope.';
  if ('blocks' in body && (!Array.isArray(body.blocks) || body.blocks.length > 30 || body.blocks.some(b => !b || typeof b.id !== 'string' || typeof b.title !== 'string' || typeof b.body !== 'string' || b.title.length > 100 || b.body.length > 12000))) return 'Context blocks are invalid or too large.';
  if ('delivery' in body && (!Array.isArray(body.delivery) || body.delivery.length > 10 || body.delivery.some(d => !d || typeof d.id !== 'string' || !DELIVERY_KINDS.includes(d.kind) || !(typeof d.target === 'string' || (d.kind === 'email' && Array.isArray(d.target))) || String(d.target).length > 500 || (d.kind === 'webhook' && d.target && !/^https:\/\//.test(d.target))))) return 'Choose valid Slack channels, email recipients, Gmail mailboxes or HTTPS webhook destinations.';
  // Email goes from OpenNous to `to` (or, from older clients, `target`); a Gmail draft is made in
  // mailbox `target` (an id the API checks is the saver's own) for `to`. Both may Cc `cc` (GET-868).
  // Empty while it is being filled in. A Slack destination is a channel id in `target`, its name in `channel`.
  for (const d of 'delivery' in body ? body.delivery : []) {
    if (d.kind === 'slack' && d.channel != null && (typeof d.channel !== 'string' || d.channel.length > 200)) return 'Choose a valid Slack channel.';
    // The Block Kit layout a box's Slack destination posts in (GET-858); none = plain text.
    if (d.kind === 'slack' && d.format != null && !['report', 'approval', 'alert', 'handoff', 'notification', 'digest', 'plain'].includes(d.format)) return 'Choose a valid Slack layout.';
    if (d.kind !== 'email' && d.kind !== 'gmail') continue;
    const lists = [d.kind === 'email' ? (d.to ?? d.target) : d.to, d.cc];
    if (lists.some(raw => raw != null && typeof raw !== 'string' && !(Array.isArray(raw) && raw.every(x => typeof x === 'string')))) return 'Recipients must be a list of email addresses.';
    if (lists.some(raw => String(raw ?? '').length > 2000)) return 'That recipient list is too long.';
    const all = lists.flatMap(deliveryRecipients);
    if (all.length > MAX_DELIVERY_RECIPIENTS) return `A destination emails up to ${MAX_DELIVERY_RECIPIENTS} people.`;
    const bad = all.find(a => !EMAIL.test(a));
    if (bad) return `"${bad.slice(0, 80)}" is not an email address.`;
  }
  if ('builtin_jobs' in body && (!Array.isArray(body.builtin_jobs) || body.builtin_jobs.some(k => !REVBOX_BUILTIN_KEYS.includes(k)) || new Set(body.builtin_jobs).size !== body.builtin_jobs.length)) return 'Choose known built-in jobs.';
  if (JSON.stringify(body).length > 300000) return 'RevBox configuration is too large.';
  return null;
}

export async function patchRevbox(sb, ws, uid, id, body) {
  const error = validateRevboxPatch(body); if (error) fail(400, error);
  const box = await loadRevbox(sb, ws, uid, id, true);
  if ('shared' in body && box.access !== 'owner') fail(403, 'Only the owner can change sharing.');
  const { revision, ...patch } = body;
  if (patch.delivery) patch.delivery = storedDelivery(patch.delivery);
  // A built-in job is listed in one box per workspace (GET-872): adding one another box has is a 409.
  const added = (patch.builtin_jobs ?? []).filter(k => !builtinJobsOf(box).includes(k));
  if (added.length) {
    const clash = (await revboxBuiltinTaken(sb, ws, uid, id)).find(t => added.includes(t.key));
    if (clash) fail(409, `${REVBOX_BUILTIN_JOBS.find(j => j.key === clash.key).name} is already in ${clash.box_name ? `the RevBox "${clash.box_name}"` : 'another RevBox'}. Remove it there first.`);
  }
  const updated = await one(sb.from('revboxes').update({ ...patch, ...(patch.name ? { name: patch.name.trim() } : {}), revision: revision + 1, updated_at: now() }).eq('workspace_id', ws).eq('id', id).eq('revision', revision).select('*').maybeSingle());
  if (!updated) fail(409, 'This RevBox changed. Reload before saving.');
  return { ...updated, members: box.members, access: box.access };
}

export async function setRevboxMember(sb, ws, uid, id, memberId, role) {
  const box = await loadRevbox(sb, ws, uid, id, true);
  if (box.access !== 'owner') fail(403, 'Only the owner can manage members.');
  if (memberId === box.owner_id) fail(400, 'The creator remains the owner.');
  await revboxMembership(sb, ws, memberId);
  if (role == null) await rows(sb.from('revbox_members').delete().eq('workspace_id', ws).eq('revbox_id', id).eq('user_id', memberId));
  else { if (!['editor', 'viewer'].includes(role)) fail(400, 'Choose editor or viewer.'); await rows(sb.from('revbox_members').upsert({ workspace_id: ws, revbox_id: id, user_id: memberId, role }, { onConflict: 'revbox_id,user_id' })); }
  await touch(sb, ws, id);
}

async function touch(sb, ws, id) { await rows(sb.from('revboxes').update({ updated_at: now() }).eq('workspace_id', ws).eq('id', id)); }
export async function revboxDetails(sb, ws, uid, id) {
  const box = await loadRevbox(sb, ws, uid, id);
  const [context, jobs, people] = await Promise.all([
    // The files tagged to this box in the workspace context library (GET-875), plus legacy rows.
    revboxContextRows(sb, ws, id),
    rows(sb.from('revbox_jobs').select('*').eq('workspace_id', ws).eq('revbox_id', id).order('created_at')),
    revboxPeople(sb, box),
  ]);
  return { box: { ...box, builtin_jobs: builtinJobsOf(box) }, context, jobs, people };
}

/**
 * The box's owner and members as the Owners rail draws them (GET-872): name, email and the profile
 * photo (users.profile_picture_url), owner first. A user row that cannot be read keeps its id and
 * role, so the rail falls back to initials rather than dropping the person.
 */
export async function revboxPeople(sb, box) {
  const list = [{ user_id: box.owner_id, role: 'owner' }, ...(box.members ?? []).filter(m => m.user_id !== box.owner_id)];
  const ids = [...new Set(list.map(m => m.user_id).filter(Boolean))];
  const users = ids.length ? await rows(sb.from('users').select('id, name, email, profile_picture_url').in('id', ids)) : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return list.filter(m => m.user_id).map(m => {
    const u = byId.get(m.user_id);
    return { id: m.user_id, role: m.role, name: u?.name || u?.email?.split('@')[0] || null, email: u?.email ?? null, avatar_url: u?.profile_picture_url || null };
  });
}

/**
 * The accounts a box's jobs actually touched in their recent runs (GET-872, GET-891), most runs
 * first. Read from what the run tables record: a routine run's `entity_id`, the accounts a step
 * resolved and logged (`step_log[].accounts`: a HubSpot read's rows, the names in an AI step's
 * output, recorded since GET-891), its documents (`document_id`, and the AI steps' `document_id` in
 * the step log) with their `subject_entity_id` and `about`/`mentions` links, and a legacy revbox
 * run's `account_ids`. A person or deal counts for its company.
 *
 * Runs from before GET-891 recorded no names. For them, the newest `pastDocs` (30) output documents with
 * no entity links are read and the account names they state in a table, in bold or in the title
 * are resolved now (accountNamesInText + resolveAccountNames: exact normalized names only).
 * Only accounts in `allowed` (null = unrestricted) are returned.
 * -> { accounts: [{ id, name, domain, runs }], runs: runs in the window, linked: any run named an
 *      account, names: { matched, unmatched, ambiguous } (counts, from names resolved on this read) }
 */
export async function revboxRunAccounts(sb, ws, { revboxId, routineIds = [], allowed = null, days = 30, now: at = Date.now(), pastDocs = 30 } = {}) {
  const since = new Date(at - days * 86_400_000).toISOString();
  const runs = [];   // [{ id, entities: Set, docIds: Set, unrecorded: Set(doc ids whose step logged no accounts), at }]
  for (let i = 0; i < routineIds.length; i += 100) {
    const page = await rows(sb.from('agent_routine_runs').select('id, entity_id, document_id, step_log, started_at').eq('workspace_id', ws)
      .in('routine_id', routineIds.slice(i, i + 100)).gte('started_at', since).limit(2000));
    for (const r of page) {
      const run = { id: r.id, entities: new Set([r.entity_id].filter(Boolean)), docIds: new Set([r.document_id].filter(Boolean)), unrecorded: new Set(), at: String(r.started_at ?? '') };
      for (const e of Array.isArray(r.step_log) ? r.step_log : []) {
        if (Array.isArray(e?.accounts)) for (const id of e.accounts) if (typeof id === 'string' && id) run.entities.add(id);
        if (e?.document_id) { run.docIds.add(e.document_id); if (!Array.isArray(e.accounts)) run.unrecorded.add(e.document_id); }
      }
      if (r.document_id && !(Array.isArray(r.step_log) && r.step_log.some(e => Array.isArray(e?.accounts)))) run.unrecorded.add(r.document_id);
      runs.push(run);
    }
  }
  if (revboxId) {
    try {
      const legacy = await rows(sb.from('revbox_runs').select('id, account_ids').eq('workspace_id', ws).eq('revbox_id', revboxId).gte('created_at', since).limit(2000));
      for (const r of legacy) runs.push({ id: r.id, entities: new Set((r.account_ids ?? []).filter(Boolean)), docIds: new Set(), unrecorded: new Set(), at: '' });
    } catch (e) { if (!['42P01', 'PGRST205'].includes(e.code)) throw e; }
  }
  const docIds = [...new Set(runs.flatMap(r => [...r.docIds]))];
  const docEntities = new Map();   // doc id -> entity ids
  const add = (doc, entity) => { if (!doc || !entity) return; if (!docEntities.has(doc)) docEntities.set(doc, new Set()); docEntities.get(doc).add(entity); };
  for (let i = 0; i < docIds.length; i += 200) {
    const chunk = docIds.slice(i, i + 200);
    const [docs, links] = await Promise.all([
      rows(sb.from('documents').select('id, subject_entity_id').eq('workspace_id', ws).in('id', chunk)),
      rows(sb.from('document_links').select('document_id, target_entity_id, kind').eq('workspace_id', ws).in('document_id', chunk).in('kind', ['about', 'mentions'])),
    ]);
    for (const d of docs) add(d.id, d.subject_entity_id);
    for (const l of links) add(l.document_id, l.target_entity_id);
  }
  // The past (GET-891): the newest output documents that name no entity and whose step logged no
  // accounts, read for the account names they state.
  const names = { matched: 0, unmatched: 0, ambiguous: 0 };
  const past = [...new Set(runs.slice().sort((a, b) => b.at.localeCompare(a.at)).flatMap(r => [...r.unrecorded]).filter(d => !docEntities.has(d)))].slice(0, pastDocs);
  if (past.length) {
    const docs = await rows(sb.from('documents').select('id, title, body_md').eq('workspace_id', ws).in('id', past));
    const named = new Map(docs.map(d => [d.id, accountNamesInText(d.body_md, d.title)]));
    const all = [...new Set([...named.values()].flat())];
    if (all.length) {
      const resolved = await resolveAccountNames(sb, ws, all);
      Object.assign(names, { matched: resolved.matched.length, unmatched: resolved.unmatched.length, ambiguous: resolved.ambiguous.length });
      const idOf = new Map(resolved.matched.map(m => [normalizeAccountName(m.name), m.id]));
      for (const [doc, list] of named) for (const n of list) add(doc, idOf.get(normalizeAccountName(n)));
    }
  }
  for (const r of runs) for (const d of r.docIds) for (const e of docEntities.get(d) ?? []) r.entities.add(e);
  const entityIds = [...new Set(runs.flatMap(r => [...r.entities]))];
  // Each entity as its account: an account is itself, a person or deal is its company.
  const entities = await entityRows(sb, ws, entityIds);
  const companyOf = new Map();
  for (const e of entities) { const c = e.kind === 'account' ? e.entity_id : e.company_id; if (c) companyOf.set(e.entity_id, c); }
  const accountIds = [...new Set(companyOf.values())];
  const known = new Map(entities.filter(e => e.kind === 'account').map(e => [e.entity_id, e]));
  const missing = accountIds.filter(id => !known.has(id));
  for (const e of await entityRows(sb, ws, missing)) if (e.kind === 'account') known.set(e.entity_id, e);
  const counts = new Map();
  let linked = false;
  for (const r of runs) {
    const touched = new Set([...r.entities].map(e => companyOf.get(e)).filter(id => id && known.has(id)));
    if (touched.size) linked = true;
    for (const id of touched) if (!allowed || allowed.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const accounts = [...counts].map(([id, n]) => ({ id, name: known.get(id)?.name ?? 'Account', domain: known.get(id)?.domain ?? null, runs: n }))
    .sort((a, b) => b.runs - a.runs || String(a.name).localeCompare(String(b.name)));
  return { accounts, runs: runs.length, linked, names };
}
async function entityRows(sb, ws, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...await rows(sb.from('entity_list_rows').select('entity_id, kind, name, domain, company_id').eq('workspace_id', ws).in('entity_id', ids.slice(i, i + 200))));
  return out;
}

/**
 * OpenNous's built-in jobs (GET-872): the Workspace plan's default automations, which run as
 * OpenNous detectors (and the per-seat after-call follow-up), not as agent_routines rows. A box can
 * list each one, and each one is in at most one box per workspace. Listing it changes nothing about
 * how it runs. `drafts`: where its drafts are recorded, for the "N drafts in 30 days" line: the
 * follow-up engine's `follow_ups` rows, or the detectors' ri_recommendations ledger rows
 * (category 'automation', rec_key 'automation.<detector>', apps/api/src/lib/detectorDrafts.mjs).
 * The frontend mirrors key, name, does and cadence in lib/revboxes.ts.
 */
export const REVBOX_BUILTIN_JOBS = [
  { key: 'sales_follow_up', name: 'Sales follow-up', does: 'After a meeting, the follow-up email is drafted and waiting to send.', cadence: 'After each call', drafts: { table: 'follow_ups' } },
  { key: 'stale_deal', name: 'Stale deal detection', does: 'A deal goes quiet, and a follow-up is drafted for you.', cadence: 'Nightly', drafts: { rec_key: 'automation.stale_deal' } },
  { key: 'deal_signals', name: 'Deal signals', does: 'A call raises an objection, a competitor, a buying signal or a departure, and the right follow-up is drafted for you.', cadence: 'Hourly', drafts: { rec_key: 'automation.deal_signal' } },
  { key: 'deal_risk', name: 'Deal risk detection', does: 'An account turns at-risk, and a follow-up is drafted for you.', cadence: 'Nightly', drafts: { rec_key: 'automation.deal_risk' } },
  { key: 'expansion', name: 'Expansion signals', does: 'An expansion signal shows, and a follow-up is drafted for you.', cadence: 'Nightly', drafts: { rec_key: 'automation.expansion_signal' } },
];
export const REVBOX_BUILTIN_KEYS = REVBOX_BUILTIN_JOBS.map(j => j.key);
/** The box's built-in job keys; a box from before the column (migration not applied) has none. Pure. */
export const builtinJobsOf = (box) => Array.isArray(box?.builtin_jobs) ? box.builtin_jobs.filter(k => REVBOX_BUILTIN_KEYS.includes(k)) : [];
const missingColumn = (e) => ['42703', 'PGRST204'].includes(e?.code) || /builtin_jobs/.test(e?.message ?? '');

/**
 * Which built-in jobs other boxes in the workspace list: [{ key, box_id, box_name }]. The name is
 * null for a box this viewer cannot open. Empty before the migration.
 */
export async function revboxBuiltinTaken(sb, ws, uid, exceptId = null) {
  let boxes;
  try { boxes = await rows(sb.from('revboxes').select('id, name, owner_id, shared, builtin_jobs').eq('workspace_id', ws)); }
  catch (e) { if (missingColumn(e)) return []; throw e; }
  const mine = await rows(sb.from('revbox_members').select('revbox_id, user_id, role').eq('workspace_id', ws).eq('user_id', uid));
  const out = [];
  for (const b of boxes) {
    if (b.id === exceptId) continue;
    const visible = !!revboxAccess(b, uid, mine.filter(m => m.revbox_id === b.id));
    for (const key of builtinJobsOf(b)) out.push({ key, box_id: b.id, box_name: visible ? b.name : null });
  }
  return out;
}

/**
 * What each built-in job produced in the last `days` days: [{ key, drafts, last_at }]. For a viewer
 * with restricted visibility (`allowed`), account-targeted rows outside it are not counted.
 */
export async function revboxBuiltinActivity(sb, ws, keys, { allowed = null, days = 30, now: at = Date.now() } = {}) {
  const since = new Date(at - days * 86_400_000).toISOString();
  const defs = REVBOX_BUILTIN_JOBS.filter(j => keys.includes(j.key));
  return Promise.all(defs.map(async (def) => {
    let list = [];
    if (def.drafts.table === 'follow_ups') {
      list = (await rows(sb.from('follow_ups').select('account_entity_id, created_at').eq('workspace_id', ws).gte('created_at', since).order('created_at', { ascending: false }).limit(5000)))
        .filter(r => !allowed || allowed.has(r.account_entity_id)).map(r => r.created_at);
    } else {
      list = (await rows(sb.from('ri_recommendations').select('target_type, target_id, updated_at').eq('workspace_id', ws).eq('category', 'automation').eq('rec_key', def.drafts.rec_key).gte('updated_at', since).order('updated_at', { ascending: false }).limit(5000)))
        .filter(r => !allowed || r.target_type !== 'account' || allowed.has(r.target_id)).map(r => r.updated_at);
    }
    return { key: def.key, drafts: list.length, last_at: list.length ? list.reduce((a, b) => (String(a) > String(b) ? a : b)) : null };
  }));
}


/** Add context to a box (GET-875): a new library file tagged to it, or { file_id } an existing one. */
export async function addRevboxContext(sb, ws, uid, id, body) {
  const data = await addBoxContext(sb, ws, uid, id, body ?? {});
  await touch(sb, ws, id); return data;
}

/** Untag a file from a box (GET-875). The file stays in the library and on its other boxes. */
export async function removeRevboxContext(sb, ws, uid, id, contextId) {
  await loadRevbox(sb, ws, uid, id, true);
  await unlinkContext(sb, ws, id, contextId);
  await touch(sb, ws, id);
}

export async function saveRevboxJob(sb, ws, uid, id, body, jobId = null) {
  const box = await loadRevbox(sb, ws, uid, id, true);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000) fail(400, 'A job needs a name and instructions.');
  if (!['draft', 'reviewed'].includes(body.state)) fail(400, 'Choose draft or reviewed.');
  const plan = body.plan ?? proposeRevboxPlan(body.prompt);
  const error = validateRevboxPlan(plan); if (error) fail(400, error);
  if (Object.values(plan.bindings ?? {}).some(Boolean)) {
    const connections = await revboxConnections(sb, ws, uid);
    for (const [slug, connectionId] of Object.entries(plan.bindings ?? {})) {
      if (connectionId && !connections.some(c => c.id === connectionId && c.slug === slug)) fail(400, 'A selected tool connection is no longer accessible.');
    }
  }
  if(plan.trigger.signal_id){
    const signal=await one(sb.from('custom_signal_definitions').select('id').eq('workspace_id',ws).eq('id',plan.trigger.signal_id).eq('active',true).maybeSingle());
    if(!signal)fail(400,'Choose an active signal from this workspace.');
  }
  plan.execution_enabled = false;
  const references = (await revboxContextRows(sb, ws, id)).map(r => ({ id: r.id, document_id: r.document_id ?? null }));
  const old = jobId ? await one(sb.from('revbox_jobs').select('*').eq('workspace_id', ws).eq('revbox_id', id).eq('id', jobId).maybeSingle()) : null;
  if (jobId && !old) fail(404, 'Job not found.');
  if (old && body.version !== old.version) fail(409, 'This job changed. Reload before saving.');
  const patch = { enabled: false, next_run_at: null, name: clean(body.name, 120), prompt: body.prompt.trim(), plan, state: body.state, updated_at: now(), version: (old?.version ?? 0) + 1, reviewed_at: body.state === 'reviewed' ? now() : null, reviewed_by: body.state === 'reviewed' ? uid : null, snapshots: [...(old?.snapshots ?? []), ...(body.state === 'reviewed' ? [{ version: (old?.version ?? 0) + 1, plan, objective: box.objective, scope: box.scope, blocks: box.blocks, context_references: references, delivery: box.delivery, reviewed_at: now(), reviewed_by: uid }] : [])].slice(-50) };
  const data = old
    ? await one(sb.from('revbox_jobs').update(patch).eq('workspace_id', ws).eq('revbox_id', id).eq('id', jobId).eq('version', old.version).select('*').maybeSingle())
    : await one(sb.from('revbox_jobs').insert({ ...patch, workspace_id: ws, revbox_id: id, created_by: uid }).select('*').single());
  if (!data) fail(409, 'This job changed. Reload before saving.');
  await touch(sb, ws, id); return data;
}

export async function revboxWorkspaceMembers(sb, ws) {
  return rows(sb.from('workspace_members').select('user_id, role, user:users!workspace_members_user_id_fkey(id, name, email)').eq('workspace_id', ws));
}

export async function revboxConnections(sb, ws, uid) {
  const connections = await rows(sb.from('workflow_provider_connections').select('id, name, account_email, owner_user_id, provider:workflow_providers(name, display_name)').eq('workspace_id', ws));
  return connections.filter(c => !c.owner_user_id || c.owner_user_id === uid).map(c => ({ id: c.id, name: c.name, email: c.account_email, slug: String(c.provider?.name ?? '').toLowerCase().replace(/_oauth$/, '') }));
}

export async function revboxAccountOverview(sb, ws, ids) {
  if (!ids.length) return [];
  const accounts=await rows(sb.rpc('revbox_account_overview', { p_workspace_id: ws, p_ids: ids }));
  const signals=accounts.map(a=>a.latest_signal).filter(Boolean);
  if(!signals.length)return accounts;
  const {filterDerivedForViewer,TEAM_VIEWER}=await import('../privacy/messagePrivacy.mjs');
  const facts=await rows(sb.from('claims').select('entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id',ws).in('entity_id',[...new Set(signals.map(s=>s.entity_id).filter(Boolean))]).in('property',[...new Set(signals.map(s=>s.claim_property).filter(Boolean))]).is('invalid_at',null));
  const readable=new Set((await filterDerivedForViewer(sb,ws,facts,TEAM_VIEWER,{isDerived:()=>true})).map(f=>`${f.entity_id}|${f.property}`));
  return accounts.map(a=>({...a,latest_signal:a.latest_signal&&readable.has(`${a.latest_signal.entity_id}|${a.latest_signal.claim_property}`)?a.latest_signal:null}));
}

export async function revboxAccountCatalog(sb, ws, allowed = null) {
  const out = [];
  // The full scope is paged, rather than silently stopping at PostgREST's 1,000.
  for (let offset = 0; ; offset += 500) {
    const page = await rows(sb.from('entity_list_rows').select('entity_id, name, domain, icp_score, last_activity_at, people_count').eq('workspace_id', ws).eq('kind', 'account').order('entity_id').range(offset, offset + 499));
    out.push(...page.filter(a => !allowed || allowed.has(a.entity_id)));
    if (page.length < 500) break;
  }
  const counts = [];
  for (let i = 0; i < out.length; i += 200) counts.push(...await revboxAccountOverview(sb, ws, out.slice(i, i + 200).map(a => a.entity_id)));
  const byId = new Map(counts.map(a => [a.id, a]));
  return out.map(a => ({ ...a, id: a.entity_id, ...byId.get(a.entity_id) }));
}

/**
 * The accounts in a box's scope as the server resolves it (GET-873): its selected ids, or its saved
 * filter (closed-won, ICP score, ...), among the accounts the viewer may see (`allowed`, null =
 * unrestricted). The box's own access check (view rights). -> { box, accounts } (catalog rows).
 */
export async function revboxScopedAccounts(sb, ws, uid, boxId, allowed = null) {
  const box = await loadRevbox(sb, ws, uid, boxId);
  // Picked accounts (GET-891): read just those, not the whole workspace catalog.
  if (box.scope?.mode === 'selected') {
    const ids = [...new Set((box.scope.account_ids ?? []).filter(id => typeof id === 'string' && (!allowed || allowed.has(id))))];
    return { box, accounts: await accountListRows(sb, ws, ids) };
  }
  const accounts = await revboxAccountCatalog(sb, ws, allowed);
  return { box, accounts: accounts.filter(a => revboxMatchesAccount(box.scope, a)) };
}
/** These accounts' list rows (id, name, domain, icp_score, last_activity_at, people_count), in no order. */
async function accountListRows(sb, ws, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const page = await rows(sb.from('entity_list_rows').select('entity_id, kind, name, domain, icp_score, last_activity_at, people_count').eq('workspace_id', ws).in('entity_id', ids.slice(i, i + 200)));
    out.push(...page.filter(a => (a.kind ?? 'account') === 'account').map(({ kind: _, ...a }) => ({ ...a, id: a.entity_id })));
  }
  return out;
}

/**
 * The accounts a box works on (GET-891), what its Accounts card counts and what the Accounts page
 * and the Account graph open on: the union of
 *   - its selected scope (revboxScopedAccounts),
 *   - the accounts its jobs worked on in the last `days` (revboxRunAccounts: run entities, accounts
 *     a step resolved from names, its output documents' links and named accounts),
 *   - the accounts on its tables' rows added in that window (revbox_dataset_rows.entity_id; a deal
 *     or person counts for its company).
 * Only accounts the viewer may see (`allowed`, null = unrestricted); the box's own view check.
 * `selectedOnly` returns the scope alone, as before GET-891.
 * -> { box, accounts: [{ id, name, domain, icp_score, last_activity_at, people_count, selected, worked_on }],
 *      breakdown: { selected, worked_on }, days, names: { matched, unmatched, ambiguous } }
 */
export async function revboxWorkedAccounts(sb, ws, uid, boxId, allowed = null, { days = 30, now: at = Date.now(), selectedOnly = false } = {}) {
  const { box, accounts: scoped } = await revboxScopedAccounts(sb, ws, uid, boxId, allowed);
  const selected = new Set(scoped.map(a => a.id));
  const worked = new Set();
  let names = { matched: 0, unmatched: 0, ambiguous: 0 };
  if (!selectedOnly) {
    const routines = await rows(sb.from('agent_routines').select('id').eq('workspace_id', ws).eq('revbox_id', box.id));
    const ran = await revboxRunAccounts(sb, ws, { revboxId: box.id, routineIds: routines.map(r => r.id), allowed, days, now: at });
    names = ran.names;
    for (const a of ran.accounts) worked.add(a.id);
    for (const id of await revboxDatasetAccounts(sb, ws, box.id, { since: new Date(at - days * 86_400_000).toISOString() })) if (!allowed || allowed.has(id)) worked.add(id);
  }
  const byId = new Map(scoped.map(a => [a.id, a]));
  for (const a of await accountListRows(sb, ws, [...worked].filter(id => !byId.has(id)))) byId.set(a.id, a);
  const accounts = [...byId.values()].filter(a => selected.has(a.id) || worked.has(a.id))
    .map(a => ({ id: a.id, name: a.name ?? 'Account', domain: a.domain ?? null, icp_score: a.icp_score ?? null, last_activity_at: a.last_activity_at ?? null, people_count: a.people_count ?? 0, selected: selected.has(a.id), worked_on: worked.has(a.id) }));
  return { box, accounts, breakdown: { selected: accounts.filter(a => a.selected).length, worked_on: accounts.filter(a => a.worked_on).length }, days, names };
}
/** The accounts on a box's table rows added since `since`: an account row as itself, a deal or person row as its company. */
async function revboxDatasetAccounts(sb, ws, boxId, { since }) {
  let sets;
  try { sets = await rows(sb.from('revbox_datasets').select('id').eq('workspace_id', ws).eq('revbox_id', boxId)); }
  catch (e) { if (['42P01', 'PGRST205'].includes(e.code)) return []; throw e; }
  if (!sets.length) return [];
  const ids = new Set();
  for (const r of await rows(sb.from('revbox_dataset_rows').select('entity_id, created_at').eq('workspace_id', ws).in('dataset_id', sets.map(d => d.id)).gte('created_at', since).limit(5000))) if (r.entity_id) ids.add(r.entity_id);
  const out = new Set();
  for (const e of await entityRows(sb, ws, [...ids])) { const c = e.kind === 'account' ? e.entity_id : e.company_id; if (c) out.add(c); }
  return [...out];
}

export async function revboxScopedGraph(sb, ws, scope, accounts) {
  const selected = accounts.filter(a => revboxMatchesAccount(scope, a));
  const nodes = selected.map(a => ({ id: a.id, type: 'account', label: a.name ?? 'Account', icp: a.icp_score, people: a.people_count }));
  const edges = [];
  for (let i = 0; i < selected.length; i += 100) {
    for (let offset = 0; ; offset += 500) {
      const page = await rows(sb.from('entity_list_rows').select('entity_id, kind, name, company_id, stage').eq('workspace_id', ws).in('company_id', selected.slice(i, i + 100).map(a => a.id)).in('kind', ['person', 'deal']).order('entity_id').range(offset, offset + 499));
      for (const n of page) { nodes.push({ id: n.entity_id, type: n.kind, label: n.name ?? n.kind, sub: n.stage }); edges.push({ s: n.entity_id, t: n.company_id, type: n.kind === 'deal' ? 'deal_of' : 'works_at' }); }
      if (page.length < 500) break;
    }
  }
  return { nodes, edges };
}
