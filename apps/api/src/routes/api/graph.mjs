import { Router } from 'express';
import { getSupabaseClient, scoreTier } from '@nous/core';
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

    const [contacts, companies, rels, gedges] = await Promise.all([
      pageAll((a, b) => supabase.from('contacts')
        .select('id,first_name,last_name,job_title,icp_score,last_activity_at').eq('workspace_id', workspaceId).range(a, b)),
      pageAll((a, b) => supabase.from('companies')
        .select('id,name,domain,icp_score,last_activity_at').eq('workspace_id', workspaceId).range(a, b)),
      supabase.from('relationships').select('from_entity_id,to_entity_id').eq('workspace_id', workspaceId)
        .eq('type', 'works_at').is('valid_to', null).then(r => r.data || []),
      supabase.from('workspace_graph_edges').select('subject_id,object_id,object_label,relationship')
        .eq('workspace_id', workspaceId).not('subject_id', 'is', null).then(r => r.data || []),
    ]);

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

    // shared-claim clusters: non-generic claim shared by 2+ touched companies
    const tmap = new Map();
    // Who SAID it, not just where they work. A claim extracted from a person's own
    // conversation belongs to that person. Rolling every claim up to the company and then
    // handing it back down to everyone who works there is how one founder saying "we run
    // Clay and Claude Code" turns into four colleagues who all appear to have said it —
    // and how the overlap you were looking for gets flattened into a company-wide smear.
    const subjClaims = new Map();   // entityId (person OR company) -> Set(label)
    for (const g of gedges) {
      if (g.object_id || !g.object_label) continue;
      if (STOP.has(g.object_label.toLowerCase())) continue;
      let co = null;
      if (contactIds.has(g.subject_id)) co = contactCompany.get(g.subject_id);
      else if (companyIds.has(g.subject_id)) co = g.subject_id;
      if (!companyIds.has(co)) continue;
      if (!subjClaims.has(g.subject_id)) subjClaims.set(g.subject_id, new Set());
      subjClaims.get(g.subject_id).add(g.object_label);
      if (!tmap.has(g.object_label)) tmap.set(g.object_label, new Set());
      tmap.get(g.object_label).add(co);
    }
    const clusters = [...tmap.entries()].filter(([, s]) => s.size >= 2)
      .map(([label, s]) => ({ label, ids: [...s], cat: classifyClaim(label) })).sort((a, b) => b.ids.length - a.ids.length).slice(0, 16);
    // append normalized-industry segment clusters (accounts sharing a canonical segment)
    for (const [seg, set] of segMap) if (set.size >= 2) clusters.push({ label: seg, ids: [...set], cat: 'segment' });

    // PATTERNS on the account.
    //
    // A cluster is a claim two or more companies share — a tool in the stack, a pain, an
    // initiative, a segment. The graph already draws them as their own layer, but you
    // could not GROUP by them, and grouping is where they become useful: an account is
    // rarely one pattern, it is the intersection of several, and the interesting accounts
    // are the ones sitting in an overlap nobody had noticed.
    //
    // People inherit their employer's patterns. The claims were extracted from the
    // company's conversations and the person is who you talk to about them, so scoring
    // the pattern to the company and then hiding it from the person would put the
    // insight one hop away from the only node you can actually act on.
    // Only claims that at least two companies share are patterns. A claim one account
    // carries alone is a fact about that account, not a pattern, and hubbing it would
    // give you a hub with one spoke.
    const catOf = new Map(clusters.map(cl => [cl.label, cl.cat]));

    for (const n of nodes) {
      if (n.t !== 0 && n.t !== 1) continue;
      const own = subjClaims.get(n.i);
      const labels = new Set();
      if (own) for (const l of own) if (catOf.has(l)) labels.add(l);
      // A person also carries whatever their COMPANY itself claims — a firmographic
      // (industry, segment) is a fact about the org, and the person is genuinely in it.
      // What they do NOT inherit is a colleague's claim.
      if (n.t === 0 && n.co) {
        const coOwn = subjClaims.get(n.co);
        if (coOwn) for (const l of coOwn) if (catOf.has(l)) labels.add(l);
      }
      // The industry-derived segment cluster is keyed on the company, so pull it down too.
      n.pat = [...labels].map(l => ({ label: l, cat: catOf.get(l) }));
    }
    // Segment clusters come from the company's `industry` claim, which lives on the
    // company row rather than in the edge table — attach them by company.
    for (const cl of clusters) {
      if (cl.cat !== 'segment') continue;
      const ids = new Set(cl.ids);
      for (const n of nodes) {
        const co = n.t === 1 ? n.i : n.t === 0 ? n.co : null;
        if (!co || !ids.has(co)) continue;
        if (!n.pat.some(p => p.label === cl.label)) n.pat.push({ label: cl.label, cat: 'segment' });
      }
    }

    const edges = [];
    for (const n of nodes) if (n.t === 0 && n.co) edges.push({ s: n.i, t: n.co, k: 0 });
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
