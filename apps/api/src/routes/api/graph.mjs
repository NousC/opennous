import { Router } from 'express';
import { getSupabaseClient, scoreTier, getInternalEntityIds, filterDerivedForViewer, filterByCitedClaimsForViewer, accountStage, TERMINAL_STAGES, STAGE_LABEL } from '@nous/core';
import { requestMessageViewer } from '../../lib/messagePrivacy.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { rankCommittee, committeeEdges, ROLE_EDGES } from '../../lib/committee.mjs';
import { contextGraph, neighbourhood } from '../../lib/contextGraph.mjs';
import { hasListRows, personStagesForAccounts, dealValueByCompany } from '../../lib/listRows.mjs';
import { impliedDealName } from '../../lib/accountDeals.mjs';
import { listWorkspaceDeals } from '../../lib/workspaceDeals.mjs';

// GET /api/graph?workspaceId=... — the workspace context graph as a war-room:
// companies with their buying committee, bridged to each other by the shared
// claims/pains they surface, plus computed patterns (single-threaded, missing
// budget-holder, shared-claim clusters).
//
// SCOPE: only accounts we've actually TOUCHED — engaged contacts (People view)
// and the companies that either have activity or employ one of those contacts.
// The cold lead-list domains are excluded. Names are included for the owner view;
// the client "Anonymize" toggle hides them for a shareable artifact.
export const graphApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ageDays = (ts) => ts ? Math.round((Date.now() - +new Date(ts)) / 864e5) : null;
const DM_RE = /founder|co-?founder|ceo|owner|chief|president|\bvp\b|vice president|head of|director|partner|principal|cxo|coo|cfo|cmo|cto/i;
// generic buckets that make fake hubs — dropped from the claim layer
// generic buckets only — firmographic terms (agency, startup, smb, b2b…) are
// deliberately NOT dropped: they flow through to the shared_segment (lookalike) layer.
const STOP = new Set(['company','companies','client','clients','customer','customers','user','users',
  'product','products','service','services','tool','tools','software','platform','business',
  'ceo','team','teams','work','workflow','workflows','system','systems','operations','marketing','sales','gtm','go-to-market',
  'ai','revenue','institutions','contact','person','people','integrations','automation','automations']);

// Classify a shared claim so the rail can split shared_stack (tools we could
// integrate with / displace) from shared_pain (messaging angles) from
// shared_intent (initiatives = timing). Honest labelling — most extracted
// claims today are tools, so shared_pain/intent stay sparse until signal-scan
// surfaces more real pains.
//
// The words below are the common GTM / productivity tools any workspace mentions. A hosted
// workspace can add its own (the tools its accounts keep naming) through registerStackTerms;
// Cloud registers its list at boot (cloud/index.mjs), a self-hosted install uses this one.
export const BASE_STACK_TERMS = Object.freeze('clay instantly zapier make n8n hubspot salesforce notion slack apollo smartly render claude linkedin gmail outlook lemlist heyreach unipile airtable sheets google chatgpt openai gpt nous'.split(' '));
const STACK = new Set(BASE_STACK_TERMS);
/** Extra stack words (lower-case, one word each). Additive and idempotent. */
export function registerStackTerms(words) {
  for (const w of words ?? []) { const t = String(w ?? '').toLowerCase().trim(); if (t) STACK.add(t); }
}
/** Test seam: does this label classify as a stack claim right now. */
export const classifyClaimLabel = (label) => classifyClaim(label);
const SEG_WORDS = new Set(['yc', 'smb', 'smbs', 'b2b', 'dtc', 'saas']);
const SEG_SUB = ['agency', 'agencies', 'bootstrap', 'startup', 'enterprise', 'solopreneur', 'freelanc', 'consultan', 'ecommerce', 'fintech', 'recruit', 'staffing', 'founder-led', 'german'];
const PAINW = ['pain', 'cost', 'issue', 'problem', 'fragment', 'reliab', 'bottleneck', 'slow', 'scal', 'deadline', 'churn', 'friction', 'gap', 'risk', 'hard', 'struggl', 'deliver', 'manual', 'stall', 'overwhelm', 'inconsist', 'error', 'fail', 'time-consum', 'headcount', 'fatigue'];
const INTENTW = ['build', 'system', 'product', 'strateg', 'launch', 'prototyp', 'automat', 'migrat', 'adopt', 'hiring', 'expansion', 'initiative', 'roadmap', 'systemiz', 'rollout', 'agent', 'outbound', 'validation', 'testing', 'discovery'];
function classifyClaim(label) {
  const l = (label || '').toLowerCase();
  const words = new Set(l.match(/[a-z0-9]+/g) || []);
  for (const w of words) if (SEG_WORDS.has(w)) return 'segment';
  if (SEG_SUB.some(w => l.includes(w))) return 'segment';
  for (const w of words) if (STACK.has(w)) return 'stack';
  if (PAINW.some(w => l.includes(w))) return 'pain';
  if (INTENTW.some(w => l.includes(w))) return 'intent';
  return 'theme';
}

// Normalize a free-text `industry` claim into a canonical segment bucket, so
// accounts group into real lookalike segments ("agency", "software"…) instead
// of every distinct string being its own singleton. This is the shared_segment
// (lookalike) layer — sourced from the same firmographic claims ICP scoring uses.
function normSeg(t) {
  const l = (t || '').toLowerCase();
  if (/agenc|marketing|advertis|creative|demand gen|lead gen|seo|ppc/.test(l)) return 'agency';
  if (/saas|software|devtool|platform|information and internet|technology|web dev|app dev/.test(l)) return 'software';
  if (/consult|revops|rev ops|advisor/.test(l)) return 'consulting';
  if (/fintech|financ|insur|bank|payment|lending/.test(l)) return 'fintech';
  if (/\bdata\b|analytic/.test(l)) return 'data';
  if (/ecommerce|e-commerce|\bdtc\b|retail|consumer/.test(l)) return 'ecommerce';
  if (/logistic|supply chain|freight|shipping/.test(l)) return 'logistics';
  if (/recruit|staffing|talent/.test(l)) return 'recruiting';
  return 'other';
}

/**
 * How much of a workspace a graph draws.
 *
 * A picture of nine thousand accounts is not a picture: at thousands of nodes every node is a speck of
 * dust and the answer to "who do we know here" is invisible (GET-298). These caps are what fits on
 * a screen while still being a network — the most recently worked accounts and their people.
 */
const GRAPH_ACCOUNT_CAP = 300;
const GRAPH_PEOPLE_CAP = 3000;

async function pageAll(makeQuery) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await makeQuery(from, from + size - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

/** Which of `ids` are entities not merged away. Chunked: a long `.in()` breaks the URL. */
async function liveEntityIds(supabase, workspaceId, ids) {
  const live = new Set();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const { data, error } = await supabase.from('entities').select('id, status')
      .eq('workspace_id', workspaceId).in('id', uniq.slice(i, i + 200));
    if (error) throw error;
    for (const r of data || []) if (r.status !== 'merged') live.add(r.id);
  }
  return live;
}

/** The network the views read: people, touched accounts, who knows whom, and the patterns (GET-815: shared by /context). */
async function buildNetwork(supabase, req, workspaceId) {

  const [contactsRaw, companies, gedges, internalIds, memberNames] = await Promise.all([
    // From the flattened lists, and only the most recently worked (GET-297). Reading every
    // person and account through the views timed out on a client workspace — tens of thousands of people
    // assembled from claims — and a graph of nine thousand accounts is not a picture anyone
    // can read anyway. The ones nobody has touched in a year are not the ones to draw.
    // Paged: PostgREST answers any single read with at most 1,000 rows, so a `.limit(1200)` was a
    // silent 1,000 ("People 999"), and whoever fell past it vanished from their account — one account
    // drew one of its two people (GET-844).
    pageAll((from, to) => from >= GRAPH_PEOPLE_CAP ? Promise.resolve({ data: [] }) : supabase.from('entity_list_rows')
      .select('entity_id, name, job_title, icp_score, last_activity_at, company_id')
      .eq('workspace_id', workspaceId).eq('kind', 'person')
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .order('entity_id', { ascending: true })
      .range(from, to))
      .then(rows => rows.slice(0, GRAPH_PEOPLE_CAP).map(x => ({
        id: x.entity_id, first_name: (x.name ?? '').split(' ')[0] || null,
        last_name: (x.name ?? '').split(' ').slice(1).join(' ') || null,
        job_title: x.job_title, icp_score: x.icp_score, last_activity_at: x.last_activity_at,
      }))),
    supabase.from('entity_list_rows')
      .select('entity_id, name, domain, icp_score, last_activity_at')
      .eq('workspace_id', workspaceId).eq('kind', 'account')
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(GRAPH_ACCOUNT_CAP)
      .then(r => (r.data || []).map(x => ({
        id: x.entity_id, name: x.name, domain: x.domain,
        icp_score: x.icp_score, last_activity_at: x.last_activity_at,
      }))),
    supabase.from('workspace_graph_edges').select('subject_id,object_id,object_label,relationship')
      .eq('workspace_id', workspaceId).not('subject_id', 'is', null).then(r => r.data || []),
    getInternalEntityIds(supabase, workspaceId),
    // The workspace's own members (the founder + team), by name. Every relationship on
    // the graph radiates around them — they talked to everyone — so a teammate must
    // never appear as an account. The is_internal flag below catches their resolved
    // person entities; matching on name too catches an UNMERGED mention-duplicate of a
    // teammate that was never flagged (e.g. "Marten Oakshaw" pulled from a call before
    // it was tied to their login). Names, lowercased.
    supabase.from('workspace_members').select('users:user_id(name)').eq('workspace_id', workspaceId)
      .then(r => new Set((r.data || [])
        .map(row => (Array.isArray(row.users) ? row.users[0] : row.users)?.name)
        .filter(Boolean)
        .map(n => n.trim().toLowerCase()))),
  ]);
  // Employment edges for the people we are actually drawing, and nobody else.
  //
  // This used to ask for every `works_at` in the workspace, unpaged. One customer has tens of thousands of
  // them and PostgREST answers with 1,000 — no error, no truncation flag — so the graph drew an
  // arbitrary few percent of employment and presented it as the picture. The worst shape of that bug:
  // the output still looks like a graph.
  //
  // Scoping to the rendered people fixes the correctness and the cost at once. A person who is
  // not a node cannot have an edge drawn, so the rest of the rows were never going to be used
  // — we were paying to fetch (and silently lose) data with no destination.
  const peopleIds = contactsRaw.map(c => c.id).filter(Boolean);
  const rels = [];
  for (let i = 0; i < peopleIds.length; i += 200) {
    const chunk = peopleIds.slice(i, i + 200);
    rels.push(...await pageAll((from, to) => supabase
      .from('relationships').select('from_entity_id,to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').is('valid_to', null)
      .in('from_entity_id', chunk)
      .order('from_entity_id', { ascending: true })
      .range(from, to)));
  }

  // Team members are NOT accounts — a co-founder or colleague must never appear in the
  // context graph as a prospect. Drop them by is_internal flag AND by name (to catch an
  // unflagged mention-duplicate of a teammate), so they vanish from nodes, committees,
  // and every concept they'd anchor.
  const memberName = (c) => `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim().toLowerCase();
  // Not merged away. A merged entity keeps its flattened row until the list sweep prunes it (the
  // refresh walks active entities only), and the graph drew it: a merged account sat beside the
  // real one with the person it held before the merge (GET-841).
  const live = await liveEntityIds(supabase, workspaceId, [...peopleIds, ...companies.map(c => c.id)]);
  const contacts = contactsRaw.filter(c => live.has(c.id) && !internalIds.has(c.id) && !(memberName(c) && memberNames.has(memberName(c))));
  companies.splice(0, companies.length, ...companies.filter(c => live.has(c.id)));

  const contactIds = new Set(contacts.map(c => c.id));
  // contact → employer (first works_at) + set of companies that employ a contact
  const contactCompany = new Map(); const worked = new Set();
  for (const r of rels) {
    if (contactIds.has(r.from_entity_id) && r.to_entity_id) {
      if (!contactCompany.has(r.from_entity_id)) contactCompany.set(r.from_entity_id, r.to_entity_id);
      worked.add(r.to_entity_id);
    }
  }
  // touched companies: real activity OR employ an engaged contact
  const touched = companies.filter(c => c.last_activity_at != null || worked.has(c.id));
  const companyIds = new Set(touched.map(c => c.id));

  // segment (lookalike) grouping — normalize each touched company's industry claim
  const industryRows = companyIds.size
    ? ((await supabase.from('claims').select('entity_id,value').eq('workspace_id', workspaceId).eq('property', 'industry').in('entity_id', [...companyIds])).data || [])
    : [];
  const segMap = new Map();
  for (const r of industryRows) {
    const seg = normSeg(typeof r.value === 'string' ? r.value : String(r.value ?? ''));
    if (seg === 'other') continue;
    if (!segMap.has(seg)) segMap.set(seg, new Set());
    segMap.get(seg).add(r.entity_id);
  }

  const dmRel = new Set(gedges.filter(g => g.relationship === 'DECISION_MAKER_AT').map(g => g.subject_id));

  // WHICH signals scored each account.
  //
  // The score alone says "85". It does not say WHY, and "why" is the only part you can
  // act on or argue with. `predictions.fired_signals` holds the drivers that fired, so
  // the graph can group accounts by the reason they are good rather than by the number.
  // That is the difference between a heat map and a model: you can look at Tier 1 and
  // see that it is really two different Tier 1s, held up by two different signals.
  //
  // Newest prediction per entity wins — a re-score supersedes the stake.
  const preds = await pageAll((a, b) => supabase.from('predictions')
    .select('entity_id,fired_signals,created_at')
    .eq('workspace_id', workspaceId).eq('kind', 'icp_fit')
    .order('created_at', { ascending: false }).range(a, b));
  const sigOf = new Map();
  for (const p of preds) {
    if (sigOf.has(p.entity_id)) continue;   // ordered newest-first, so the first is the live one
    const fs = Array.isArray(p.fired_signals) ? p.fired_signals : [];
    sigOf.set(p.entity_id, fs.map(f => (typeof f === 'string' ? f : f?.key)).filter(Boolean));
  }

  // people nodes + committee membership
  const nodes = []; const committee = new Map(); // companyId -> [personId]
  for (const cid of companyIds) committee.set(cid, []);
  for (const c of contacts) {
    const co = contactCompany.get(c.id);
    const inCo = companyIds.has(co) ? co : null;
    const label = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null;
    const dm = !!(DM_RE.test(c.job_title || '') || dmRel.has(c.id));
    const ps = c.icp_score != null ? Number(c.icp_score) : null;
    nodes.push({ i: c.id, t: 0, l: label, jt: c.job_title || null, s: ps, tier: ps != null ? scoreTier(ps) : null,
      a: ageDays(c.last_activity_at), co: inCo, dm, sig: sigOf.get(c.id) || [] });
    if (inCo) committee.get(inCo).push(c.id);
  }
  const dmById = new Map(nodes.filter(n => n.t === 0).map(n => [n.i, n.dm]));

  // company nodes + risk flags
  //
  // A COMPANY'S SCORE COMES FROM ITS PEOPLE.
  //
  // We score people, not companies — the ICP model reads a job title, a headcount, a
  // set of keywords, and it produces a number for a HUMAN. `companies.icp_score` is
  // therefore null on almost every row, and the graph was faithfully rendering that as
  // "never scored" on 300-odd companies that in fact have perfectly good scores sitting
  // on the people who work there. The grouping was correct and the data was upside down.
  //
  // The company's score is the BEST person at it. Not the average: you sell to an
  // account through its strongest thread, and one Tier 1 founder makes the account a
  // Tier 1 account regardless of how many junior contacts dilute the mean. A stored
  // company score, if one exists, is only the fallback.
  const scoreOf = new Map(nodes.filter(n => n.t === 0 && n.s != null).map(n => [n.i, n.s]));
  const single = [], budget = [];
  for (const c of touched) {
    const ppl = committee.get(c.id) || [];
    const best = ppl.reduce((m, pid) => {
      const v = scoreOf.get(pid);
      return v != null && (m == null || v > m) ? v : m;
    }, null);
    const s = best != null ? best : (c.icp_score != null ? Number(c.icp_score) : null);
    const isSingle = ppl.length === 1;
    const missBudget = ppl.length >= 1 && !ppl.some(pid => dmById.get(pid));
    if (isSingle) single.push(c.id);
    if (missBudget) budget.push(c.id);
    nodes.push({ i: c.id, t: 1, l: c.name || c.domain || null, d: c.domain || null, s, tier: s != null ? scoreTier(s) : null,
      a: ageDays(c.last_activity_at), pc: ppl.length, single: isSingle, budget: missBudget, look: s != null && s >= 85,
      sig: sigOf.get(c.id) || [] });
  }

  // PATTERNS — claim-derived, not keyword-frequency.
  //
  // This is the product's USP made visible: raw data -> background reasoning ->
  // CLAIMS -> semantic clusters of those claims. The worker (computePatterns.mjs)
  // clusters Intel-claim EMBEDDINGS across accounts and stores each cluster in
  // claim_patterns; we read the latest generation here. That is why "Lumora: seven-
  // tool stack, no unified view" and "Quillstone: region-specific stacks, no unified
  // view" collapse into ONE pattern (same meaning, zero shared keywords) instead
  // of the old exact-string match on extracted edge-labels, which surfaced
  // "software", "agency", and stray claim fragments as "patterns".
  //
  // A person carries the patterns their OWN claims fall into — claims are extracted
  // from that person's conversations, so the pattern belongs to them, and the person
  // is the only node you can actually act on. An account is rarely one pattern; the
  // interesting ones sit in an overlap nobody had noticed.
  const patRows = await supabase.from('graph_concepts')
    .select('label,type,entity_ids,claim_ids,generation')
    .eq('workspace_id', workspaceId)
    .order('generation', { ascending: false })
    .then(r => r.data || []);
  const latestGen = patRows.length ? patRows[0].generation : null;
  const nodeIds = new Set(nodes.filter(n => n.t === 0 || n.t === 1).map(n => n.i));
  // Revenue-substance beats commodity. "Everyone uses Clay" is a shallow tag; a
  // shared OBJECTION or PAIN is why a deal is won or lost. Rank the substantive
  // types first so the graph (and the panel's top hubs) lead with why-they-buy /
  // why-they-won't / what-they're-doing — not the stack everyone already has.
  const TYPE_RANK = { objection: 6, pain: 6, competitor: 5, play: 5, goal: 5, person: 4, connection: 4, authority: 4, budget: 4, timeline: 3, discovery: 3, preference: 2, channel: 2, status_quo: 1, tool: 1, segment: 1 };
  // A pattern grounded only in facts from email the viewer isn't on is not theirs (GET-253).
  const viewer = await requestMessageViewer(supabase, req, workspaceId);
  const latestPatRows = await filterByCitedClaimsForViewer(supabase, workspaceId,
    patRows.filter(p => p.generation === latestGen), viewer, (p) => p.claim_ids || []);
  const conceptRows = latestPatRows
    .map(p => ({ label: p.label, cat: p.type || 'theme', claimIds: p.claim_ids || [],
                 ids: (p.entity_ids || []).filter(id => nodeIds.has(id)) }))
    // Keep every pattern that touches at least one visible account. Claim patterns are
    // category-scoped and shown one lens at a time, so single-account patterns are the
    // point (they still group several of that account's claims) — no ≥2 filter.
    .filter(c => c.ids.length >= 1)
    .sort((a, b) => ((TYPE_RANK[b.cat] || 3) - (TYPE_RANK[a.cat] || 3)) || (b.ids.length - a.ids.length))
    .slice(0, 400);   // one lens shows one category's patterns, so allow the full set across all categories
  // `cat` carries the revenue TYPE (pain/tool/objection/…) so the hub colours itself
  // by what KIND of thing it is — the type is the action.
  const clusters = conceptRows.map(c => ({ label: c.label, cat: c.cat, ids: c.ids }));

  // EVIDENCE — the Obsidian "why is this linked" made visible. A concept node is the
  // abstraction; what grounds each account in it is the SPECIFIC thing that account
  // said. Pull the source-claim text so every account→concept membership carries the
  // account's own words (e.g. the pain "Fragmented account data" is grounded on Lumora
  // by "runs a seven-tool stack with no unified view").
  const allClaimIds = [...new Set(conceptRows.flatMap(c => c.claimIds))];
  const claimById = new Map();
  for (let i = 0; i < allClaimIds.length; i += 300) {
    const { data } = await supabase.from('claims').select('id,entity_id,property,value,supporting_observation_ids')
      .eq('workspace_id', workspaceId).in('id', allClaimIds.slice(i, i + 300));
    const readable = await filterDerivedForViewer(supabase, workspaceId, data || [], viewer);
    for (const c of readable) claimById.set(c.id, { entity: c.entity_id, content: c.value?.content || '' });
  }

  const patByEntity = new Map();
  for (const c of conceptRows) {
    const ev = new Map();   // entity_id -> its own claim text for THIS concept
    for (const cid of c.claimIds) {
      const cl = claimById.get(cid);
      if (cl && !ev.has(cl.entity)) ev.set(cl.entity, cl.content);
    }
    for (const id of c.ids) {
      if (!patByEntity.has(id)) patByEntity.set(id, []);
      patByEntity.get(id).push({ label: c.label, cat: c.cat, evidence: ev.get(id) || null });
    }
  }
  for (const n of nodes) {
    if (n.t !== 0 && n.t !== 1) continue;
    n.pat = patByEntity.get(n.i) || [];
  }

  const edges = [];
  for (const n of nodes) if (n.t === 0 && n.co) edges.push({ s: n.i, t: n.co, k: 0 });

  // Person↔person KNOWS/connection edges — the "who knows whom" layer, drawn in the
  // DEFAULT graph (k:3, no filter needed). If both ends are nodes we render, draw the
  // link. This is what makes a shared connection (e.g. a Marisol known by two of your
  // accounts) show up as a visible bridge between them, right on the default view.
  const personCompanyIds = new Set(nodes.filter(n => n.t === 0 || n.t === 1).map(n => n.i));
  const seenKnows = new Set();
  for (const g of gedges) {
    if (g.relationship !== 'KNOWS' || !g.object_id || g.subject_id === g.object_id) continue;
    if (!personCompanyIds.has(g.subject_id) || !personCompanyIds.has(g.object_id)) continue;
    const key = g.subject_id < g.object_id ? `${g.subject_id}|${g.object_id}` : `${g.object_id}|${g.subject_id}`;
    if (seenKnows.has(key)) continue;      // one line per pair, direction-agnostic
    seenKnows.add(key);
    edges.push({ s: g.subject_id, t: g.object_id, k: 3 });
  }

  clusters.forEach((cl, i) => {
    const node = `cl${i}`; cl.node = node;
    nodes.push({ i: node, t: 3, l: cl.label, sz: cl.ids.length, cat: cl.cat });
    for (const cid of cl.ids) edges.push({ s: cid, t: node, k: 2 });
  });

  return {
    nodes, edges,
    patterns: { single, budget, clusters: clusters.map(c => ({ label: c.label, ids: c.ids, node: c.node, cat: c.cat })) },
    meta: { people: contacts.length, companies: touched.length, clusters: clusters.length, ts: Date.now() },
  };
}

const workspaceOk = (req, res) => {
  const { workspaceId } = req.query;
  if (!workspaceId) { res.status(400).json({ error: 'workspace_id_required' }); return null; }
  if (!UUID.test(workspaceId)) { res.status(400).json({ error: 'invalid_workspace_id' }); return null; }
  if (req.workspaceId !== workspaceId) { res.status(403).json({ error: 'workspace_not_found_or_unauthorized' }); return null; }
  return workspaceId;
};

graphApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = workspaceOk(req, res); if (!workspaceId) return;
    return res.json(await buildNetwork(getSupabaseClient(), req, workspaceId));
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});


// GET /api/graph/context?workspaceId=&focus=&depth= — the context graph (GET-815): accounts, people,
// deals and the patterns they share as typed nodes and links, with nothing in the middle. With
// `focus`, only that node's neighbourhood to `depth` hops (1–3), for a local graph.
graphApiRouter.get('/context', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = workspaceOk(req, res); if (!workspaceId) return;
    const supabase = getSupabaseClient();
    const net = await buildNetwork(supabase, req, workspaceId);
    const accountIds = net.nodes.filter(n => n.t === 1).map(n => n.i);
    const personIds = net.nodes.filter(n => n.t === 0).map(n => n.i);
    const deals = [], stakes = [];
    let rosterStakes = false;   // the claims path brings each deal's people with it
    // The deals the Deals board shows: the flattened rows when the workspace has them, otherwise
    // the deals assembled from claims, as /api/companies/deals does. Reading only the rows drew no
    // deal at all on a workspace too small to have been flattened (GET-841).
    if (await hasListRows(supabase, workspaceId, 'deal')) {
      for (let i = 0; i < accountIds.length; i += 200) {
        deals.push(...await pageAll((from, to) => supabase.from('entity_list_rows')
          .select('entity_id, name, company_id, stage, status, pipeline_value, last_activity_at')
          .eq('workspace_id', workspaceId).eq('kind', 'deal').in('company_id', accountIds.slice(i, i + 200))
          .order('entity_id', { ascending: true }).range(from, to)));
      }
    } else {
      const drawn = new Set(accountIds);
      // Only the drawn accounts' deals: the filter runs before the company and contact lookups.
      for (const d of await listWorkspaceDeals(supabase, workspaceId, { windowed: true, visibleCompanyIds: drawn })) {
        deals.push({ entity_id: d.id, name: d.name, company_id: d.company_id, stage: d.stage, status: d.status, pipeline_value: d.value, last_activity_at: null });
        for (const pid of d.roster_ids) stakes.push({ from_entity_id: pid, to_entity_id: d.id });
      }
      rosterStakes = true;
    }
    // Every account has a deal by default: with no CRM deal behind it, its own, staged by its
    // people, exactly as the account page and the Sales Pipeline show it ("Acme deal · Demo · $450",
    // id 'account'). A workspace with no CRM drew no deal at all here (GET-844). Only an account that
    // left the ladder (lost, disqualified, churned) has none, as on the pipeline.
    const withCrmDeal = new Set(deals.map(d => d.company_id));
    const bare = accountIds.filter(id => !withCrmDeal.has(id));
    if (bare.length) {
      const [stagesBy, valueBy] = await Promise.all([
        personStagesForAccounts(supabase, workspaceId, bare),
        dealValueByCompany(supabase, bare),
      ]);
      const nameOf = new Map(net.nodes.filter(n => n.t === 1).map(n => [n.i, n.l]));
      const staffOf = new Map();
      for (const n of net.nodes) if (n.t === 0 && n.co) staffOf.set(n.co, [...(staffOf.get(n.co) ?? []), n.i]);
      for (const id of bare) {
        const stage = accountStage(stagesBy.get(id) ?? []) ?? 'identified';
        if (TERMINAL_STAGES.includes(stage)) continue;
        const dealId = `implied:${id}`;
        deals.push({ entity_id: dealId, name: impliedDealName(nameOf.get(id)), company_id: id,
          stage: STAGE_LABEL[stage] ?? stage, status: stage === 'closed_won' ? 'won' : 'open',
          pipeline_value: valueBy.get(id) ?? null, last_activity_at: null, implied: true });
        for (const pid of staffOf.get(id) ?? []) stakes.push({ from_entity_id: pid, to_entity_id: dealId });
      }
    }
    const dealIds = new Set(deals.filter(d => !d.implied).map(d => d.entity_id));
    for (let i = 0; i < personIds.length && dealIds.size && !rosterStakes; i += 200) {
      stakes.push(...(await pageAll((from, to) => supabase.from('relationships')
        .select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'stakeholder_of').is('valid_to', null)
        .in('from_entity_id', personIds.slice(i, i + 200))
        .order('from_entity_id', { ascending: true }).range(from, to))).filter(r => dealIds.has(r.to_entity_id)));
    }
    const graph = contextGraph(net, deals, stakes);
    const focus = typeof req.query.focus === 'string' && req.query.focus ? req.query.focus : null;
    const depth = Math.min(3, Math.max(1, Number(req.query.depth) || 1));
    return res.json(focus ? { ...neighbourhood(graph, focus, depth), focus, depth } : graph);
  } catch (err) {
    console.error('[GET /api/graph/context]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/graph/committee?workspaceId=&accountId= — who has to be convinced at ONE account.
//
// The network view draws every account at once and is unreadable (GET-392). This draws one, and
// it is the first place the meeting and Gmail extraction becomes visible: the roles are exactly
// what those passes produced, and they have been sitting under tens of thousands of employment edges.
//
// The people come from the account's own roster. The roles are badges from the semantic edges,
// the person-to-person edges are the only lines, and the list is ranked and capped because one
// One customer account has hundreds of people on it. `total` is returned so the page can say what it hid.
graphApiRouter.get('/committee', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, accountId } = req.query;
    if (!workspaceId || !UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    // No account named: answer "which accounts HAVE a committee" instead. A small share of one customer's
    // ten thousand do, so a picker is the only way anyone finds them — hunting for the needle by
    // searching ten thousand accounts is not a feature.
    if (!accountId) {
      const roleEdges = await pageAll((from, to) => supabase
        .from('workspace_graph_edges').select('subject_id, relationship')
        .eq('workspace_id', workspaceId).not('subject_id', 'is', null)
        .in('relationship', [...ROLE_EDGES])
        .order('subject_id', { ascending: true }).range(from, to));
      const subjects = [...new Set(roleEdges.map(e => e.subject_id))];
      if (!subjects.length) return res.json({ accounts: [] });

      const byCompany = new Map();
      for (let i = 0; i < subjects.length; i += 200) {
        const links = await pageAll((from, to) => supabase
          .from('relationships').select('from_entity_id, to_entity_id')
          .eq('workspace_id', workspaceId).eq('type', 'works_at').is('valid_to', null)
          .in('from_entity_id', subjects.slice(i, i + 200))
          .order('from_entity_id', { ascending: true }).range(from, to));
        for (const l of links) {
          if (!byCompany.has(l.to_entity_id)) byCompany.set(l.to_entity_id, new Set());
          byCompany.get(l.to_entity_id).add(l.from_entity_id);
        }
      }
      const ids = [...byCompany.keys()];
      const named = [];
      for (let i = 0; i < ids.length; i += 200) {
        named.push(...await pageAll((from, to) => supabase
          .from('entity_list_rows').select('entity_id, name, people_count')
          .eq('workspace_id', workspaceId).eq('kind', 'account').in('entity_id', ids.slice(i, i + 200))
          .order('entity_id', { ascending: true }).range(from, to)));
      }
      const accounts = named
        .map(a => ({ id: a.entity_id, name: a.name, roles: byCompany.get(a.entity_id)?.size ?? 0, people: a.people_count ?? 0 }))
        // Most labelled people first: those are the accounts where this view has something to say.
        .sort((x, y) => y.roles - x.roles || y.people - x.people || String(x.name ?? '').localeCompare(String(y.name ?? '')));
      return res.json({ accounts });
    }
    if (!UUID.test(accountId)) return res.status(400).json({ error: 'invalid_account_id' });

    // Employment, not the deal roster: a deal carries barely more than one person on average here, and the
    // committee is bigger than whoever happens to be named on the record.
    const staff = await pageAll((from, to) => supabase
      .from('relationships').select('from_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').eq('to_entity_id', accountId)
      .is('valid_to', null).order('from_entity_id', { ascending: true }).range(from, to));
    const personIds = [...new Set(staff.map(r => r.from_entity_id).filter(Boolean))];

    const account = (await supabase.from('entity_list_rows')
      .select('entity_id, name, domain')
      .eq('workspace_id', workspaceId).eq('kind', 'account').eq('entity_id', accountId)
      .maybeSingle()).data ?? null;

    if (!personIds.length) {
      return res.json({ account, nodes: [], edges: [], total: 0, shown: 0 });
    }

    // Names and recency from the flattened rows; roles and lines from the semantic edges. Both
    // chunked at 200 — a longer `.in()` builds a URL PostgREST rejects.
    const rows = [], edges = [], onDeals = [];
    for (let i = 0; i < personIds.length; i += 200) {
      const chunk = personIds.slice(i, i + 200);
      const [r, e, d] = await Promise.all([
        pageAll((from, to) => supabase.from('entity_list_rows')
          .select('entity_id, name, job_title, last_activity_at')
          .eq('workspace_id', workspaceId).eq('kind', 'person').in('entity_id', chunk)
          .order('entity_id', { ascending: true }).range(from, to)),
        pageAll((from, to) => supabase.from('workspace_graph_edges')
          .select('subject_id, object_id, object_label, relationship')
          .eq('workspace_id', workspaceId).in('subject_id', chunk)
          .order('subject_id', { ascending: true }).range(from, to)),
        pageAll((from, to) => supabase.from('relationships')
          .select('from_entity_id')
          .eq('workspace_id', workspaceId).eq('type', 'stakeholder_of').is('valid_to', null)
          .in('from_entity_id', chunk).order('from_entity_id', { ascending: true }).range(from, to)),
      ]);
      rows.push(...r); edges.push(...e); onDeals.push(...d);
    }

    const rolesByPerson = new Map();
    for (const e of edges) {
      if (!ROLE_EDGES.has(e.relationship) || !e.subject_id) continue;
      // A role is scoped to a company. Keep it when it names THIS account, and also when the
      // object never resolved — over a third of edge objects do not, and dropping those would throw away
      // most of what the extraction found rather than admit we cannot place it.
      if (e.object_id && e.object_id !== accountId) continue;
      if (!rolesByPerson.has(e.subject_id)) rolesByPerson.set(e.subject_id, new Set());
      rolesByPerson.get(e.subject_id).add(e.relationship);
    }

    const people = rows.map(x => ({
      id: x.entity_id, name: x.name, jobTitle: x.job_title, lastActivityAt: x.last_activity_at,
    }));
    const ranked = rankCommittee(people, rolesByPerson, new Set(onDeals.map(d => d.from_entity_id)));
    const visible = new Set(ranked.people.map(p => p.id));

    // Emitted in the SAME node contract the network view uses, so the canvas engine draws this
    // without knowing it is a different view. `dm` already earns a gold ring, `sig` already feeds
    // the panel's grouping, filtering and counts — so the roles become filterable for free rather
    // than by teaching a 1,278-line renderer a new encoding it could get wrong.
    const ageDays = (iso) => {
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86_400_000)) : null;
    };
    const nodes = [
      { i: accountId, t: 1, l: account?.name ?? account?.domain ?? 'Account',
        pc: ranked.total, s: null, tier: null, a: null, sig: [] },
      ...ranked.people.map(p => ({
        i: p.id, t: 0, l: p.name, jt: p.jobTitle ?? null,
        s: null, tier: null, a: ageDays(p.lastActivityAt), co: accountId,
        dm: p.roles.includes('DECISION_MAKER_AT'),
        sig: p.roles,
      })),
    ];
    const graphEdges = [
      // Everyone on screen belongs to the account in the middle.
      ...ranked.people.map(p => ({ s: p.id, t: accountId, k: 0 })),
      // …and the person-to-person lines, which are the only ones that say anything.
      ...committeeEdges(edges, visible).map(e => ({ s: e.from, t: e.to, k: 3, rel: e.type })),
    ];

    return res.json({
      account, nodes, edges: graphEdges,
      total: ranked.total, shown: ranked.shown,
      meta: { people: ranked.shown, companies: 1, clusters: 0, ts: Date.now() },
    });
  } catch (err) {
    console.error('[GET /api/graph/committee]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/graph/claims?workspaceId= — what we have learned, for the Claims view (GET-474).
//
// The network says who we know; this says what they told us. Every intel claim the calls, emails
// and messages produced (a pain, a goal, an objection, the tools they use, a budget, a timeline…)
// with the account it is about: a person's claim rolls up to the company they work at. Profile
// fields (names, titles, domains) and meeting-note records are not learnings and are left out.
// Claims from a message the viewer is not on are dropped, as everywhere else (GET-253).
const LEARNED = {
  pain: 'pain', 'pain points': 'pain', goal: 'goal', goals: 'goal', objection: 'objection', objections: 'objection',
  status_quo: 'status_quo', 'current tools': 'status_quo', buying_signal: 'buying_signal', budget: 'budget',
  procurement: 'budget', timeline: 'timeline', authority: 'authority', competitor: 'competitor', competitors: 'competitor',
  preference: 'preference', preferences: 'preference', discovery: 'discovery', relationship: 'relationship', relationships: 'relationship',
};
const CLAIMS_CAP = 3000;

graphApiRouter.get('/claims', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const rows = [];
    for (let from = 0; rows.length < CLAIMS_CAP; from += 1000) {
      const { data, error } = await supabase.from('claims')
        .select('id, entity_id, property, value, confidence, valid_from, supporting_observation_ids')
        .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
        .order('valid_from', { ascending: false }).range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const internal = new Set(await getInternalEntityIds(supabase, workspaceId));
    const learned = rows
      .map(r => ({ r, cat: LEARNED[String(r.value?.category ?? '').trim().toLowerCase()] }))
      .filter(x => x.cat && !internal.has(x.r.entity_id) && String(x.r.value?.content ?? '').trim().length >= 8);
    const viewer = await requestMessageViewer(supabase, req, workspaceId);
    // Every fact is the team's; a quote from a message this viewer can't open comes back stripped (GET-985).
    const shown = await filterDerivedForViewer(supabase, workspaceId, learned.map(x => x.r), viewer);
    const visible = learned.map((x, i) => ({ ...x, r: shown[i] ?? x.r }));

    // Who each claim is about: the account, or the person's employer when it is about a person.
    const list = new Map();
    const readRows = async (ids) => {
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('entity_list_rows').select('entity_id, kind, name, domain, company_id')
          .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 200));
        if (error) throw error;
        for (const x of data || []) if (!list.has(x.entity_id) || x.kind !== 'deal') list.set(x.entity_id, x);
      }
    };
    await readRows([...new Set(visible.map(x => x.r.entity_id))]);
    await readRows([...new Set([...list.values()].map(x => x.company_id).filter(id => id && !list.has(id)))]);

    const accounts = new Map();
    const claims = [];
    for (const { r, cat } of visible) {
      const who = list.get(r.entity_id);
      if (!who || who.kind === 'workspace') continue;
      const company = who.kind === 'person' && who.company_id ? list.get(who.company_id) : null;
      const acc = company ?? who;
      const accKind = acc.kind === 'person' ? 'person' : 'account';
      if (!accounts.has(acc.entity_id)) accounts.set(acc.entity_id, { id: acc.entity_id, kind: accKind, name: acc.name || acc.domain || 'Unnamed' });
      const meta = r.value?.metadata ?? {};
      claims.push({
        id: r.id, account: acc.entity_id, cat,
        text: String(r.value.content).trim().slice(0, 400),
        person: company ? (who.name || null) : null,
        // The person it is about, and how sure we are (0–1): the record panel lists a person's own
        // claims with their confidence (GET-840).
        pid: company ? r.entity_id : null,
        conf: r.confidence != null ? Number(r.confidence) : null,
        at: r.valid_from ? String(r.valid_from).slice(0, 10) : null,
        source: meta.extraction_source || meta.source_system || r.value?.source || null,
      });
    }
    return res.json({ accounts: [...accounts.values()], claims });
  } catch (err) {
    console.error('[GET /api/graph/claims]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
