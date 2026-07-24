import { Router } from 'express';
import { getSupabaseClient, scoreTier, getInternalEntityIds } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

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
const STACK = new Set('clay instantly zapier make n8n hubspot salesforce notion slack apollo smartly render claude linkedin gmail outlook lemlist heyreach unipile airtable sheets google chatgpt openai gpt nous proply effigy runwave splink freepik marquee dosobe sawify antifragile master'.split(' '));
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

graphApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const [contactsRaw, companies, rels, gedges, internalIds] = await Promise.all([
      pageAll((a, b) => supabase.from('contacts')
        .select('id,first_name,last_name,job_title,icp_score,last_activity_at').eq('workspace_id', workspaceId).range(a, b)),
      pageAll((a, b) => supabase.from('companies')
        .select('id,name,domain,icp_score,last_activity_at').eq('workspace_id', workspaceId).range(a, b)),
      supabase.from('relationships').select('from_entity_id,to_entity_id').eq('workspace_id', workspaceId)
        .eq('type', 'works_at').is('valid_to', null).then(r => r.data || []),
      supabase.from('workspace_graph_edges').select('subject_id,object_id,object_label,relationship')
        .eq('workspace_id', workspaceId).not('subject_id', 'is', null).then(r => r.data || []),
      getInternalEntityIds(supabase, workspaceId),
    ]);
    // Team members (teammates flagged is_internal) are NOT accounts — a co-founder or
    // colleague must never appear in the context graph as a prospect. Drop them up
    // front so they vanish from nodes, committees, and every concept they'd anchor.
    const contacts = contactsRaw.filter(c => !internalIds.has(c.id));

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
      nodes.push({ i: c.id, t: 1, l: c.name || c.domain || null, s, tier: s != null ? scoreTier(s) : null,
        a: ageDays(c.last_activity_at), pc: ppl.length, single: isSingle, budget: missBudget, look: s != null && s >= 85,
        sig: sigOf.get(c.id) || [] });
    }

    // PATTERNS — claim-derived, not keyword-frequency.
    //
    // This is the product's USP made visible: raw data -> background reasoning ->
    // CLAIMS -> semantic clusters of those claims. The worker (computePatterns.mjs)
    // clusters Intel-claim EMBEDDINGS across accounts and stores each cluster in
    // claim_patterns; we read the latest generation here. That is why "Ramp: seven-
    // tool stack, no unified view" and "Deel: region-specific stacks, no unified
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
    const TYPE_RANK = { objection: 6, pain: 6, competitor: 5, play: 5, person: 4, connection: 4, channel: 2, tool: 1, segment: 1 };
    const conceptRows = patRows
      .filter(p => p.generation === latestGen)
      .map(p => ({ label: p.label, cat: p.type || 'theme', claimIds: p.claim_ids || [],
                   ids: (p.entity_ids || []).filter(id => nodeIds.has(id)) }))
      .filter(c => c.ids.length >= 2)
      .sort((a, b) => ((TYPE_RANK[b.cat] || 3) - (TYPE_RANK[a.cat] || 3)) || (b.ids.length - a.ids.length))
      .slice(0, 28);   // concepts are finer than the old whole-claim clusters, so allow more hubs
    // `cat` carries the revenue TYPE (pain/tool/objection/…) so the hub colours itself
    // by what KIND of thing it is — the type is the action.
    const clusters = conceptRows.map(c => ({ label: c.label, cat: c.cat, ids: c.ids }));

    // EVIDENCE — the Obsidian "why is this linked" made visible. A concept node is the
    // abstraction; what grounds each account in it is the SPECIFIC thing that account
    // said. Pull the source-claim text so every account→concept membership carries the
    // account's own words (e.g. the pain "Fragmented account data" is grounded on Ramp
    // by "runs a seven-tool stack with no unified view").
    const allClaimIds = [...new Set(conceptRows.flatMap(c => c.claimIds))];
    const claimById = new Map();
    for (let i = 0; i < allClaimIds.length; i += 300) {
      const { data } = await supabase.from('claims').select('id,entity_id,value').in('id', allClaimIds.slice(i, i + 300));
      for (const c of (data || [])) claimById.set(c.id, { entity: c.entity_id, content: c.value?.content || '' });
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
    // link. This is what makes a shared connection (e.g. a Georgi known by two of your
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

    return res.json({
      nodes, edges,
      patterns: { single, budget, clusters: clusters.map(c => ({ label: c.label, ids: c.ids, node: c.node, cat: c.cat })) },
      meta: { people: contacts.length, companies: touched.length, clusters: clusters.length, ts: Date.now() },
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
