import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount } from '../services/revboxPlan.mjs';
import { revboxContextRows, addBoxContext, unlinkContext } from './contextLibrary.mjs';
import { accountNamesInText, resolveAccountNames, normalizeAccountName } from './accountNames.mjs';
export { builtinJobBrief, FOLLOW_UP_RECORDERS } from './revboxJobBrief.mjs';

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
  // The three reads go out together (GET-896); they are judged in order, membership first.
  const [member, found, roles] = await Promise.allSettled([
    revboxMembership(sb, ws, uid),
    one(sb.from('revboxes').select('*').eq('workspace_id', ws).eq('id', id).maybeSingle()),
    rows(sb.from('revbox_members').select('user_id, role').eq('workspace_id', ws).eq('revbox_id', id)),
  ]);
  if (member.status === 'rejected') throw member.reason;
  if (found.status === 'rejected') throw found.reason;
  const box = found.value;
  if (!box) fail(404, 'RevBox not found.');
  if (roles.status === 'rejected') throw roles.reason;
  const members = roles.value;
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
  const keys = ['name', 'objective', 'shared', 'scope', 'blocks', 'delivery', 'builtin_jobs', 'builtin_add', 'builtin_remove', 'revision'];
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
  for (const field of ['builtin_jobs', 'builtin_add', 'builtin_remove']) {
    if (field in body && (!Array.isArray(body[field]) || body[field].some(k => !REVBOX_BUILTIN_KEYS.includes(k)) || new Set(body[field]).size !== body[field].length)) return 'Choose known built-in jobs.';
  }
  if ('builtin_jobs' in body && ('builtin_add' in body || 'builtin_remove' in body)) return 'Send the built-in list or the changes to it, not both.';
  if (JSON.stringify(body).length > 300000) return 'RevBox configuration is too large.';
  return null;
}

export async function patchRevbox(sb, ws, uid, id, body) {
  const error = validateRevboxPatch(body); if (error) fail(400, error);
  const box = await loadRevbox(sb, ws, uid, id, true);
  if ('shared' in body && box.access !== 'owner') fail(403, 'Only the owner can change sharing.');
  const { revision, builtin_add: add, builtin_remove: remove, ...patch } = body;
  if (patch.delivery) patch.delivery = storedDelivery(patch.delivery);
  // Built-in changes as operations (GET-897): applied to the row as the server has it, so a page
  // holding an older copy of the box's built-ins can add or remove one without dropping the rest.
  if (add || remove) patch.builtin_jobs = applyBuiltinOps(builtinJobsOf(box), { add, remove });
  // A built-in job is listed in one box per workspace (GET-872): adding one another box has is a 409.
  const added = (patch.builtin_jobs ?? []).filter(k => !builtinJobsOf(box).includes(k));
  if (added.length) {
    const clash = (await revboxBuiltinTaken(sb, ws, uid, id)).find(t => added.includes(t.key));
    if (clash) fail(409, `${REVBOX_BUILTIN_JOBS.find(j => j.key === clash.key).name} is already in ${clash.box_name ? `the RevBox "${clash.box_name}"` : 'another RevBox'}.`);
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
 * are resolved (accountNamesInText + resolveAccountNames: exact normalized names only).
 *
 * Worked out once per run (GET-896): the first read after a run has finished keeps what it touched
 * on the run (`state.accounts_resolved`: its entity ids and the names it resolved), and every later
 * read takes it from there, with no document reads and no name lookups. A run still going is
 * worked out live on each read. Only accounts in `allowed` (null = unrestricted) are returned; that
 * filter is applied at read time, per viewer, never kept.
 * -> { accounts: [{ id, name, domain, runs }], runs: runs in the window, linked: any run named an
 *      account, names: { matched, unmatched, ambiguous } (counts of distinct names across the runs) }
 */
export async function revboxRunAccounts(sb, ws, { revboxId, routineIds = [], allowed = null, days = 30, now: at = Date.now(), pastDocs = 30 } = {}) {
  const ran = await revboxRunEntities(sb, ws, { revboxId, routineIds, days, now: at, pastDocs });
  const { companyOf, known } = await accountsOfEntities(sb, ws, ran.runs.flatMap(r => [...r.entities]));
  await ran.kept;
  const counts = new Map();
  let linked = false;
  for (const r of ran.runs) {
    const touched = new Set([...r.entities].map(e => companyOf.get(e)).filter(id => id && known.has(id)));
    if (touched.size) linked = true;
    for (const id of touched) if (!allowed || allowed.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const accounts = [...counts].map(([id, n]) => ({ id, name: known.get(id)?.name ?? 'Account', domain: known.get(id)?.domain ?? null, runs: n }))
    .sort((a, b) => b.runs - a.runs || String(a.name).localeCompare(String(b.name)));
  return { accounts, runs: ran.runs.length, linked, names: ran.names };
}

/** Run statuses that are final: nothing writes the run's documents or step log again. */
const RUN_DONE = ['ok', 'error', 'skipped', 'rejected'];
const KEPT_VERSION = 1;
const keptOf = (v) => v && typeof v === 'object' && v.v === KEPT_VERSION && Array.isArray(v.entities) ? v : null;

/**
 * Every run of these routines in the window (and the box's legacy runs) with the entity ids it
 * touched, before any visibility filter. A finished run worked out on an earlier read is taken
 * from `state.accounts_resolved`; the others are worked out now, and the finished ones among them
 * are kept (`kept`: a promise, settled once written; a failed write only means the next read
 * works it out again). `ready`: writes wait for it (the caller's access check).
 * -> { runs: [{ id, entities: Set }], names: { matched, unmatched, ambiguous }, kept: Promise }
 */
async function revboxRunEntities(sb, ws, { revboxId, routineIds = [], days = 30, now: at = Date.now(), pastDocs = 30, ready = null }) {
  const since = new Date(at - days * 86_400_000).toISOString();
  const runs = [];   // [{ id, entities: Set, docIds: Set, unrecorded: Set(doc ids whose step logged no accounts), at, done, kept }]
  const pages = [];
  for (let i = 0; i < routineIds.length; i += 100) {
    pages.push(rows(sb.from('agent_routine_runs').select('id, entity_id, document_id, step_log, started_at, status, resolved:state->accounts_resolved').eq('workspace_id', ws)
      .in('routine_id', routineIds.slice(i, i + 100)).gte('started_at', since).limit(2000)));
  }
  const legacy = revboxId
    ? rows(sb.from('revbox_runs').select('id, account_ids').eq('workspace_id', ws).eq('revbox_id', revboxId).gte('created_at', since).limit(2000))
      .catch(e => { if (['42P01', 'PGRST205'].includes(e.code)) return []; throw e; })
    : Promise.resolve([]);
  const [routinePages, legacyRows] = await Promise.all([Promise.all(pages), legacy]);
  for (const r of routinePages.flat()) {
    const kept = keptOf(r.resolved);
    if (kept) { runs.push({ id: r.id, entities: new Set(kept.entities.filter(id => typeof id === 'string' && id)), docIds: new Set(), unrecorded: new Set(), at: String(r.started_at ?? ''), kept }); continue; }
    const run = { id: r.id, entities: new Set([r.entity_id].filter(Boolean)), docIds: new Set([r.document_id].filter(Boolean)), unrecorded: new Set(), at: String(r.started_at ?? ''), done: RUN_DONE.includes(r.status) };
    for (const e of Array.isArray(r.step_log) ? r.step_log : []) {
      if (Array.isArray(e?.accounts)) for (const id of e.accounts) if (typeof id === 'string' && id) run.entities.add(id);
      if (e?.document_id) { run.docIds.add(e.document_id); if (!Array.isArray(e.accounts)) run.unrecorded.add(e.document_id); }
    }
    if (r.document_id && !(Array.isArray(r.step_log) && r.step_log.some(e => Array.isArray(e?.accounts)))) run.unrecorded.add(r.document_id);
    runs.push(run);
  }
  for (const r of legacyRows) runs.push({ id: r.id, entities: new Set((r.account_ids ?? []).filter(Boolean)), docIds: new Set(), unrecorded: new Set(), at: '', legacy: true });

  // The runs not yet worked out: their documents' subjects and links (read once the caller's access check has passed).
  const live = runs.filter(r => !r.kept && !r.legacy);
  if (live.length) await ready;
  const docIds = [...new Set(live.flatMap(r => [...r.docIds]))];
  const docEntities = new Map();   // doc id -> entity ids
  const add = (doc, entity) => { if (!doc || !entity) return; if (!docEntities.has(doc)) docEntities.set(doc, new Set()); docEntities.get(doc).add(entity); };
  const chunks = [];
  for (let i = 0; i < docIds.length; i += 200) chunks.push(docIds.slice(i, i + 200));
  for (const [docs, links] of await Promise.all(chunks.map(chunk => Promise.all([
    rows(sb.from('documents').select('id, subject_entity_id').eq('workspace_id', ws).in('id', chunk)),
    rows(sb.from('document_links').select('document_id, target_entity_id, kind').eq('workspace_id', ws).in('document_id', chunk).in('kind', ['about', 'mentions'])),
  ])))) {
    for (const d of docs) add(d.id, d.subject_entity_id);
    for (const l of links) add(l.document_id, l.target_entity_id);
  }
  // The past (GET-891): the newest output documents that name no entity and whose step logged no
  // accounts, read for the account names they state.
  const docNames = new Map();   // doc id -> normalized names it states
  const verdict = new Map();    // normalized name -> 'matched' | 'unmatched' | 'ambiguous'
  const pending = [...new Set(live.slice().sort((a, b) => b.at.localeCompare(a.at)).flatMap(r => [...r.unrecorded]).filter(d => !docEntities.has(d)))];
  const past = pending.slice(0, pastDocs);
  if (past.length) {
    const docs = await rows(sb.from('documents').select('id, title, body_md').eq('workspace_id', ws).in('id', past));
    const named = new Map(docs.map(d => [d.id, accountNamesInText(d.body_md, d.title)]));
    const all = [...new Set([...named.values()].flat())];
    for (const [doc, list] of named) docNames.set(doc, [...new Set(list.map(normalizeAccountName).filter(Boolean))]);
    if (all.length) {
      const resolved = await resolveAccountNames(sb, ws, all);
      const idOf = new Map(resolved.matched.map(m => [normalizeAccountName(m.name), m.id]));
      for (const m of resolved.matched) verdict.set(normalizeAccountName(m.name), 'matched');
      for (const n of resolved.unmatched) verdict.set(normalizeAccountName(n), 'unmatched');
      for (const n of resolved.ambiguous) verdict.set(normalizeAccountName(n), 'ambiguous');
      for (const [doc, list] of named) for (const n of list) add(doc, idOf.get(normalizeAccountName(n)));
    }
  }
  const skipped = new Set(pending.slice(pastDocs));
  const names = { matched: new Set(), unmatched: new Set(), ambiguous: new Set() };
  const keep = [];
  for (const r of runs) {
    if (r.kept) { for (const k of Object.keys(names)) for (const n of r.kept.names?.[k] ?? []) names[k].add(n); continue; }
    if (r.legacy) continue;
    const own = { matched: [], unmatched: [], ambiguous: [] };
    for (const d of r.docIds) {
      for (const e of docEntities.get(d) ?? []) r.entities.add(e);
      for (const n of docNames.get(d) ?? []) { const v = verdict.get(n); if (v && !own[v].includes(n)) own[v].push(n); }
    }
    for (const k of Object.keys(names)) for (const n of own[k]) names[k].add(n);
    // Kept only when finished and complete: none of its documents waited behind the `pastDocs` cap.
    if (r.done && ![...r.unrecorded].some(d => skipped.has(d))) keep.push({ id: r.id, kept: { v: KEPT_VERSION, at: new Date(at).toISOString(), entities: [...r.entities], names: own } });
  }
  const kept = keep.length ? keepRunEntities(sb, ws, keep, ready) : Promise.resolve();
  return { runs, names: { matched: names.matched.size, unmatched: names.unmatched.size, ambiguous: names.ambiguous.size }, kept };
}

/** Write each worked-out run's result onto it (state.accounts_resolved), merged into its state, finished runs only. Never throws. */
async function keepRunEntities(sb, ws, keep, ready) {
  try {
    await ready;
    const states = new Map();
    for (let i = 0; i < keep.length; i += 200) {
      for (const r of await rows(sb.from('agent_routine_runs').select('id, state').eq('workspace_id', ws).in('id', keep.slice(i, i + 200).map(k => k.id)))) states.set(r.id, r.state);
    }
    for (let i = 0; i < keep.length; i += 10) {
      await Promise.all(keep.slice(i, i + 10).filter(k => states.has(k.id)).map(async k => {
        const state = states.get(k.id);
        const { error } = await sb.from('agent_routine_runs').update({ state: { ...(state && typeof state === 'object' ? state : {}), accounts_resolved: k.kept } })
          .eq('workspace_id', ws).eq('id', k.id).in('status', RUN_DONE);
        if (error) throw error;
      }));
    }
  } catch (e) {
    if (e?.status) return;   // the access check failed: nothing is kept for this caller
    console.warn('[revboxes] could not keep run accounts', e?.message ?? e);
  }
}

/**
 * Each entity as its account: an account is itself, a person or deal is its company. Reads the
 * list columns too, so the accounts come back ready to show.
 * -> { companyOf: Map(entity id -> account id), known: Map(account id -> list row) }
 */
async function accountsOfEntities(sb, ws, ids) {
  const entities = await entityRows(sb, ws, [...new Set(ids)]);
  const companyOf = new Map();
  for (const e of entities) { const c = e.kind === 'account' ? e.entity_id : e.company_id; if (c) companyOf.set(e.entity_id, c); }
  const known = new Map(entities.filter(e => e.kind === 'account').map(e => [e.entity_id, e]));
  const missing = [...new Set(companyOf.values())].filter(id => !known.has(id));
  for (const e of await entityRows(sb, ws, missing)) if (e.kind === 'account') known.set(e.entity_id, e);
  return { companyOf, known };
}
const ENTITY_COLUMNS = 'entity_id, kind, name, domain, company_id, icp_score, last_activity_at, people_count';
async function entityRows(sb, ws, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  return (await Promise.all(chunks.map(chunk => rows(sb.from('entity_list_rows').select(ENTITY_COLUMNS).eq('workspace_id', ws).in('entity_id', chunk))))).flat();
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
/**
 * A box's built-in list after `add` and `remove` (GET-897), in catalog order. Keys already there
 * stay; removing one that is not there is a no-op. Pure.
 */
export function applyBuiltinOps(current, { add = [], remove = [] } = {}) {
  const keep = new Set([...(current ?? []), ...(add ?? [])].filter(k => REVBOX_BUILTIN_KEYS.includes(k)));
  for (const k of remove ?? []) keep.delete(k);
  return REVBOX_BUILTIN_KEYS.filter(k => keep.has(k));
}

/**
 * The default boxes a Workspace-plan workspace gets for its built-in jobs (GET-897): every built-in
 * reads as a RevBox job, in a box of its own kind. The frontend preview mirrors the names.
 */
export const DEFAULT_BUILTIN_BOXES = [
  { name: 'Meetings Follow-up', keys: ['sales_follow_up'], objective: 'Follow up every customer meeting the same day: the email drafted, the tasks and CRM updates proposed, each approved in Priorities.' },
  { name: 'Pipeline Health', keys: ['stale_deal', 'deal_risk', 'deal_signals'], objective: 'Keep every open deal moving: catch stale deals, accounts turning at-risk and deal signals early.' },
  { name: 'Customer Growth', keys: ['expansion'], objective: 'Pick up every customer asking for more of what you sell.' },
];
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const oldestFirst = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * What it takes to put every built-in in a box (GET-897), from the workspace's boxes:
 * [{ create: name, objective, keys } | { add: box_id, name, revision, keys }]. A built-in already in
 * any box stays where it is (never moved). One that is in none goes to its default box: the oldest
 * box with that name (any case) gains it, else a new box is made. Nothing to do: []. Pure.
 */
export function planDefaultBuiltinBoxes(boxes) {
  const list = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
  const placed = new Set(list.flatMap(builtinJobsOf));
  const out = [];
  for (const def of DEFAULT_BUILTIN_BOXES) {
    const keys = def.keys.filter(k => !placed.has(k));
    if (!keys.length) continue;
    const home = list.filter(b => sameName(b.name, def.name)).sort(oldestFirst)[0];
    out.push(home ? { add: home.id, name: home.name, revision: home.revision, keys } : { create: def.name, objective: def.objective, keys });
  }
  return out;
}

/**
 * Who a workspace's default boxes belong to: its owner, else its first admin, else its first member
 * (OpenNous support seats last). Null for a workspace with no members.
 */
export async function workspaceDefaultOwner(sb, ws) {
  const members = await rows(sb.from('workspace_members').select('user_id, role, created_at, support_until').eq('workspace_id', ws));
  const rank = (m) => (m.support_until ? 10 : 0) + ({ owner: 0, admin: 1, member: 2 }[m.role] ?? 3);
  return [...members].sort((a, b) => rank(a) - rank(b) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0]?.user_id ?? null;
}

/**
 * Put every built-in job of a Workspace-plan workspace in a box (GET-897): the caller decides the
 * plan; this only reads the boxes and applies planDefaultBuiltinBoxes. Idempotent: a second call
 * finds nothing to do. New boxes are shared with the workspace and owned by `ownerId`. Two calls at
 * once can each make a box; the one made first is kept and the later one deleted, so a built-in
 * never ends in two boxes. An add is revision-checked; one that loses a race is left for the next
 * call. `dryRun`: the plan only, nothing written. -> { planned, created: [ids], added: [ids] }
 */
export async function ensureDefaultBuiltinBoxes(sb, ws, { ownerId = null, dryRun = false } = {}) {
  let boxes;
  try { boxes = await rows(sb.from('revboxes').select('id, name, revision, builtin_jobs, created_at').eq('workspace_id', ws)); }
  catch (e) { if (missingColumn(e)) return { planned: [], created: [], added: [] }; throw e; }
  const planned = planDefaultBuiltinBoxes(boxes);
  const done = { planned, created: [], added: [] };
  if (dryRun || !planned.length) return done;
  const owner = ownerId ?? await workspaceDefaultOwner(sb, ws);
  if (!owner) return done;
  for (const step of planned) {
    if (step.add) {
      const box = boxes.find(b => b.id === step.add);
      const updated = await one(sb.from('revboxes').update({ builtin_jobs: applyBuiltinOps(builtinJobsOf(box), { add: step.keys }), revision: box.revision + 1, updated_at: now() })
        .eq('workspace_id', ws).eq('id', box.id).eq('revision', box.revision).select('id').maybeSingle());
      if (updated) done.added.push(box.id);
      continue;
    }
    const made = await one(sb.from('revboxes').insert({ workspace_id: ws, owner_id: owner, name: step.create, objective: step.objective, shared: true, builtin_jobs: step.keys }).select('id, name, created_at').single());
    // A concurrent call may have made the same box: the oldest one with these built-ins stays.
    const twins = (await rows(sb.from('revboxes').select('id, name, builtin_jobs, created_at').eq('workspace_id', ws)))
      .filter(b => sameName(b.name, step.create) && builtinJobsOf(b).some(k => step.keys.includes(k))).sort(oldestFirst);
    if (twins.length > 1 && twins[0].id !== made.id) { await rows(sb.from('revboxes').delete().eq('workspace_id', ws).eq('id', made.id)); continue; }
    done.created.push(made.id);
  }
  return done;
}

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
  return { box, accounts: await scopeAccounts(sb, ws, box, allowed) };
}
async function scopeAccounts(sb, ws, box, allowed) {
  // Picked accounts (GET-891): read just those, not the whole workspace catalog.
  if (box.scope?.mode === 'selected') {
    const ids = [...new Set((box.scope.account_ids ?? []).filter(id => typeof id === 'string' && (!allowed || allowed.has(id))))];
    return accountListRows(sb, ws, ids);
  }
  const accounts = await revboxAccountCatalog(sb, ws, allowed);
  return accounts.filter(a => revboxMatchesAccount(box.scope, a));
}
/** These accounts' list rows (id, name, domain, icp_score, last_activity_at, people_count), in no order. */
const listRow = ({ kind: _k, company_id: _c, ...a }) => ({ ...a, id: a.entity_id });
async function accountListRows(sb, ws, ids) {
  return (await entityRows(sb, ws, ids)).filter(a => (a.kind ?? 'account') === 'account').map(listRow);
}

/**
 * The accounts a box works on (GET-891), what its Accounts card counts and what the Accounts page
 * and the Account graph open on: the union of
 *   - its selected scope (revboxScopedAccounts),
 *   - the accounts its jobs worked on in the last `days` (revboxRunAccounts: run entities, accounts
 *     a step resolved from names, its output documents' links and named accounts; worked out once
 *     per finished run and kept on it, GET-896),
 *   - the accounts on its tables' rows added in that window (revbox_dataset_rows.entity_id; a deal
 *     or person counts for its company),
 *   - the accounts its built-in jobs worked on in that window (GET-902, revboxBuiltinEntityIds: the
 *     after-call follow-up's cards and the detectors' drafts; a deal counts for its company).
 * Only accounts the viewer may see (`allowed`, null = unrestricted; a promise of it is awaited, so a
 * caller can start that read alongside this one); the box's own view check.
 * The reads that need only the box id start with the access check rather than after it (GET-896);
 * nothing is returned or kept unless it passes.
 * `selectedOnly` returns the scope alone, as before GET-891.
 * -> { box, accounts: [{ id, name, domain, icp_score, last_activity_at, people_count, selected, worked_on }],
 *      breakdown: { selected, worked_on }, days, names: { matched, unmatched, ambiguous } }
 */
export async function revboxWorkedAccounts(sb, ws, uid, boxId, allowed = null, { days = 30, now: at = Date.now(), selectedOnly = false } = {}) {
  const access = loadRevbox(sb, ws, uid, boxId);
  const visibleP = Promise.resolve(allowed);
  const scopedP = Promise.all([access, visibleP]).then(([box, visible]) => scopeAccounts(sb, ws, box, visible));
  const noNames = { matched: 0, unmatched: 0, ambiguous: 0 };
  const workedP = selectedOnly ? Promise.resolve(null) : (async () => {
    const since = new Date(at - days * 86_400_000).toISOString();
    const [ran, tableIds, builtinIds] = await Promise.all([
      rows(sb.from('agent_routines').select('id').eq('workspace_id', ws).eq('revbox_id', boxId))
        .then(routines => revboxRunEntities(sb, ws, { revboxId: boxId, routineIds: routines.map(r => r.id), days, now: at, ready: access })),
      revboxDatasetEntityIds(sb, ws, boxId, { since }),
      // The built-ins the box lists (GET-902): known once the box is read, which the access check does.
      access.then(box => revboxBuiltinEntityIds(sb, ws, builtinJobsOf(box), { since }), () => []),
    ]);
    const resolved = await accountsOfEntities(sb, ws, [...ran.runs.flatMap(r => [...r.entities]), ...tableIds, ...builtinIds]);
    await ran.kept;
    return { ran, tableIds, builtinIds, ...resolved };
  })();
  const [box, visible, scoped, w] = await Promise.all([access, visibleP, scopedP, workedP]);
  const ok = (id) => !visible || visible.has(id);
  const selected = new Set(scoped.map(a => a.id));
  const worked = new Set();
  if (w) {
    // A run's accounts (revboxRunAccounts' rule: an entity counts through its company, only a known account).
    for (const r of w.ran.runs) for (const e of r.entities) { const c = w.companyOf.get(e); if (c && w.known.has(c) && ok(c)) worked.add(c); }
    // A table row's account (its company, as the entity row says).
    for (const e of w.tableIds) { const c = w.companyOf.get(e); if (c && ok(c)) worked.add(c); }
    // What its built-ins worked on (GET-902): a follow-up card's or a draft's account, a deal's company.
    for (const e of w.builtinIds) { const c = w.companyOf.get(e); if (c && w.known.has(c) && ok(c)) worked.add(c); }
  }
  const byId = new Map(scoped.map(a => [a.id, a]));
  const unseen = [...worked].filter(id => !byId.has(id));
  for (const id of unseen) if (w.known.has(id)) byId.set(id, listRow(w.known.get(id)));
  for (const a of await accountListRows(sb, ws, unseen.filter(id => !byId.has(id)))) byId.set(a.id, a);
  const accounts = [...byId.values()].filter(a => selected.has(a.id) || worked.has(a.id))
    .map(a => ({ id: a.id, name: a.name ?? 'Account', domain: a.domain ?? null, icp_score: a.icp_score ?? null, last_activity_at: a.last_activity_at ?? null, people_count: a.people_count ?? 0, selected: selected.has(a.id), worked_on: worked.has(a.id) }));
  return { box, accounts, breakdown: { selected: accounts.filter(a => a.selected).length, worked_on: accounts.filter(a => a.worked_on).length }, days, names: w ? w.ran.names : noNames };
}
/**
 * The entities a box's built-in jobs worked on since `since` (GET-902), each counting as its company:
 * the after-call follow-up's cards (follow_ups.account_entity_id, created in the window) and the
 * detectors' drafts (their ri_recommendations ledger rows, rec_key automation.<detector>, updated in
 * the window, the same rows the cards' activity line counts: an account, or a deal's company). Ids
 * only, from one or two indexed reads; no visibility filter here (the caller applies it). Before the
 * built-in columns or tables exist: none.
 */
// A ledger target is text; only an entity id (a uuid) is looked up as one.
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function revboxBuiltinEntityIds(sb, ws, keys, { since }) {
  const defs = REVBOX_BUILTIN_JOBS.filter(j => (keys ?? []).includes(j.key));
  if (!defs.length) return [];
  const ids = new Set();
  const gone = (e) => ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(e?.code);
  const reads = [];
  if (defs.some(d => d.drafts.table === 'follow_ups')) {
    reads.push(rows(sb.from('follow_ups').select('account_entity_id').eq('workspace_id', ws).gte('created_at', since).limit(5000))
      .then(list => { for (const r of list) if (r.account_entity_id) ids.add(r.account_entity_id); }, e => { if (!gone(e)) throw e; }));
  }
  const recKeys = defs.map(d => d.drafts.rec_key).filter(Boolean);
  if (recKeys.length) {
    reads.push(rows(sb.from('ri_recommendations').select('target_type, target_id').eq('workspace_id', ws).eq('category', 'automation').in('rec_key', recKeys).gte('updated_at', since).limit(5000))
      .then(list => { for (const r of list) if (UUID_ID.test(String(r.target_id ?? '')) && ['account', 'deal', 'person', 'contact'].includes(r.target_type)) ids.add(String(r.target_id)); }, e => { if (!gone(e)) throw e; }));
  }
  await Promise.all(reads);
  return [...ids];
}

/** The entities on a box's table rows added since `since` (each counts as its company). */
async function revboxDatasetEntityIds(sb, ws, boxId, { since }) {
  let sets;
  try { sets = await rows(sb.from('revbox_datasets').select('id').eq('workspace_id', ws).eq('revbox_id', boxId)); }
  catch (e) { if (['42P01', 'PGRST205'].includes(e.code)) return []; throw e; }
  if (!sets.length) return [];
  const ids = new Set();
  for (const r of await rows(sb.from('revbox_dataset_rows').select('entity_id, created_at').eq('workspace_id', ws).in('dataset_id', sets.map(d => d.id)).gte('created_at', since).limit(5000))) if (r.entity_id) ids.add(r.entity_id);
  return [...ids];
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
