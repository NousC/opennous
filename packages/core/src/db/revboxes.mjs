import { proposeRevboxPlan, validateRevboxPlan, revboxMatchesAccount } from '../services/revboxPlan.mjs';

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
  const keys = ['name', 'objective', 'shared', 'scope', 'blocks', 'delivery', 'revision'];
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
  if (JSON.stringify(body).length > 300000) return 'RevBox configuration is too large.';
  return null;
}

export async function patchRevbox(sb, ws, uid, id, body) {
  const error = validateRevboxPatch(body); if (error) fail(400, error);
  const box = await loadRevbox(sb, ws, uid, id, true);
  if ('shared' in body && box.access !== 'owner') fail(403, 'Only the owner can change sharing.');
  const { revision, ...patch } = body;
  if (patch.delivery) patch.delivery = storedDelivery(patch.delivery);
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
  const [context, jobs] = await Promise.all([
    rows(sb.from('revbox_context').select('*').eq('workspace_id', ws).eq('revbox_id', id).order('created_at')),
    rows(sb.from('revbox_jobs').select('*').eq('workspace_id', ws).eq('revbox_id', id).order('created_at')),
  ]);
  return { box, context, jobs };
}

export async function addRevboxContext(sb, ws, uid, id, body) {
  await loadRevbox(sb, ws, uid, id, true);
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.body !== 'string' || Buffer.byteLength(body.body) > 262144) fail(400, 'Upload a text reference up to 256 KB.');
  const data = await one(sb.from('revbox_context').insert({ workspace_id: ws, revbox_id: id, created_by: uid, title: clean(body.title, 200), body: body.document_id ? '' : body.body, document_id: body.document_id ?? null }).select('*').single());
  await touch(sb, ws, id); return data;
}

export async function removeRevboxContext(sb, ws, uid, id, contextId) {
  await loadRevbox(sb, ws, uid, id, true);
  await rows(sb.from('revbox_context').delete().eq('workspace_id', ws).eq('revbox_id', id).eq('id', contextId));
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
  const references = await rows(sb.from('revbox_context').select('id, document_id').eq('workspace_id', ws).eq('revbox_id', id));
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
