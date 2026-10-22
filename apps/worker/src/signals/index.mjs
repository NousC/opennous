// Signal extraction pipeline — ported from an earlier internal prototype.
// After every qualifying private activity (LinkedIn message, email reply, meeting, Slack DM),
// Claude Haiku extracts structured CRM facts → `note.*` claims on the contact entity.
// Graph edges (REPORTS_TO, BUDGET_HOLDER_AT, etc.) extracted from each fact → workspace_graph_edges.

import { teamReadContext, writesTasks, isTimeBound, retireNote, claimAboutFor } from '@nous/core';
import { extractionCriteria } from '../lib/extractionCriteria.mjs';
import { mayReadWorkspace } from '../lib/creditGate.mjs';
import { setUser } from 'useleak';
import { createMessage, pipelineModel, parseJsonArray, ModelUnavailableError } from '../lib/llm.mjs';
import { loadDerivedSources, derivedAudienceKey, saveAboutUsClaims, isPrivateMessageType } from '@nous/core';
import { listNotes, saveNote, corroborateNote, searchClaims, listActivities, recordObservation,
  isEntityInternal, linkPersonMention, resolvePersonMention, tagClaimMentions,
  normalizeClaimCategory, normalizeClaimAbout, claimCategoryPromptBlock, CLAIM_CATEGORY_KEYS, ACCOUNT_ROLLUP_CATEGORIES,
  resolveDuePhrase, dueDateAgreeingWith, getWorkspaceTimezone, activityDirection, claimSubtagsFor, claimFreeTextFor,
  violatesPronounRule, isTitleOnlyFact, TITLE_ONLY_REASON, emptyTaskProvenance, provenanceFromModel, dealForTask, companyOfContact, isIntelClaim } from '@nous/core';
import { extractCallInsights } from './insights.mjs';
import { recomputeEntityStage } from '../workers/stageDerivation.mjs';
import { scheduleCompanySummary } from './companySummary.mjs';
import { runIntentScoring } from '../intentScore.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';
import { recordPipelineEvent } from '../lib/pipelineEvents.mjs';
import { read, parseArray, acceptsArray, parseProse, acceptsProse } from '../noema/read.mjs';
import { groundFacts, spokenByOurSide } from '../noema/grounding.mjs';
import { externalEvidence } from '../noema/externalEvidence.mjs';
import { splitForExtraction, halveForRetry, loadOurSide, ourSideLabel, ourSideRule, tidyFactContent, ourOfferBlock, factWording } from './extractionText.mjs';


// Activity types that warrant signal extraction — private, content-rich interactions only.
// Both LinkedIn reply spellings are here on purpose. The handlers emit
// 'linkedin_message' and 'linkedin_replied', but a run of webhooks in June 2026
// wrote 'linkedin_reply', and those rows were silently never extracted because
// nothing matched them. Two rows, so nothing was really lost — but the failure was
// invisible, which is the part that matters. `contacts.mjs` already accepts both;
// so does this now. Same for the bare 'reply'/'positive_reply' the lead-list
// trigger writes.
export const SIGNAL_WORTHY_TYPES = new Set([
  'slack_dm', 'slack_message',
  'email_reply', 'email_received',
  'linkedin_message', 'linkedin_replied', 'linkedin_reply',
  'reply', 'positive_reply',
  'meeting_held',
]);

// Noise patterns — generic messages with no extractable intelligence.
const SIGNAL_NOISE = [
  /has joined the channel/i,
  /has left the channel/i,
  /has accepted your invitation/i,
  /take a second to say hello/i,
  /set the channel topic/i,
];

/**
 * Why a source would not be extracted, or null when it would. The live hook and the
 * backlog backfill both ask this, so a source the backfill picks up is one live ingest
 * would have read.
 */
export function extractionSkipReason({ type, text }) {
  if (!SIGNAL_WORTHY_TYPES.has(type)) return `type ${type} is not extracted`;
  if (!text || text.length < 20) return 'under 20 characters';
  if (SIGNAL_NOISE.some(p => p.test(text))) return 'system notice';
  return null;
}

// ── Note dedup ────────────────────────────────────────────────────────────────
// Semantic search across `note.*` claims via the v2 search_claims RPC.
// Embeddings are filled in by the embeddings worker; if none yet, we degrade
// to no-dedup (always ADD), which is safe but slightly noisier.

// How many times in this process the duplicate check could not run. Read by the backfill so a run
// reports "41 claims, 4 of them unchecked for duplicates" rather than just "41 claims".
export let dedupFailures = 0;
export const resetDedupFailures = () => { dedupFailures = 0; };

// 0.82, not 0.88: at 0.88 only near-verbatim copies were ever compared, so the same fact heard on
// the next call in other words ("Orders Routed To Quillbox" / "Quillbox Order Queue") was filed
// again — several times on one account. The model still makes the call; this only decides what it sees.
const NOTE_DEDUP_THRESHOLD = 0.82;

async function searchSimilarNotes(supabase, workspaceId, query, threshold = NOTE_DEDUP_THRESHOLD, limit = 5, entityId = null) {
  // Restrict to note.* claims in SQL — dedup only compares against notes, and
  // scoping the candidate set keeps the search fast (hundreds of notes, not
  // tens of thousands of claims) and high-recall (the global nearest claims are
  // usually signals/features, not notes).
  // Dedup degrading to "always ADD" is safe for the data and invisible in the output, which is the
  // worst combination: duplicates accumulate and nothing says why. Counted here so a run can.
  let failed = null;
  const hits = await searchClaims(supabase, workspaceId, query, {
    threshold, limit: limit * 3, propertyPrefix: 'note.', entityId,
    onFailure: (reason) => { failed = reason; },
  });
  if (failed) {
    dedupFailures++;
    console.warn(`[NOTE_DEDUP_BLIND] search failed (${failed}) — this fact is being ADDED without a duplicate check`);
  }
  return hits
    .filter(h => h.property?.startsWith('note.'))
    // A new fact is not a duplicate of the health read's paragraph or a speaker-link note; those are
    // not facts (GET-417). Matching against them silently dropped real facts as "already said".
    .filter(h => isIntelClaim(h.value))
    .slice(0, limit)
    .map(h => ({ id: h.id, content: (h.value && h.value.content) || '', row: h }))
    .filter(m => m.content);
}

// A NEWER STATEMENT RETIRES THE ONE IT REPLACES (GET-770).
//
// The merge used to see only look-alikes (cosine ≥ 0.82) and no dates. A contradiction is not a
// look-alike — "needs another couple of months" and "now I want to present it to the other
// stakeholders" share almost no words — so on one real account the two never met, and the September
// position kept reading as current. For a time-bound category (claimTime.ts) the fact now also
// meets every live claim of its category on the same record, both sides dated, and the model can
// answer SUPERSEDE. Standing facts ("found us on Hacker News") still meet only their look-alikes.

const SAME_CATEGORY_CANDIDATES = 6;
const MAX_CANDIDATES = 10;

// A SURE REPEAT IS SETTLED BY CODE (GET-961). The model was asked "new or repeat?" for every fact
// with a look-alike, and on one account it answered "new" to the same fact from the same email thread
// eleven times. A look-alike this close, in the same category, is the same fact: measured on that
// account, known copies sat at a median of 0.94 and no two different facts reached 0.92. It is
// skipped (and corroborates the claim it repeats) without a model call. Below the bar, the model
// still decides.
export const SURE_REPEAT_SIMILARITY = 0.92;

/** The claim a new fact certainly repeats, or null when the model should decide. Pure. */
export function sureRepeat(category, candidates = []) {
  const cat = normalizeClaimCategory(category);
  const hit = candidates.find(c => c?.category === cat && Number(c?.row?.similarity) >= SURE_REPEAT_SIMILARITY);
  return hit?.id ?? null;
}

/** What a new fact is compared with: its look-alikes, plus — when its category is time-bound — the live claims of that category. Pure. */
export function mergeCandidates(category, similar = [], sameCategory = []) {
  if (!isTimeBound(category)) return similar.slice(0, MAX_CANDIDATES);
  const seen = new Set();
  const out = [];
  for (const c of [...similar, ...sameCategory]) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out.slice(0, MAX_CANDIDATES);
}

const day = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : 'date unknown');

/** The merge question, both sides dated. Pure. items: [{ fact, category, saidAt, candidates: [{ id, content, said_at, category }] }] */
export function buildMergePrompt(items) {
  const block = items.map((it, n) => {
    const existing = it.candidates.map(c => `   - [ID:${c.id}] (said ${day(c.said_at)}${c.category ? `, ${c.category}` : ''}) ${c.content}`).join('\n');
    return `${n + 1}. NEW FACT (said ${day(it.saidAt)}${it.category ? `, ${it.category}` : ''}): "${it.fact}"\n   EXISTING ON THE SAME RECORD:\n${existing}`;
  }).join('\n\n');
  return `You are managing an atomic fact memory store for a business workspace. Facts are dated by when they were SAID.

For EACH numbered new fact below, decide one of:
- ADD — distinct enough to keep alongside the existing facts
- SKIP:<ID> — it says the same thing as one existing fact (give that fact's ID); the new mention is added to it as evidence
- UPDATE:<ID> — it is a newer, more complete or corrected version of one existing fact
- SUPERSEDE:<ID> — the person's position MOVED: the new fact changes, contradicts or resolves one existing fact, so that one is no longer current. A plan that became a decision, a timeline that moved, an objection that was resolved, a budget freed or frozen, a competitor chosen or dropped, a deal paused or restarted.

A replacement can sit under a different topic: "ready to take it to the other stakeholders" (a buying signal) supersedes "needs this pace for another couple of months" (a timeline), "the product is not there yet" (an objection) and "still has internal decision-making to do" (a blocker) — the position they stood for has moved on. Two facts about DIFFERENT things never supersede each other, however close in time. Keep both (ADD). The older fact is kept as history either way; nothing is deleted.

${block}

Return ONLY a JSON array, one entry per numbered fact, in order:
[{"n":1,"decision":"ADD"},{"n":2,"decision":"SKIP:<uuid>"},{"n":3,"decision":"SUPERSEDE:<uuid>"}]`;
}

/**
 * The model's answers → decisions. Pure. An id the model was not offered is ignored. UPDATE and
 * SUPERSEDE both retire the claim they name — unless the "new" fact is the OLDER one (a backfill
 * reading June after October filed it): then it is filed already retired by the newer claim.
 * contested: [{ idx, saidAt, candidates: [{ id, said_at }] }]
 */
export function parseMergeDecisions(rows, contested, total) {
  const decisions = Array.from({ length: total }, () => ({ action: 'ADD', supersedes: null }));
  for (const row of rows ?? []) {
    const n = Number(row?.n);
    if (!Number.isInteger(n) || n < 1 || n > contested.length) continue;
    const { idx, saidAt, candidates } = contested[n - 1];
    const decision = String(row?.decision ?? 'ADD').trim();
    const [verb, rawId] = decision.split(':');
    const id = rawId?.trim() || null;
    const offered = id ? candidates.find(c => c.id === id) : null;
    if (verb === 'SKIP') {
      decisions[idx] = { action: 'SKIP', supersedes: null, restates: offered ? id : null };
    } else if ((verb === 'UPDATE' || verb === 'SUPERSEDE') && offered) {
      const newer = Date.parse(saidAt ?? '') || 0;
      const older = Date.parse(offered.said_at ?? '') || 0;
      // No date on the new fact: it may be the older one, so it retires nothing.
      if (!newer) continue;
      decisions[idx] = older && newer < older
        ? { action: 'ADD', supersedes: null, retiredBy: id }
        : { action: 'SUPERSEDE', supersedes: id };
    }
  }
  return decisions;
}

// The deal's moving parts replace each other across categories (GET-795): "ready to take it to
// the other stakeholders" (buying_signal) is what retires "needs another couple of months"
// (timeline), "not there yet" (objection) and "still deciding internally" (blocker).
const DEAL_TOPICS = ['buying_signal', 'timeline', 'objection', 'blocker', 'budget', 'requirement'];

/** The categories a new fact of this category is compared with. Pure. */
export function relatedCategories(category) {
  return DEAL_TOPICS.includes(category) ? DEAL_TOPICS : [category];
}

/** From a record's notes: live intel in the related categories, newest-said first, capped. Pure. */
export function pickTopicCandidates(notes, category, limit = SAME_CATEGORY_CANDIDATES) {
  const cats = new Set(relatedCategories(category));
  return (notes ?? [])
    .filter(n => n && n.intel !== false && !n.metadata?.doc_type && cats.has(n.category))
    .sort((a, b) => String(b.said_at ?? '').localeCompare(String(a.said_at ?? '')))
    .slice(0, limit)
    .map(n => ({ id: n.id, content: n.content, said_at: n.said_at, category: n.category, row: { id: n.id, value: { metadata: n.metadata }, supporting_observation_ids: n.supporting_observation_ids } }));
}

/** Live claims a time-bound fact is compared with: its topic, on the person AND their company. */
async function liveClaimsOfTopic(supabase, workspaceId, entityIds, category, cache) {
  const notes = [];
  for (const id of [...new Set((entityIds ?? []).filter(Boolean))]) {
    if (!cache.has(id)) {
      cache.set(id, listNotes(supabase, workspaceId, { entityId: id, limit: 150 }, teamReadContext(workspaceId)).catch(() => []));
    }
    notes.push(...await cache.get(id));
  }
  return pickTopicCandidates(notes, category, DEAL_TOPICS.includes(category) ? 8 : SAME_CATEGORY_CANDIDATES);
}

// One merge decision per FACT was one Haiku call per fact. A 12-fact transcript
// paid for twelve round trips to answer twelve variants of the same small
// question, and the facts from one conversation are exactly the set a model
// should see together anyway — two facts extracted from the same meeting are far
// more likely to duplicate each other than either is to duplicate something from
// March.
//
// So: one call for the whole batch. The vector search stays per fact (it is a
// Postgres query, it costs nothing), and only the judgement is batched.
//
// Facts with nothing to compare never reach the model at all — the answer is ADD without asking.
async function decideMergeBatch(supabase, workspaceId, factContents, factRows = [], targetEntities = [], factCategories = [], factSaidAts = [], factReplaces = [], factEntitySets = []) {
  const found = await Promise.all(
    factContents.map((f, i) => searchSimilarNotes(supabase, workspaceId, f, NOTE_DEDUP_THRESHOLD, 5, targetEntities[i] ?? null).catch(() => [])),
  );
  // The look-alikes come back undated (search_claims returns no valid_from); one batched read dates them.
  const undated = [...new Set(found.flat().map(c => c.id))];
  const saidAtById = new Map();
  if (undated.length) {
    const { data } = await supabase.from('claims').select('id, valid_from').eq('workspace_id', workspaceId).in('id', undated);
    for (const r of data ?? []) saidAtById.set(r.id, r.valid_from);
  }
  const cache = new Map();
  const merged = await Promise.all(factContents.map(async (_, i) => {
    const similar = found[i].map(c => ({ ...c, said_at: saidAtById.get(c.id) ?? null, category: normalizeClaimCategory(c.row?.value?.category) }));
    const sameCategory = isTimeBound(factCategories[i])
      ? await liveClaimsOfTopic(supabase, workspaceId, factEntitySets[i] ?? [targetEntities[i]], factCategories[i], cache)
      : [];
    return mergeCandidates(factCategories[i], similar, sameCategory);
  }));

  // A fact only merges with facts written for the same readers (GET-253). Facts are shared since
  // GET-985, but a fact's QUOTE still follows its sources: merged, a private message's quote would
  // sit on a row a shared source makes readable to everyone. So candidates for another audience
  // are not offered, and the extractor's "replaces" target is held to the same rule. The price is
  // that the team's fact and a private one can both stand, each with its own source.
  const replaceIds = [...new Set(factReplaces.filter(Boolean))];
  const replaceRows = new Map();
  if (replaceIds.length) {
    const { data } = await supabase.from('claims').select('id, value, supporting_observation_ids')
      .eq('workspace_id', workspaceId).in('id', replaceIds);
    for (const r of data ?? []) replaceRows.set(r.id, r);
  }
  let candidates = merged;
  const replacesOk = factContents.map((_, i) => !!(factReplaces[i] && replaceRows.has(factReplaces[i])));
  if (factRows.length) {
    const sources = await loadDerivedSources(supabase, workspaceId, [...factRows, ...merged.flat().map(c => c.row), ...replaceRows.values()]);
    candidates = merged.map((list, i) => {
      const key = derivedAudienceKey(factRows[i], sources);
      return list.filter(c => derivedAudienceKey(c.row, sources) === key);
    });
    factContents.forEach((_, i) => {
      if (replacesOk[i]) replacesOk[i] = derivedAudienceKey(replaceRows.get(factReplaces[i]), sources) === derivedAudienceKey(factRows[i], sources);
    });
  }
  const withReplaces = (ds) => ds.map((d, i) => ({ ...d, replacesOk: replacesOk[i] }));

  const sure = factContents.map((_, i) => sureRepeat(factCategories[i], candidates[i]));
  const settled = (ds) => ds.map((d, i) => (sure[i] ? { action: 'SKIP', supersedes: null, restates: sure[i] } : d));
  const contested = [];
  for (let i = 0; i < factContents.length; i++) {
    if (candidates[i].length > 0 && !sure[i]) contested.push({ idx: i, saidAt: factSaidAts[i] ?? null, candidates: candidates[i] });
  }
  if (contested.length === 0) return withReplaces(settled(factContents.map(() => ({ action: 'ADD', supersedes: null }))));

  const result = await read({
    supabase, workspaceId,
    feature: 'note-merge-decide',
    meterAs: 'signal-extraction',
    accept: acceptsArray,
    parse: parseArray,
    maxTokens: Math.min(800, 40 * contested.length + 60),
    prompt: buildMergePrompt(contested.map(c => ({
      fact: factContents[c.idx], category: factCategories[c.idx] ?? null, saidAt: c.saidAt, candidates: c.candidates,
    }))),
  });

  // A merge failure must never lose the fact, so every decision stays ADD: a duplicate note is
  // recoverable, a dropped one is not. The failure is a pipeline_events row (GET-320).
  if (!result.ok) {
    console.warn(`[NOTE_MERGE_BATCH] ${result.reason} — ${contested.length} contested fact(s) default to ADD`);
    return withReplaces(settled(factContents.map(() => ({ action: 'ADD', supersedes: null }))));
  }
  return withReplaces(settled(parseMergeDecisions(result.value, contested, factContents.length)));
}

// ── Graph edge extraction ─────────────────────────────────────────────────────

// Same fanout, same fix. This ran once per extracted fact, so a 12-fact meeting
// made twelve calls asking the model to find relationships in one sentence at a
// time — which is also the worst way to ask, because a relationship is often only
// visible ACROSS facts ("Sarah runs eng" + "Marcus signs off on Sarah's budget"
// is an edge; neither sentence alone is).
//
// One call for the batch. Each returned edge carries the index of the fact it
// came from, so the evidence chain back to the source note survives.
async function extractGraphEdgesBatch(supabase, workspaceId, facts, context = {}) {
  if (!facts.length) return;

  try {
    const contextHint = [
      context.contact_name ? `Subject: ${context.contact_name}` : null,
      context.company_name ? `Company: ${context.company_name}` : null,
    ].filter(Boolean).join(', ');

    const factBlock = facts.map((f, i) => `${i + 1}. "${f.content}"`).join('\n');

    const result = await read({
      supabase, workspaceId,
      feature: 'graph-edges-extract',
      meterAs: 'signal-extraction',
      accept: acceptsArray,
      parse: parseArray,
      maxTokens: Math.min(1500, 120 * facts.length + 100),
      prompt: `Extract relationship edges from these facts for a GTM knowledge graph. A relationship may span two facts.

Extract an edge in TWO cases:
1. Two named entities have a clear directional relationship (reports-to, owns budget, champions, competes with, uses).
2. The subject NAMES A SPECIFIC PERSON they are connected to — a shared or mutual connection, a friend, someone who introduced them, someone they mention knowing — even with no formal relationship. Use KNOWS, subject = the contact, object = the named person. This is what turns "he mentioned Ottoline" into a common-connection node in the graph, so DON'T skip a named person just because the tie is informal.

Only real, specific PEOPLE or ORGS — never a generic role, a topic, or a tool as a "known person".

FACTS:
${factBlock}${contextHint ? `\n\nCONTEXT: ${contextHint}` : ''}

Return a JSON array. Each edge, with "from" set to the number of the fact it came from:
{"from":1,"subject_label":"name","subject_type":"contact|company|product|competitor|topic","relationship":"REPORTS_TO|DEFERS_TO_TECHNICAL|DEFERS_TO_BUDGET|DECISION_MAKER_AT|BUDGET_HOLDER_AT|CHAMPIONS|BLOCKS|EVALUATING|USES|WORKS_WITH|KNOWS|CHURNED_FROM|COMPETES_WITH","object_label":"name","object_type":"contact|company|product|competitor|topic","confidence":"confirmed|likely"}

Set "confidence" to "confirmed" ONLY when a fact EXPLICITLY states the relationship (e.g. "reports to Sarah", "owns the budget", named on an org chart or in an email); use "likely" when it is inferred from titles, seniority, or indirect context.

Examples:
"Sarah defers to Marcus on technical decisions" → {"from":1,"subject_label":"Sarah","subject_type":"contact","relationship":"DEFERS_TO_TECHNICAL","object_label":"Marcus","object_type":"contact"}
"Jennifer controls the budget at TechFlow" → {"from":2,"subject_label":"Jennifer","subject_type":"contact","relationship":"BUDGET_HOLDER_AT","object_label":"TechFlow","object_type":"company"}
"Jack shares a mutual connection in Ottoline" → {"from":1,"subject_label":"Jack","subject_type":"contact","relationship":"KNOWS","object_label":"Ottoline","object_type":"contact"}
"Mentioned Q2 budget" → nothing

Return [] only if no entity relationship AND no named person anywhere. At most 4 edges per fact. ONLY valid JSON array, no other text.`,
    });
    // An unreadable answer is now a row in pipeline_events, not a bare `return` (GET-320). "No
    // edges here" and "we could not read the answer" were the same thing to this function, and the
    // second one left no trace at all.
    if (!result.ok) return;
    const edges = result.value;
    if (!edges.length) return;

    // Never let re-extraction overwrite a manually-set (confirmed) reporting line.
    const { data: manualEdges } = await supabase.from('workspace_graph_edges')
      .select('subject_label, relationship, object_label').eq('workspace_id', workspaceId).eq('source', 'manual');
    const manualKeys = new Set((manualEdges || []).map(e => `${e.subject_label}|${e.relationship}|${e.object_label}`.toLowerCase()));

    for (const edge of edges.slice(0, 4 * facts.length)) {
      if (!edge.subject_label || !edge.relationship || !edge.object_label) continue;
      if (manualKeys.has(`${edge.subject_label}|${edge.relationship}|${edge.object_label}`.toLowerCase())) continue;

      // Which fact produced this edge, so the edge still points back at the note
      // it was drawn from. An unattributable edge is one nobody can audit.
      const origin = facts[Number(edge.from) - 1] ?? facts[0];
      const sourceMemoryId = origin?.memoryId ?? null;
      const factContent    = origin?.content ?? '';

      let subjectId = null, objectId = null;

      if (edge.subject_type === 'contact') {
        // Labels come from the LLM (untrusted transcript). Strip PostgREST filter
        // metachars so a crafted label can't alter the .or() expression.
        const fn = edge.subject_label.split(' ')[0].replace(/[,()%*\\]/g, '');
        const label = edge.subject_label.toLowerCase().replace(/[,()%*\\]/g, '');
        const { data } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .or(`first_name.ilike.${fn},email.ilike.%${label}%`)
          .limit(1).maybeSingle();
        subjectId = data?.id ?? context.contact_id ?? null;
      } else if (edge.subject_type === 'company') {
        const { data } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).ilike('name', `%${edge.subject_label}%`).limit(1).maybeSingle();
        subjectId = data?.id ?? context.company_id ?? null;
      }

      if (edge.object_type === 'contact') {
        const fn = edge.object_label.split(' ')[0].replace(/[,()%*\\]/g, '');
        const label = edge.object_label.toLowerCase().replace(/[,()%*\\]/g, '');
        const { data } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .or(`first_name.ilike.${fn},email.ilike.%${label}%`)
          .limit(1).maybeSingle();
        objectId = data?.id ?? null;
      } else if (edge.object_type === 'company') {
        const { data } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).ilike('name', `%${edge.object_label}%`).limit(1).maybeSingle();
        objectId = data?.id ?? context.company_id ?? null;
      }

      // Confirmed = the fact explicitly stated it; Likely = inferred. Drives the solid vs
      // dashed reporting line + the confidence badge on the org chart.
      const level = String(edge.confidence).toLowerCase() === 'confirmed' ? 'confirmed' : 'likely';
      await supabase.from('workspace_graph_edges').upsert({
        workspace_id:     workspaceId,
        subject_type:     edge.subject_type || 'contact',
        subject_id:       subjectId,
        subject_label:    edge.subject_label,
        relationship:     edge.relationship,
        object_type:      edge.object_type || 'contact',
        object_id:        objectId,
        object_label:     edge.object_label,
        source:           context.source || 'extraction',
        source_memory_id: sourceMemoryId ?? null,
        confidence:       level === 'confirmed' ? 0.95 : 0.6,
        metadata:         { fact: factContent.slice(0, 200), confidence_level: level },
      }, { onConflict: 'workspace_id,subject_label,relationship,object_label', ignoreDuplicates: false });
    }

    if (edges.length > 0) console.log(`[GRAPH_EXTRACT] ${edges.length} edges — workspace ${workspaceId}`);
  } catch (err) {
    console.warn('[GRAPH_EXTRACT_ERROR]', err.message);
  }
}

// ── Subject resolution ────────────────────────────────────────────────────────
//
// Every LLM pass below writes prose ABOUT a person, and every one of them needs
// that person's name before it can say anything true. The obvious place to read
// it — the `contacts` view — is the one place that cannot be trusted here.
//
// `contacts` is a PROJECTION over `claims`, and claims are not written on insert:
// an observation fires a trigger that enqueues a claim_job, and claimEngine.mjs
// drains that queue on a cron that ticks once a minute. These extractors, by
// contrast, fire setImmediate off the observation write. So for a contact created
// moments ago there is a window — up to a full minute — where the view answers
// with nulls for a person whose name we demonstrably already have.
//
// That window cost us a real record. An inbound LinkedIn pitch landed at
// 17:38:51; extraction ran at 17:38:54 and read a nameless contact; the name
// claim appeared at 17:39:00. Told to extract facts "about the contact" and
// ordered by the prompt to name its subject explicitly, the model reached for the
// only proper noun in the payload — the greeting — and filed the sender's own
// pitch as facts about the person she was pitching.
//
// So: read the view, then fill every gap from the OBSERVATIONS the ingest wrote
// synchronously moments ago. Same facts, no projection lag. Retry briefly for the
// case where the name observation is itself still in flight, and return null
// rather than a placeholder when there is genuinely no name — a CRM fact that
// cannot name its subject is not worth the tokens, and is worse than none.

// `summary_generated_at` is in here for the debounce, not the subject: it is
// projected through the same lagging view, so without the gap-fill a brand-new
// contact reads it as null and gets summarised twice inside the 30-minute window.
const SUBJECT_FIELDS = ['first_name', 'last_name', 'full_name', 'email', 'company', 'pipeline_stage', 'summary_generated_at'];
const SUBJECT_RETRIES  = 3;
const SUBJECT_RETRY_MS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readSubjectObservations(supabase, contactId) {
  const { data } = await supabase.from('observations')
    .select('property, value, observed_at')
    .eq('entity_id', contactId)
    .in('property', SUBJECT_FIELDS)
    .order('observed_at', { ascending: false });
  const out = {};
  for (const o of data ?? []) {
    // Ordered newest-first, so the first value seen for a property wins.
    if (out[o.property] !== undefined) continue;
    const v = typeof o.value === 'string' ? o.value : o.value?.value;
    if (typeof v === 'string' && v.trim()) out[o.property] = v.trim();
  }
  return out;
}

/** Does this fact name the person it is about? Any name token of 3+ characters
 *  counts: "Anne Marie Delacorte" is fairly written "Anne Marie", and a surname alone
 *  names someone perfectly well. The 3-char floor keeps an initial ("Michael G")
 *  from matching any sentence that happens to contain that letter. With no name
 *  resolved the guard abstains — silently dropping every fact would be worse than
 *  the thing it is guarding against. */
export function namesSubjectForTest(content, name) {
  if (!name) return true;
  const lc = String(content).toLowerCase();
  return name.toLowerCase().split(/\s+/).some(part => part.length >= 3 && lc.includes(part));
}

function subjectName(c) {
  const full = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
  return full || (c?.full_name ?? '').trim() || null;
}

/** The contact as the extractors need it: view values, gaps filled from
 *  observations, `null` when the subject still has no name.
 *  `select` is the extra view columns the caller needs beyond the shared set. */
export async function loadSubject(supabase, contactId, select = '', opts = {}) {
  const retries = opts.retries ?? SUBJECT_RETRIES;
  const retryMs = opts.retryMs ?? SUBJECT_RETRY_MS;
  const cols = ['first_name', 'last_name', 'email', 'company', 'company_id', ...select.split(',').map(s => s.trim()).filter(Boolean)];
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(retryMs);
    const { data: view } = await supabase.from('contacts')
      .select([...new Set(cols)].join(', ')).eq('id', contactId).maybeSingle();
    // A whitespace-only claim is not a value. Normalising here is what lets the
    // gap-fill below treat "present but blank" the same as "not projected yet".
    const merged = {};
    for (const [k, v] of Object.entries(view ?? {})) {
      merged[k] = typeof v === 'string' ? (v.trim() || null) : v;
    }

    // Go to the observations whenever ANYTHING is missing, not just the name. A
    // half-projected row ("Leila", no surname, no company) is the common case in
    // this window, and returning on the first truthy name would ship the model a
    // subject the ingest could have completed a moment earlier.
    if (cols.some(c => merged[c] == null)) {
      const obs = await readSubjectObservations(supabase, contactId);
      for (const [k, v] of Object.entries(obs)) if (merged[k] == null) merged[k] = v;
    }

    const name = subjectName(merged);
    if (name) return { ...merged, name };
  }
  console.warn(`[SUBJECT_UNRESOLVED] no name for contact ${contactId} after ${retries + 1} attempts — skipping extraction`);
  return null;
}

// ── Memory summary refresh ────────────────────────────────────────────────────
// Regenerates contacts.memory_summary after new signals land — fire-and-forget.

async function refreshContactBlock(supabase, contactId, workspaceId) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Resolve the subject FIRST and bail if there isn't one. `name` used to be
    // `first + last || email`, every part of it read from the claims projection —
    // so on a new contact it evaluated to null and was interpolated raw into
    // "Write a 2-sentence memory summary of null", which invited the model to pick
    // a subject out of the message body.
    const contact = await loadSubject(supabase, contactId, 'pipeline_stage, summary_generated_at');
    if (!contact) return;
    const [recentActs, factList] = await Promise.all([
      // The summary is shown to the whole team, so it is written from what the whole team may
      // read — never from a teammate's private email or the facts pulled out of it (GET-253).
      listActivities(supabase, { contactId, since: thirtyDaysAgo, limit: 15 }, teamReadContext(workspaceId)),
      listNotes(supabase, workspaceId, { entityId: contactId, limit: 15 }, teamReadContext(workspaceId)),
    ]);
    if (!recentActs.length && !factList.length) return;

    // Debounce: skip if summary was regenerated in the last 30 minutes (burst protection)
    if (contact.summary_generated_at) {
      const age = Date.now() - new Date(contact.summary_generated_at).getTime();
      if (age < 30 * 60 * 1000) {
        console.log(`[CONTACT_BLOCK] skipped — regenerated ${Math.floor(age / 60000)}m ago — contact ${contactId}`);
        return;
      }
    }

    const name = contact.name;
    // Say who sent what. An unlabelled `- linkedin_message: Hi Theo, I'm a
    // Full-Stack engineer…` reads as either side of the conversation, and the
    // model has to guess — so an inbound pitch can come back out as a summary of
    // us pitching them. extractAfterActivity has an inbound-only guard for exactly
    // this; the summary pass reads BOTH directions and needs the label instead.
    const actLines  = recentActs.slice(0, 8).map(a =>
      `- ${activityDirection(a) === 'sent' ? `we sent — ` : `${name} sent — `}${a.activity_type}${a.description ? `: ${a.description}` : ''} (${new Date(a.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
    ).join('\n');
    const factLines = factList.map(f => `- ${f.content}`).join('\n');

    const prompt = `Write a 2-sentence memory summary of ${name} for an AI sales agent. Plain prose only — no markdown, no bullets.
The summary is about ${name} and nobody else. Other names may appear inside the messages below — a greeting, a colleague, our own rep — and none of them is the subject. Never describe ${name} using something we said or something said to someone else.
First sentence: who they are and where they stand in the pipeline.
Second sentence: the single most important thing to know right now — the blocker, the opportunity, or the next move.${actLines ? `\n\nRecent activity (last 30 days), each line marked with who sent it:\n${actLines}` : ''}${factLines ? `\n\nStored facts:\n${factLines}` : ''}\n\nSummary:`;

    // A summary has no shape to check, so the only unusable answer is no answer — and that used to
    // be silent: the contact simply kept its old summary (or none), with nothing anywhere saying a
    // refresh had been asked for and had come back empty (GET-320).
    const result = await read({
      supabase, workspaceId,
      feature: 'contact-memory-summary',
      meterAs: 'signal-extraction',
      accept: acceptsProse,
      parse: parseProse,
      maxTokens: 120,
      prompt,
    });
    if (result.ok) {
      await supabase.from('contacts').update({
        memory_summary: result.value,
        summary_generated_at: new Date().toISOString(),
      }).eq('id', contactId);
      console.log(`[CONTACT_BLOCK] summary refreshed — contact ${contactId}`);
    }
  } catch (err) {
    console.warn('[CONTACT_BLOCK_ERROR]', err.message);
  }
}

// ── Private activity signal extractor ────────────────────────────────────────
// Extracts Budget / Timeline / Pain Points / Objections / Preferences / Relationships
// from qualifying private interactions and saves as `note.*` claims.

// Routing into the taxonomy, written once because there are two prompts (GET-374). Measured on
// one customer: a large share of claims sat in `general` across most accounts, and most of them had a home already —
// seasonality, staff_change and proficiency were each being passed over. Neither prompt said
// anything at all about `general` beyond the taxonomy's own one-liner, so the model had no reason
// to look twice.
//
// Deliberately NOT a quota. An earlier hand-tuned version of this told the model to keep `general`
// under one in ten, and a target share is the exact instrument that makes a model shove a fact into
// a category that does not hold it. `general`'s share is a SENSOR — it is what tells us the
// taxonomy is short, and `firmographic` and `performance` were both promoted off the back of
// reading it. Aiming at the number breaks the instrument that finds the next category.
const GENERAL_IS_LAST_RESORT = `
\`general\` is the LAST resort, not the default. Before using it, rule out every category above — the common mis-files are:
- their tools, vendors, or how their team handles a lead (not ours) → status_quo
- how far OUR product is in use, or what it has produced → adoption
- whether someone is trained, active, dormant, or expert → proficiency
- someone joining, leaving, changing role, or a team reorganised → staff_change
- when their year is busy or quiet, a season, a shutdown → seasonality
- the shape of the business: locations, headcount, volume, product lines, the segment they serve → firmographic
- a dated result: a record month, a slump, leads or sales up or down, a target hit or missed → performance
If none of them genuinely holds the fact, \`general\` IS the right answer — use it without hesitation. There is no target share, and forcing a fact into a category that does not fit is worse than leaving it in \`general\`.
`;

/**
 * The claim-extraction prompt, as one pure function.
 *
 * Production and the model comparison both build the prompt here, so a model is always
 * judged on exactly the text production would send it — never a copy that has drifted.
 */
// ── Precision on long calls (GET-789) ─────────────────────────────────────────
//
// Smaller parts made long calls produce ~25 claims instead of ~15, and the extra ones were the
// true-but-minor kind a reviewer rejects. The fact budget is per CALL now, split across its parts;
// a later part is told what earlier parts already found; and the reviewer's bar is in the prompt.

// The safety ceiling on facts per CALL, by conversation type. Not a target (see the prompt).
const DEFAULT_MAX_FACTS = {
  meeting_held:        12,
  // An email thread is a conversation, not a message. It was falling through to the default
  // of 4 — the ceiling meant for a single message — so a forty-message thread and a two-line
  // reply were given the same budget. Below meetings, because a thread carries less than a
  // transcript minute for minute, and above a lone message, because it is many of them.
  email_thread:        8,
  research_brief:      8,
  conversation_thread: 6,
};
export const defaultMaxFacts = (type) => DEFAULT_MAX_FACTS[type] ?? 4;

/**
 * The fact budget for a whole call, growing a little with its length: 3 per extra part, at most 8
 * above the base. A flat per-call budget cut too deep on long calls — a 50,000-character meeting
 * got 12 facts across 4 parts, and real ones were crowded out (capture fell from ~69% to ~55% on the
 * test set while precision rose). Short calls are unchanged. Pure.
 */
export function callFactBudget(base, parts) {
  if (!parts || parts <= 1) return base;
  return Math.min(base + 3 * (parts - 1), base + 8);
}

/** A part's share of the call's fact budget, with a floor so a part can still say something. Pure. */
export function perPartFactCap(total, parts) {
  if (!parts || parts <= 1) return total;
  return Math.max(3, Math.ceil(total / parts) + 1);
}

const DEAL_BAR = `ONLY WHAT MOVES THE DEAL — record a fact only if it changes how we win this deal or work this account. True-but-minor context is NOT a fact worth recording: an org-chart detail of their team ("CS moved from account managers to specialists"), a passing mention of their own initiatives ("we're doing two big pushes this quarter"), an internal rule about one of their tools, a vague "the department needs this", a small feature ask about our product (edit a prompt, show a number on a card). Anything our side says — including what WE think they pay or would pay — is never their fact. Also not worth recording (the commonest noise in an audit of real output): colour about how their business works that changes nothing for us (how their team divides its work, how their own customers behave, their own competitors in their market); small talk and stale numbers (what they did years ago, "we're closing some big clients right now"); a vague offer or intent with no substance ("I can show you how we do other pieces", "take it off my plate"). When in doubt, leave it out.

Rate every fact's "importance": "high" — it changes what we do next or whether the deal closes (a buying signal, a blocker, a requirement, a timeline, who decides); "medium" — context a rep should know before the next call; "low" — true, but it would change nothing. Low facts are not recorded, so be honest.`;

// ── One home per statement (GET-775) ─────────────────────────────────────────
//
// The claim extractor and the insight extractor read the same transcript and never knew about each
// other, so one sentence landed in both places: a customer's feedback on our account summary filed
// on their record as "pain", a view about AI agents filed as an "objection" against us. Measured on
// one real account: a large share of 204 live claims were feedback on our product or market views.
// The claim extractor now says where each statement belongs, and routeFacts files only claims; the
// insight extractor (signals/insights.mjs) is where the rest is captured, typed.

const ROUTING_RULES = `WHERE EACH STATEMENT BELONGS — tag every fact with "home":
- "claim": a fact about THEM — the person, their company, or this deal — that changes how we sell to or work with them. Only these are recorded here.
- "our_product": their feedback on OUR product or anything we built or sent them (a summary, a report, a PDF, the workspace, an email, a workflow): a bug, a request, a wish for how it should work, praise. That is product feedback for us, not intel about them. ("wants the account summary to lead with what to know for onboarding", "the workspace was slow", "wants a date filter", "CC me on the summaries" → our_product.) EXCEPTION: a hard condition for buying ("it must create the tasks in HubSpot or this doesn't make sense") is a claim, category requirement.
- "market": a view about AI, agents, tools in general, the market or other buyers — not about their company or this deal. ("agents tell people they know everything and give confident answers when they don't" → market.) Their decision about THEIR OWN tools is a claim.
An objection is only pushback against US or this deal. A risk_signal is only a risk to OUR relationship with them.

WHAT THEY SAY ABOUT US IS KEPT TOO. The bars above decide what is a claim about them. A statement about us or the market that does not pass them as a claim is still recorded when the customer actually said it, with home "our_product" or "market": a bug, a friction, a feature they want, praise, how they reacted to our pitch or pricing, a competitor or partner they compare us with, how buyers like them decide. Their own words only: never our side's pitch, never your summary of the call. Each one needs a "quote" and these fields:
- "kind": one of bug (something of ours broke), friction (works, but slow, manual or confusing), feature (a capability we do not have), praise, pitch (they misunderstood or reacted to how we described ourselves), pricing (cost, fees, value for money), objection (a reason against buying from us), setup (getting it running: install, integrations, access), training (people not using it, needing training), partners (another vendor, incumbent tool or partner), buyers (who buys, who decides, how customers like them operate).
- "what": 2–5 words naming the thing itself, the same words every time it comes up ("Date filter", "HubSpot task sync", "Price per seat", "Clay").
- "use_case": for a feature, friction or bug, what they were trying to do. Omit when unsaid.
- "product_area": the part of our product it is about, in 1–3 words ("Account summary", "Inbox", "CRM sync"). Omit for a market view.
- "asked_by": their role or title as stated ("Head of RevOps"). Omit when unsaid.
- "job": for a pain, a wish or a goal, the job they are trying to get done, in one short line. This is YOUR reading, not their words, so it never goes in "content" or "quote".`;

const HOMES = new Set(['claim', 'our_product', 'market']);

// The fields only a claim about us carries (GET-969); a claim about them never keeps them.
const ABOUT_US_FIELDS = ['kind', 'what', 'use_case', 'product_area', 'asked_by', 'job'];

/** Claims about them, and claims about us (GET-969: kept, no longer counted away), each in its own
 *  list. A missing or unknown home is a claim, never a silent drop. Low importance is dropped for
 *  claims about them only: one customer's small ask is exactly what an insight counts. Pure. */
export function routeFacts(facts) {
  const claims = [];
  const aboutUs = [];
  const routed = { our_product: 0, market: 0, low_importance: 0 };
  for (const f of facts ?? []) {
    if (!f || typeof f !== 'object') continue;
    const { home, importance, ...rest } = f;
    const h = String(home ?? '').trim().toLowerCase();
    if (HOMES.has(h) && h !== 'claim') { routed[h]++; aboutUs.push({ ...rest, home: h }); continue; }
    // Ranking, not holding back (GET-789): the model rates each fact and the low ones are not filed.
    if (String(importance ?? '').trim().toLowerCase() === 'low') { routed.low_importance++; continue; }
    for (const k of ABOUT_US_FIELDS) delete rest[k];
    claims.push(rest);
  }
  return { claims, aboutUs, routed };
}

// What the claims about us add to a read's answer, on top of its facts' budget.
const ABOUT_US_TOKENS = 800;

// Marks a claim about us on its way through grounding, so the two can be told apart afterwards.
const ABOUT_US = Symbol('aboutUs');
export const markAboutUs = (f) => ({ ...f, [ABOUT_US]: true });

/** After grounding: claims about them, and claims about us that kept a checked quote (an insight
 *  rests on their own words, GET-974; a claim about them may stand without one). Pure. */
export function splitAboutUs(facts) {
  const claims = [], aboutUs = [];
  for (const f of facts ?? []) {
    if (!f?.[ABOUT_US]) { claims.push(f); continue; }
    if (f.quote) { const { [ABOUT_US]: _, ...rest } = f; aboutUs.push(rest); }
  }
  return { claims, aboutUs };
}

const HOME_FIELD = '"home": "claim|our_product|market", "importance": "high|medium|low", "kind": "<our_product or market only>", "what": "<our_product or market only>", "use_case": "<our_product only>", "product_area": "<our_product only>", "asked_by": "<our_product or market only>", "job": "<our_product or market only, your reading>"';

// ── Position shifts (GET-770) ─────────────────────────────────────────────────
//
// The extractor read each conversation as if it were the first. It never saw what was already on
// file, so it could not notice that a position had moved — and nothing told it that "now I want to
// present it to the other stakeholders" is the deal moving, not a goal. Both prompts now carry the
// rules below, and the dated positions on file, numbered, so a fact can say which one it replaces.

const POSITION_SHIFT_RULES = `WHEN A POSITION MOVES — a later statement replaces an earlier one. Record the NEW position as its own fact, in the present tense, as it stands now. These are the moves that matter most and are easiest to miss:
- Readiness or a decision: "we're ready", "let's do it", "I want to present it to the other stakeholders", "let's take it to the CRO / the board", "send the paperwork" → buying_signal. Taking it to the people who decide is the deal moving forward, not a goal.
- A timeline that moved: sooner, later, paused, or a deadline that now exists → timeline, with the new timing and its reason.
- An objection resolved or dropped ("that's fixed now", "the price doesn't scare me") → objection with "status": "resolved".
- Budget freed, approved, cut or frozen → budget.
- A deal going backwards: "not a priority this quarter", "we need to pause", "the CEO wants to wait" → timeline or risk_signal.
- A competitor chosen, dropped, or newly in the running → competitor with its new "stance".
- A new decision-maker, champion or blocker, or one who left → authority or staff_change.
- Scope changed: a pilot becoming a rollout, or a rollout cut back to a pilot → buying_signal or goal.`;

const POSITIONS_ON_FILE_CAP = 30;

/** The rules, plus — when anything is on file — the dated positions, numbered for "replaces". Pure. */
export function positionShiftBlock(positionsOnFile = []) {
  const list = (positionsOnFile ?? []).slice(0, POSITIONS_ON_FILE_CAP);
  if (!list.length) return POSITION_SHIFT_RULES;
  const lines = list.map((p, i) => `${i + 1}. [${String(p.said_at ?? '').slice(0, 10) || 'undated'}] [${p.category}] ${p.content}`).join('\n');
  return `${POSITION_SHIFT_RULES}

ON FILE — what we currently hold about them, dated by when it was said:
${lines}

When something said here CHANGES, CONTRADICTS or RESOLVES one of these, record the new position and set "replaces" to that line's number. Do NOT re-record a line that has not changed. Leave "replaces" out when nothing on file is replaced.`;
}

/** The model's "replaces" number → the claim id (and its date, for the order guard). Pure. */
export function resolveReplaces(facts, positionsOnFile = []) {
  const list = (positionsOnFile ?? []).slice(0, POSITIONS_ON_FILE_CAP);
  return (facts ?? []).map(f => {
    if (!f || typeof f !== 'object') return f;
    const { replaces, ...rest } = f;
    const n = typeof replaces === 'number' ? replaces : (/^\d+$/.test(String(replaces ?? '').trim()) ? Number(replaces) : NaN);
    const hit = Number.isInteger(n) && n >= 1 ? list[n - 1] : null;
    return hit ? { ...rest, replacesClaimId: hit.id, replacesSaidAt: hit.said_at ?? null, replacesEntityId: hit.entity_id ?? null } : rest;
  });
}

// More room for the deal's moving parts, where a later word most often replaces an earlier one;
// less for standing context (stack, pains, rivals), which rarely flips.
const DEAL_POSITION_CATEGORIES = new Set(['buying_signal', 'timeline', 'budget', 'objection', 'goal', 'authority', 'risk_signal', 'expansion_signal', 'blocker', 'requirement']);
const POSITIONS_PER_CATEGORY = (category) => (DEAL_POSITION_CATEGORIES.has(category) ? 6 : 2);

/**
 * Which positions to show the extractor. Pure. A few per topic (more for the deal's moving parts), newest-said first — a flat "newest
 * 20" let one busy call fill every slot and hid exactly the September claim that most needed
 * replacing. A conversation's own earlier read (same source_ref) is not "on file": a re-read would
 * otherwise be invited to replace the facts it is about to re-derive.
 */
export function selectPositions(notes, { excludeSourceRef = null, perCategory = POSITIONS_PER_CATEGORY, cap = POSITIONS_ON_FILE_CAP } = {}) {
  const limitFor = typeof perCategory === 'function' ? perCategory : () => perCategory;
  const perCat = new Map();
  const out = [];
  const sorted = (notes ?? [])
    .filter(n => n && n.intel !== false && !n.metadata?.doc_type && isTimeBound(n.category))
    .filter(n => n.freshness !== 'expired')
    .filter(n => !excludeSourceRef || n.metadata?.source_ref !== excludeSourceRef)
    .sort((a, b) => String(b.said_at ?? '').localeCompare(String(a.said_at ?? '')));
  for (const n of sorted) {
    const k = perCat.get(n.category) ?? 0;
    if (k >= limitFor(n.category)) continue;
    perCat.set(n.category, k + 1);
    out.push({ id: n.id, entity_id: n.entity_id, category: n.category, content: n.content, said_at: n.said_at });
    if (out.length >= cap) break;
  }
  return out;
}

/** The live, time-bound claims on these records that a new conversation may move. */
export async function loadPositionsOnFile(supabase, workspaceId, entityIds, { excludeSourceRef = null } = {}) {
  const ids = [...new Set((entityIds ?? []).filter(Boolean))];
  if (!ids.length) return [];
  const notes = await listNotes(supabase, workspaceId, { entityIds: ids, limit: 300 }, teamReadContext(workspaceId)).catch(() => []);
  return selectPositions(notes, { excludeSourceRef });
}

/**
 * A fact may only replace a claim on the record it belongs to: the person, or their account. On a
 * call with two companies the ON FILE list holds both, and "we'll wait until Q2" from Alice must
 * not retire OtherCo's timeline. Pure.
 */
export function replacesAllowed(fact) {
  if (!fact?.replacesClaimId || !fact.replacesEntityId) return false;
  return [fact.contactId, fact.companyId, claimTargetEntity(fact)].filter(Boolean).includes(fact.replacesEntityId);
}

const REPLACES_FIELD = ', "replaces": <ON FILE line number, only when this fact replaces it>';

export function buildActivitySignalsPrompt({ contactName, company = null, type, summary, maxFactsOverride = null, ourSide = null, part = null, positionsOnFile = [] }) {
    const contactCtx  = [contactName, company].filter(Boolean).join(' at ');
    // Who "our side" is — a teammate's name, else "the <Company> team". The prompt used to
    // say "the user (us)", and the models wrote exactly that into facts.
    const we = ourSideLabel(ourSide);
    // Reaching here means the content describes the contact, not the user's own
    // words back at them — the caller guarantees it (outbound single messages are
    // filtered out in extractAfterActivity; the thread/brief passes carry both
    // sides but label them, and say so in the provenance). State the shape
    // explicitly so Haiku never mistakes the user's side for a fact about the
    // contact.
    const provenance = {
      meeting_held:
        `These are notes/transcript from a meeting with ${contactName}.`,
      // The full two-sided thread. Lines are labelled by speaker; only the
      // contact's side (and what it reveals) describes the contact. This is the
      // pass that catches relational intel a single short message can't carry on
      // its own — a shared connection, their role, what they're building.
      conversation_thread:
        `This is the full back-and-forth of a conversation between ${we} and ${contactName}. ` +
        `Lines beginning "You:" are ${we}'s own words; lines beginning "${contactName}:" are ${contactName}'s. ` +
        `Record durable facts about ${contactName} drawn from the WHOLE exchange, including things that only become ` +
        `clear across several messages (a shared connection, their role, their company, what they are building). ` +
        `NEVER turn a "You:" line into a fact about ${contactName}.`,
      // Research the user's OWN agent compiled about the contact (from public
      // LinkedIn posts, their website, prior context) — not the contact's words.
      // Real, durable intel, but second-hand, so it is framed as such.
      research_brief:
        `This is research ${we}'s own agent compiled ABOUT ${contactName} (from their public LinkedIn posts, ` +
        `their company website, and prior context) — not ${contactName}'s own words. Record the durable facts it ` +
        `establishes about ${contactName} or their company.`,
    }[type] ||
      `This is a message that ${contactName} sent to ${we} — these are ${contactName}'s own words, not ${we}'s.`;

    const channelLabel = {
      slack_dm:            'Slack DM',
      slack_message:       'Slack channel message',
      email_reply:         'email reply',
      email_received:      'inbound email',
      linkedin_message:    'LinkedIn message',
      linkedin_replied:    'LinkedIn reply',
      linkedin_reply:      'LinkedIn reply',
      reply:               'reply',
      positive_reply:      'reply',
      meeting_held:        'meeting notes/transcript',
      conversation_thread: 'conversation thread',
      research_brief:      'research brief',
    }[type] || type;

    // No fixed target — the content and the quality bar decide how many claims a
    // conversation yields. A thin message may produce none; a content-rich 50-min
    // meeting may produce many. These numbers are SAFETY CEILINGS (runaway + cost
    // guards), NOT goals; the prompt is explicit that the model must extract only
    // what clears the bar and must never pad to reach a count. A deliberate
    // re-extract pass can still raise the ceiling via override.
    const maxFacts = maxFactsOverride ?? defaultMaxFacts(type);

    const prompt = `Extract durable CRM intelligence about ${contactName} from this private ${channelLabel}.
${provenance}
Record facts about ${contactName}, drawn from what THEY reveal about themselves, their company, needs, constraints, opinions, or plans. ALSO record facts about the RELATIONSHIP between ${contactName} and ${we}: how ${contactName} found ${we} or why they reached out (a video, post, referral, or event), anything ${contactName} offered ${we} or introductions they can make, and any objection or critique ${contactName} raised about the product or how it differs from alternatives. Do NOT turn ${we}'s OWN questions or statements into facts about ${contactName} (e.g. if ${we} asked "what's behind your product?", that is NOT a fact that ${contactName} is interested in the product) — but an offer, an introduction, a critique, or a reason-for-reaching-out that ${contactName} genuinely voices IS a fact about ${contactName} and must be recorded.
${contactCtx ? `Contact: ${contactCtx}` : ''}
${partPreamble(part, 'Message')}

Message: "${summary}"

A fact is worth recording ONLY if it passes ALL FOUR bars:
1. ABOUT THEM — a fact about ${contactName} or their business, never about ${we} or our product. Our roadmap, our pricing, our partnership, a defect in our tool, what ${we} offered or promised: none of those is a fact about ${contactName}. The test is whose record it belongs on. Two things that DO pass: an objection is their reaction to us and belongs to them, and a fact ${we} states ABOUT ${contactName} is still a fact about ${contactName}.
2. DURABLE — still true weeks or months from now. A meeting time, an availability, or a reschedule is NOT durable. FOUR EXCEPTIONS, all decision-critical the instant they happen: a buying signal from a prospect (they asked for the agreement/contract, accepted or agreed to pricing, gave a verbal commit, said they are ready to move forward or to take it to the other stakeholders, or asked to start/onboard) → category buying_signal; a stated result in their business (a record month, a slump, leads or sales up or down, a target hit or missed) → category performance; an existing customer asking for, considering or declining MORE of what we sell (a product they lack, more seats or locations, an upgrade) → category expansion_signal; and an existing customer saying the relationship is in question (cancelling, giving notice, reviewing vendors, escalating a billing or service failure) → category risk_signal. All are snapshots rather than states, and all are recorded anyway.
3. DECISION-RELEVANT — it would change how someone sells to or works with ${contactName}: their budget, authority, pain, goals, stack, or buying timeline — OR how the relationship should be worked: how they found ${we}, what they offered ${we}, or the objection they raised about the product.
4. SPECIFIC — it carries the concrete detail or the reason WHY, not a vague label. "Evaluating Clay vs Apollo because Apollo's data went stale", not "looking at tools".

NEVER record (noise, or it already lives elsewhere in the CRM):
- Meeting logistics: scheduling, availability, reschedules, "has a call on X", invites sent or pending.
- Generic sentiment, small talk, greetings, pleasantries.
- Anything true today but meaningless next week.

Tag each fact with exactly one category, and whether it is about the person or their company.

${ourOfferBlock(ourSide)}Categories:
${claimCategoryPromptBlock()}
${GENERAL_IS_LAST_RESORT}
Rules:
- Each fact is one self-contained sentence naming ${contactName} explicitly (no pronouns). Name them as the one doing or wanting the thing, never as a speaker: "${contactName} is moving support to Zendesk", not "${contactName} says the company is moving support to Zendesk". Never "${contactName}'s company X's …". Short and plain: the fact, its detail, nothing about who said it (that is stored separately).
- ${ourSideRule(ourSide)}
- State only what ${contactName} said or plainly did. Never add your own reading of what it implies — no "indicating…", "suggesting that…", "which shows…", "meaning…", "as evidenced by…". Write "${contactName} offered two references", not "${contactName} offered two references, indicating a strong relationship".
- ${contactName} is the ONLY possible subject. Other names will appear in the message — the person it greets, a colleague, one of us — and none of them is the subject. If the message opens "Hi <name>", that name is the RECIPIENT, not ${contactName}. Never write a fact whose subject is anyone but ${contactName}.
- SOMEONE SELLING TO US IS NOT A CUSTOMER. This corpus is our own sales and support correspondence. A thread where the other side is pitching US — a vendor cold email, an agency, a recruiter, a software demo, a staffing or payment-terms negotiation — contains no intelligence about a customer, however well written it is. Extracting it files a stranger's product pitch on our own account record. When the thread is inbound selling, return [] and nothing else.
- A JOB TITLE ON ITS OWN IS NOT A FACT. "Roland Fisk is the General Manager at Fallowmere Logistics" states what someone IS, not something they said or did, and it does not decay — it is an attribute of the person. Do not emit it as a fact at all. Put it in "job_title" instead, as the bare title: "General Manager". A title plus something they SAID stays a fact, and keeps the title too.
- Set "category" to exactly one of: ${CLAIM_CATEGORY_KEYS.join(', ')}.
- Set "about" to "person" for a fact about ${contactName}, or "company" for a fact about their company.
- Set "label" to a 2–4 word tag that names the SUBSTANCE of the fact — what a rep would skim on a card. NOT the person's name. For a competitor, use the competitor/vendor name (e.g. "Tallowmark", "Brightlist leads"). For an objection, name the objection ("Outbound intent doubts", "Already on Salesforce"). For a pain/goal, name the pain/goal ("Stale Apollo data", "Expand to healthcare"). Sentence case: capitalise only the first word and names ("Already on Salesforce", not "Already On Salesforce"). No trailing period.
- CONTEXT TAGS — these decide whether a signal is a real risk, so be precise:
  - "competitor" means a competitor of ${ourSide?.companyName || 'our company'}: a product that does the job described under WHAT ${(ourSide?.companyName || 'our company').toUpperCase()} SELLS. Their CRM, call recorder, meeting-notes or agenda tool, data vendor or automation tool is NOT a competitor unless it does that same job — file it as status_quo (even when they plan to switch off it).
  - If category is "competitor": set "entity" to the competitor/vendor name only (e.g. "Pearl Lantern"), and "stance" to one of: "evaluating" (a live alternative they're weighing against us), "incumbent" (they currently use it FOR THE JOB we sell), "past_failure" (a vendor they TRIED for that job and it failed / they fired — this LOWERS competitive risk, it's an opening), "mentioned" (named in passing, no clear posture).
  - If category is "objection": set "status" to "open" (still unresolved), "resolved" (answered/no longer a concern), or "addressed" (we responded, awaiting confirmation); and "hardness" to "hard" (budget, authority, security, legal, procurement — a real gate) or "soft" (needs info, timing, minor preference).
  - If category is "authority": set "role" to one of: "economic_buyer" (holds the budget or signs), "decision_maker" (chooses, or their approval is what unblocks it), "champion" (actively pushes for us internally), "blocker" (is stopping it), "technical" (judges whether it works). The role must describe THE PERSON THE FACT IS ABOUT. Leave "role" out when the fact names someone ELSE's authority ("Marisol can't change that setting, the directors would have to"), when it only restates a job title, or when the person simply uses the product.
  - If category is "expansion_signal": set "product" to the product family they named (from WHAT WE SELL when listed — e.g. "Shelfwise Pro", not "Shelfwise Pro (EU)"), and "stance" to one of: "asked" (requested it or asked what it costs), "considering" (raised it, no commitment), "declined" (said no to it, or cancelled a trial of it). NEVER leave "stance" out — a decline read as an ask sends a rep to pitch what the customer just refused. A feature request about a product they ALREADY OWN is pain, not expansion.
  - If category is "risk_signal": set "severity" to one of: "stated_churn" (cancelled, gave notice, said they are leaving), "at_risk" (reviewing vendors, questioning the value, escalating an unresolved problem), "friction" (a billing, invoicing, support or service failure raised with frustration, no threat to leave). A departure of a person is staff_change, not risk_signal.
  - If category is "tech_stack": set "tool" to the tool's official name, one spelling ("HubSpot", "Slack", "GrokBot" — never "Grok" for one fact and "GrokBot" for another). One tool per fact. A fact about one of their tools (who drives it, what it costs, what they think of it, a decision about it) is tech_stack — not risk_signal, and not competitor unless the tool does the job WE do.
  - If category is "blocker": set "status" to "open" (still in the way) or "resolved" (the conversation says it is no longer in the way). Who else must sign off, no plan for who to onboard or how to roll it out, internal politics, missing access, a pending review. A setup step already done (access granted, a file shared) is not a blocker.
  - A buying signal is a decision moving toward the deal — never a setup step: pushing paperwork such as an NDA through, giving access or API keys, or promising to send a list is logistics.
  - "requirement" is a hard condition for buying, not a wish or a feature idea.
- Extract EVERY fact that clears all four bars — there is no target number. A thin message often yields none or one; a content-rich meeting may yield many. NEVER pad to reach a count, NEVER split one fact into several, and NEVER restate the same fact in different words.
- Quality over quantity: one sharp, specific fact is worth more than five vague ones. If nothing clears all four bars, return [].
- Hard ceiling of ${maxFacts} facts with home "claim" — a safety limit, not a goal. What they say about us (our_product, market) does not count toward it. Stop when you run out of facts that genuinely clear the bar, well before the ceiling.

${DEAL_BAR}

${ROUTING_RULES}

${positionShiftBlock(positionsOnFile)}

Output ONLY valid JSON: [{${HOME_FIELD}, "content": "...", "quote": "...", "speaker": "...", "label": "2-4 word tag", "category": "<one category key>", "about": "person|company", "job_title": "<their bare title, when the text states one — or omit>", "entity": "<competitor name, competitor only>", "stance": "<competitor only>", "status": "<objection or blocker only>", "tool": "<tech_stack only>", "hardness": "<objection only>", "change": "<staff_change only>", "role": "<authority only>", "product": "<expansion_signal only>", "severity": "<risk_signal only>"${positionsOnFile?.length ? REPLACES_FIELD : ''}}]

  - If category is "staff_change": set "change" to one of: "left", "joined", "moved", "reorg", "away" (out for months on parental or medical leave — not a week off). Name the person the change is about in "content".

- "quote": the words from the text above that this fact rests on, VERBATIM — copied exactly, not rephrased, not tidied, max ~25 words. It is checked against the source and dropped if it is not found there, so never invent or paraphrase one. Use "" if the fact rests on no single line.
- "speaker": who said those words — the person's name as the source labels it. A quote nobody is attributed to only half-answers "can I trust this": a fact about the director resting on a line an assistant spoke means something different. Use "" if the source does not say who spoke.
If nothing meaningful: []`;
    // Scale the output budget with the fact cap — a deep transcript re-extract asking for
    // many detailed facts needs more room than a 2-fact message, or the JSON array
    // truncates mid-fact and fails to parse.
    // Room to think as well as answer: the extraction tier reasons before it writes JSON, and at a
    // 400–2,000 cap it ran out mid-thought on long parts and answered nothing (finish: length).
    // Room for what they say about us too (GET-969): those ride alongside the facts, not in their count.
    const maxTokens = Math.min(4000, Math.max(1500, maxFacts * 200)) + ABOUT_US_TOKENS;
    return { prompt, maxFacts, maxTokens };
}

/** The lines that tell the model it is reading one part of a long text, with the call summary as context. */
function partPreamble(part, noun = 'Transcript') {
  if (!part || part.total <= 1) return '';
  const ctx = part.context
    ? `\nCALL SUMMARY (context only, so you know what the whole call covers — do NOT extract facts from it; extract them from the ${noun.toLowerCase()} part below):\n<<<\n${part.context}\n>>>\n`
    : '';
  const already = (part.already ?? []).filter(Boolean).slice(-30);
  const seen = already.length
    ? `\nALREADY CAPTURED from earlier parts of this ${noun.toLowerCase()} — do not record them again, in any wording; record only what is NEW here:\n${already.map(a => `- ${a}`).join('\n')}\n`
    : '';
  return `${ctx}\nThis is part ${part.index + 1} of ${part.total} of a long ${noun.toLowerCase()}. The other parts are read separately — extract only what THIS part says.\n${seen}`;
}

/**
 * The model half of 1:1 extraction: text in, clean facts out, no database.
 * Long text is read in parts (splitForExtraction); every fact's wording is enforced
 * (tidyFactContent). extractActivitySignals persists what this returns; the eval harness
 * calls it directly, so what is measured is what production runs.
 *
 * onPart(facts|null, { index, total, model }) — per part; null means the answer was unusable.
 * onCall(msg) — per model response, for metering.
 * groundAgainst(partText, index) => string — narrows what a fact's quote may REST ON, when that is
 *   not the whole text the model READ. One-sided sources (a transcript, a message) are the same
 *   text for both; a two-sided one (an email thread) is not, and grounding a claim about the
 *   customer against the whole thread lets our own sentence become their evidence. See
 *   theirSideOf in noema/grounding.mjs. Default: what was shown — every existing caller unchanged.
 * @returns {Promise<{ facts: object[], failedParts: number, parts: number, calls: object[] }>}
 */
export async function extractFactsFromText({
  contactName, company = null, type, text, maxFactsOverride = null, ourSide = null,
  model = null, fallback = undefined, strict = false, onPart = null, onCall = null,
  groundAgainst = null, criteria = '',   // what the workspace adds to the prompt (lib/extractionCriteria.mjs)
  evidenceMessages = null, evidenceContactId = null,
  // The dated positions on file (GET-770): shown to the model, and its "replaces" resolved to ids.
  positionsOnFile = [],
  // Our side's names as the transcript labels them (GET-417). The meeting path dropped a fact
  // whose quote our side spoke; a 1:1 call did not, so a rep's guess ("you'd find $700 expensive")
  // was filed as the customer's budget — and since GET-770 it could retire what they really said.
  ourNames = [],
}) {
  const { context, parts } = splitForExtraction(text);
  const out = { facts: [], aboutUs: [], failedParts: 0, parts: parts.length, calls: [], offered: 0, grounded: 0, routed: { our_product: 0, market: 0, low_importance: 0 } };
  // Read one piece of text; on no answer, once, read it as two halves (GET-415). Each yields
  // {raw, shown, maxFacts} — the facts and the exact text they must be grounded against.
  // One budget per CALL, split across its parts (GET-789): a long call no longer yields more facts
  // just because it is read in more pieces.
  const partBudget = perPartFactCap(callFactBudget(maxFactsOverride ?? defaultMaxFacts(type), parts.length), parts.length);
  const readPiece = async (piece, index, allowHalving) => {
    // What earlier parts already found, so this part does not find it again (GET-789).
    const part = { index, total: parts.length, context, already: out.facts.map(f => f.content) };
    const { prompt, maxFacts, maxTokens } = buildActivitySignalsPrompt({
      contactName, company, type, summary: piece, maxFactsOverride: partBudget, ourSide, part, positionsOnFile,
    });
    const msg = await createMessage({
      meter: false,   // the caller meters it, through onCall
      feature: 'activity-signals-extract',
      model: model || pipelineModel(),
      fallback,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt + criteria }],
      accept: (t) => parseJsonArray(t) !== null,
    });
    out.calls.push(msg);
    await onCall?.(msg);
    const parsed = parseJsonArray(msg.content[0]?.text);
    let raw = null;
    if (parsed !== null) {
      const { claims, aboutUs, routed } = routeFacts(resolveReplaces(parsed, positionsOnFile));
      out.routed.our_product += routed.our_product; out.routed.market += routed.market; out.routed.low_importance += routed.low_importance;
      if (routed.our_product || routed.market || routed.low_importance) console.log(`[ROUTER] ${type}: ${routed.our_product} product feedback, ${routed.market} market view(s) kept as claims about us, ${routed.low_importance} low-importance dropped`);
      raw = [...claims, ...aboutUs.map(markAboutUs)];
    }
    if (raw !== null) return [{ raw, shown: piece, maxFacts }];
    const halves = allowHalving ? halveForRetry(piece) : null;
    if (halves) {
      console.warn(`[ACTIVITY_EXTRACTOR_HALVED] part ${index + 1}/${parts.length}: no answer for ${piece.length} chars — reading it as two halves`);
      const got = [];
      for (const half of halves) got.push(...await readPiece(half, index, false));
      if (got.length) return got;
    }
    // An output with no parseable JSON array is a FAILURE, not an empty answer — a model
    // that fumbles the format 5% of the time silently loses 5% of the intel otherwise.
    out.failedParts++;
    await onPart?.(null, { index, total: parts.length, model: msg.model });
    if (strict) throw new Error(`unparseable extraction output from ${msg.model}`);
    return [];
  };
  for (let index = 0; index < parts.length; index++) {
    for (const { raw, shown, maxFacts } of await readPiece(parts[index], index, true)) {
      // A quote the model did not read in this piece is one it made up, and an unchecked quote is
      // worse than none: it looks like evidence. Grounded against the exact text the model was
      // shown — or, for a two-sided source, the narrower slice of it the claim may speak for.
      // The fact budget is for claims about them; what they said about us rides alongside (GET-969).
      const { facts, offered, grounded } = groundFacts(
        [...raw.filter(f => !f?.[ABOUT_US]).slice(0, maxFacts), ...raw.filter(f => f?.[ABOUT_US])]
          .filter(f => f && f.content && typeof f.content === 'string')
          .map(f => ({ ...f, content: tidyFactContent(f.content, ourSide) })),
        groundAgainst ? groundAgainst(shown, index) : shown,
      );
      const theirs = evidenceMessages !== null
        ? externalEvidence(facts, evidenceMessages, { contactId: evidenceContactId })
        : ourNames.length ? facts.filter(f => !(f.quote && spokenByOurSide(f.quote, shown, ourNames))) : facts;
      if (theirs.length < facts.length) console.log(`[GROUNDING] activity-signals-extract: dropped ${facts.length - theirs.length} fact(s) ${evidenceMessages !== null ? 'without confirmed external evidence' : 'quoting our own side'}`);
      out.offered += offered;
      out.grounded += grounded;
      const { claims: forThem, aboutUs } = splitAboutUs(theirs);
      out.facts.push(...forThem);
      out.aboutUs.push(...aboutUs);
      await onPart?.(forThem, { index, total: parts.length, model: out.calls[out.calls.length - 1]?.model });
    }
  }
  return out;
}

// `sourceRef` is the answer to "has this source already been read". It must reach persistFacts or
// the claim is born with no link back to what produced it, and a resume check has to guess —
// which is the GET-359 failure, recurring on the path GET-359 did not cover (GET-375).
// `aboutUs`: file what they said about us (GET-969); off where the source has insights turned off.
// `aboutUsRef`: the conversation's identity for claims about us when it has no sourceRef (a LinkedIn
// thread rollup), so a re-read files nothing twice. `quotePrivate`: the conversation is a private
// message whatever its type says.
export async function extractActivitySignals({ supabase, activityId, sourceActivityIds, contactId, workspaceId, type, source, summary, maxFactsOverride, dryRun = false, strict = false, sourceRef = null, occurredAt = null, ourNames = [], evidenceMessages = null, aboutUs = true, aboutUsRef = null, quotePrivate = false }) {
  try {
    // THE CREDIT GATE (GET-531). Reading is what spends credits, so this is where the band
    // has to bite — one question per workspace per five minutes, in front of every caller:
    // the webhook handlers, the rollups, the re-extraction passes. The activity is already
    // recorded by the time we get here; what pauses is the reading of it, which is the promise
    // the billing page makes. Fails open — see lib/creditGate.mjs.
    const gate = await mayReadWorkspace(workspaceId);
    if (!gate.allowed) { if (strict) throw new Error('extraction_credit_gate_closed'); return []; }
    setUser({ id: String(workspaceId) });
    // No subject, no extraction. The old fallback — 'the contact' — collided with
    // the rule below that every fact must name its subject explicitly: the model
    // was ordered to name someone it had never been given, so it named whoever the
    // message happened to greet. A placeholder is not a safe default here.
    const contact = await loadSubject(supabase, contactId);
    if (!contact) { if (strict) throw new Error('extraction_subject_unresolved'); return []; }
    const ourSide = await loadOurSide(supabase, workspaceId, { activityId, text: summary });
    // What is on file about them and their account that this conversation may move (GET-770).
    const positionsOnFile = await loadPositionsOnFile(supabase, workspaceId, [contactId, contact.company_id], { excludeSourceRef: sourceRef });

    // Part by part, persisting as it goes: a later part's merge decision then sees the
    // facts an earlier part already saved, so the overlap between parts dedupes.
    const saved = [];
    const read = await extractFactsFromText({
      contactName: contact.name, company: contact.company, type, text: summary, maxFactsOverride, ourSide, strict, positionsOnFile, ourNames,
      evidenceMessages, evidenceContactId: contactId,
      criteria: await extractionCriteria(supabase, workspaceId),
      onCall: (msg) => meterLLM(supabase, workspaceId, 'signal-extraction', msg),
      onPart: async (facts, { index, total, model }) => {
        if (facts === null) {
          console.warn(`[SIGNAL_EXTRACTOR_PARSE_FAIL] ${model}: no JSON array in output — activity ${activityId} part ${index + 1}/${total}`);
          await recordPipelineEvent(supabase, { workspaceId, kind: 'unparseable', feature: 'activity-signals-extract', model, detail: { activity_id: activityId, part: index + 1, parts: total } });
          return;
        }
        if (!facts.length) return;
        const kept = facts.map(f => ({ ...f, contactId, activityId: f.activityId ?? activityId,
          sourceActivityIds: f.sourceActivityIds ?? sourceActivityIds, companyId: contact?.company_id ?? null }));
        saved.push(...await persistFacts(supabase, workspaceId, kept, { type, source, dryRun, sourceRef, occurredAt, strict }));
      },
    });
    if (!dryRun && aboutUs && read.aboutUs.length) {
      await saveAboutUsClaims(supabase, workspaceId, read.aboutUs.map(f => ({ ...f, contactId, companyId: contact?.company_id ?? null })),
        { sourceRef: sourceRef ?? aboutUsRef, sourceSystem: source ?? null, occurredAt, quotePrivate: quotePrivate || isPrivateMessageType(type) || type === 'email_thread' });
    }
    return saved;
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      // Logged under its own tag so an outage is findable — an empty credit balance read as
      // "no facts in any conversation" for a full day before anyone looked.
      console.error('[SIGNAL_EXTRACTOR_UNAVAILABLE]', err.model, err.status, err.message);
      await recordPipelineEvent(supabase, { workspaceId, kind: 'unavailable', feature: 'activity-signals-extract', model: err.model, detail: { activity_id: activityId, status: err.status, message: String(err.message).slice(0, 300) } });
    } else {
      console.warn('[SIGNAL_EXTRACTOR_ERROR]', err.message);
    }
    if (strict) throw err;
    return [];
  }
}

// ── Fact persistence ──────────────────────────────────────────────────────────
//
// Shared by the 1:1 extractor and the meeting extractor. Every fact carries the
// contact it is ABOUT and the activity it came FROM, so this works the same
// whether all the facts belong to one person (a DM) or to several (a call).
//
// Both model calls in here are batched across the whole conversation, not per
// fact: one merge decision for all of them, one graph-edge pass over all of them.
//
// The extractor prompt bans first/second-person pronouns — every fact must name its
// subject explicitly. The failure this guards is the subject collapsing into second
// person ("<owner> found you… after viewing your profile") or the model speaking AS the
// contact ("my CEO will decide"), both of which render as garbage on the card.
//
// The rule itself lives in @nous/core (violatesPronounRule) because the API's `record`
// applies the same one, and a copy here is how GET-368 stayed invisible: the old
// lookbehind excluded only [-\w], so a standalone `I` after an ampersand (as in "X&I") read as a first-person pronoun
// and every fact naming such an abbreviation was dropped on BOTH write paths, silently, for months.

/**
 * Which entity a fact lands on. ONE derivation, because it is now asked twice.
 *
 * A buying signal is a specific person's move on the deal, and stage + intent are person-level, so
 * it always lands on the person who voiced it and is never routed up to the company entity (which
 * does not pipeline). Every other category keeps the company-vs-person routing.
 *
 * The dedup pass asks this BEFORE the write, to scope its search to the record the fact will join;
 * saveNote asks it at the write. Deriving it twice is the bug shape that has cost this codebase
 * more than any other, so it is derived here.
 */
export function claimTargetEntity(fact) {
  // A company category (tech_stack, firmographic, performance, seasonality) goes on the company
  // whatever the model tagged (GET-776).
  const about = claimAboutFor(fact.category, fact.about);
  const cat = normalizeClaimCategory(fact.category);
  return (cat !== 'buying_signal' && about === 'company' && fact.companyId) ? fact.companyId : fact.contactId;
}

/** The observations a fact was read from: the thread's messages, or the one activity. */
function factSourceIds(fact) {
  return [...new Set([...(fact.sourceActivityIds || []), fact.activityId].filter(Boolean))];
}

// Exported for the Gmail Read (GET-329), which files thread claims through the same guards —
// the pronoun rule, the subject rule, the category whitelist and the source_ref stamp. A second
// persist path would be a second set of guards, and they would drift.
/**
 * A title is an attribute, so it is filed as one.
 *
 * Most `general` + `authority` claims in the first Gmail month were a person's role — the
 * same sentence shape ("X is the General Manager at Y") split between the two categories on
 * nothing anyone could name. A title is not something someone said and it does not decay: it is
 * what the person IS. That is GET-327's fifth test, the one that sent firmographics to company
 * fields, applied to people.
 *
 * `job_title` is already a first-class person property with tens of thousands of rows from the CRM. An email
 * signature is a better source than a CRM field nobody updates — so it lands there, as a state
 * observation, and stops competing with claims for a category.
 *
 * Returns how many were filed, so a run can say so rather than the claims quietly going missing.
 */
export async function persistJobTitles(supabase, workspaceId, facts, { source, dryRun = false }) {
  const seen = new Map();   // one per contact — the last title wins, not a row per mention
  for (const f of facts ?? []) {
    const title = typeof f?.job_title === 'string' ? f.job_title.trim().slice(0, 120) : '';
    // A "title" long enough to be a sentence is the model narrating rather than naming a role.
    if (!title || !f.contactId || title.length < 2 || title.split(/\s+/).length > 8) continue;
    seen.set(f.contactId, title);
  }
  if (dryRun) return seen.size;

  let filed = 0;
  for (const [contactId, title] of seen) {
    try {
      await recordObservation(supabase, {
        workspaceId, entityId: contactId, kind: 'state',
        property: 'job_title', value: title,
        source, method: 'extraction',
      });
      filed++;
    } catch (e) {
      console.warn('[JOB_TITLE] could not file', title, '-', e.message);
    }
  }
  return filed;
}

// `occurredAt` is when the source was said (the call, the message). Every claim is filed under it,
// not under the time we wrote it (GET-770). A fact may carry its own `saidAt` (a thread's message).
export async function persistFacts(supabase, workspaceId, kept, { type, source, dryRun = false, sourceRef = null, occurredAt = null, strict = false }) {
  // Titles first, and they are filed whether or not the fact survives the guards below: a title is
  // an attribute of the person and does not depend on the claim it arrived with being keepable.
  const titlesFiled = await persistJobTitles(supabase, workspaceId, kept, { source, dryRun });
  if (titlesFiled) console.log(`[JOB_TITLE] ${titlesFiled} title(s) filed from ${type}/${source}`);

  if (!kept.length) return [];

  // Catch pronoun violations mechanically rather than hoping the model always complies.
  // One guard here covers both the 1:1 and the meeting extractor.
  const beforeGuard = kept.length;
  // A TITLE IS NOT A FACT (GET-421), and this is the mechanical half of a rule the prompt has
  // carried since GET-327 and the model keeps breaking: about half of the Gmail corpus's `general`
  // claims were someone's role and nothing else. persistJobTitles ran above and filed the title,
  // so dropping the claim removes a duplicate rather than information.
  const titleOnly = kept.filter(f => isTitleOnlyFact(f.content));
  kept = kept.filter(f => !isTitleOnlyFact(f.content));
  if (titleOnly.length) {
    console.log(`[SIGNAL_TITLE_GUARD] dropped ${titleOnly.length} title-only fact(s) — ${TITLE_ONLY_REASON}`);
  }
  const dropped = kept.filter(f => violatesPronounRule(f.content));
  kept = kept.filter(f => !violatesPronounRule(f.content));
  if (dropped.length) {
    console.warn(`[SIGNAL_PRONOUN_GUARD] dropped ${dropped.length} fact(s) addressing the subject in 1st/2nd person:`,
      dropped.map(f => f.content));
  }
  if (!kept.length) return [];

  // And the same treatment for the subject itself. The prompt says every fact must
  // name the person it is about; a prompt rule the model can ignore is not a rule.
  // When the model had no name it took whichever proper noun was nearest — the
  // greeting, a teammate, the loudest speaker on the call — and over a hundred claims across
  // dozens of people ended up describing somebody other than the person whose record they
  // sit on. loadSubject stops the nameless case upstream; this stops the rest, and
  // it is the one check that holds no matter which extractor called us.
  const subjectNames = new Map();
  const companyNames = new Map();
  for (const cid of new Set(kept.map(f => f.contactId).filter(Boolean))) {
    // No retry here: by the time facts exist the upstream resolver has already
    // waited, and a guard must never add latency to the write path.
    const s = await loadSubject(supabase, cid, '', { retries: 0 });
    subjectNames.set(cid, s?.name ?? null);
    companyNames.set(cid, s?.company ?? null);
  }
  // A fact tagged about:"company" names the COMPANY — "Brightwick has raised funding from
  // Calder Peak Ventures" is a correct, well-formed fact that mentions no person, and an
  // undiscriminating name check would delete every one of them. Check those against
  // the employer instead, and abstain when we don't know it.
  //
  // A company-tagged fact may ALSO name the person instead of the company — "Teodor
  // identified account context fragmentation across 5–10 systems", "Ysolde Marrick
  // advised weekly sprint planning". The model's about-tag is a judgment, not a
  // guarantee, and checking such a fact only against the employer name dropped correct
  // facts. So a company fact passes on EITHER name. A person fact stays strict: that is
  // the rule the claim_does_not_name_its_subject invariant measures, and the two must
  // not disagree.
  const namesSubject = (f) => claimAboutFor(f.category, f.about) === 'company'
    ? (companyNames.get(f.contactId)
        ? namesSubjectForTest(f.content, companyNames.get(f.contactId))
          || namesSubjectForTest(f.content, subjectNames.get(f.contactId))
        : true)
    : namesSubjectForTest(f.content, subjectNames.get(f.contactId));
  const offSubject = kept.filter(f => !namesSubject(f));
  kept = kept.filter(namesSubject);
  if (offSubject.length) {
    console.warn(`[SIGNAL_SUBJECT_GUARD] dropped ${offSubject.length} fact(s) that never name their subject:`,
      offSubject.map(f => `${normalizeClaimAbout(f.about) === 'company' ? companyNames.get(f.contactId) : subjectNames.get(f.contactId)} <- "${f.content}"`));
  }
  if (!kept.length) return [];

  // The fact first, without "X says Y's company …" in front (GET-962). After the subject guard, which
  // reads the model's sentence, and before the merge, so a new fact is compared in the words it will
  // be stored in. A person fact keeps its person as the subject.
  kept = kept.map(f => ({ ...f, content: factWording(f.content, {
    about: claimAboutFor(f.category, f.about), subjectName: subjectNames.get(f.contactId) ?? null, companyName: companyNames.get(f.contactId) ?? null,
  }) }));

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const results = [];

  const saidAtOf = (f) => f.saidAt ?? occurredAt ?? null;
  const decisions = await decideMergeBatch(supabase, workspaceId, kept.map(f => f.content),
    kept.map(f => ({ supporting_observation_ids: factSourceIds(f), metadata: { signal_type: type } })),
    kept.map(claimTargetEntity),
    kept.map(f => normalizeClaimCategory(f.category)),
    kept.map(saidAtOf),
    kept.map(f => (replacesAllowed(f) ? f.replacesClaimId : null)),
    // The person and their company: a deal fact voiced by the person replaces the company's too.
    kept.map(f => [claimTargetEntity(f), f.contactId, f.companyId]));

  // Saved facts, collected so the graph pass sees them together.
  const saved = [];
  const touchedContacts = new Set();
  // Accounts whose record just changed: a company fact, or a person's deal fact that the
  // account page rolls up. Each gets its summary refreshed (GET-223).
  const touchedCompanies = new Set();
  // People who got a fresh buying_signal — their stage + intent recompute in real time.
  const buyingSignalPersons = new Set();

  for (let i = 0; i < kept.length; i++) {
    const fact = kept[i];
    let { action, supersedes, restates, retiredBy, replacesOk } = decisions[i];
    // The extractor saw what was on file and said this fact REPLACES one of them (GET-770). It read
    // the whole conversation, so its word stands over the merge's — except a restatement (SKIP),
    // which means nothing moved. The older-new-fact guard applies here too.
    let reason = 'updated';
    // Only a target on the same record and for the same readers (replacesAllowed, replacesOk), and
    // only when we know when this fact was said — without a date it may be the older one.
    const newer = Date.parse(saidAtOf(fact) ?? '') || 0;
    if (fact.replacesClaimId && action !== 'SKIP' && replacesOk && newer) {
      const older = Date.parse(fact.replacesSaidAt ?? '') || 0;
      if (older && newer < older) { action = 'ADD'; supersedes = null; retiredBy = fact.replacesClaimId; }
      else { action = 'SUPERSEDE'; supersedes = fact.replacesClaimId; retiredBy = null; }
      reason = 'contradicted';
    }

    if (action === 'SKIP') {
      if (!dryRun && restates && uuidRe.test(restates)) {
        await corroborateNote(supabase, workspaceId, restates, factSourceIds(fact)).catch(() => {});
      }
      results.push({ ...fact, action: 'SKIP' });
      continue;
    }

    // Preview mode (re-extract dry-run): report what WOULD be saved, write nothing.
    if (dryRun) { results.push({ ...fact, action }); continue; }

    // A fact ABOUT THE COMPANY (ISO cert, buying committee, procurement model) belongs
    // on the company entity, not the one attendee who happened to voice it — so every
    // colleague on the account, and every future contact there, inherits it. A fact
    // about the person stays on the person. Falls back to the person if we couldn't
    // resolve their company. This is the multi-attendee fix: one company fact, one home.
    const about = claimAboutFor(fact.category, fact.about);
    const cat = normalizeClaimCategory(fact.category);
    const targetEntity = claimTargetEntity(fact);

    let newMem = null;
    try {
      newMem = await saveNote(supabase, workspaceId, {
        entityId: targetEntity,
        category: normalizeClaimCategory(fact.category),
        label:    typeof fact.label === 'string' ? fact.label.trim().slice(0, 40) || undefined : undefined,
        content:  fact.content,
        source:   'signal_extraction',
        // When it was SAID, not when we wrote it (GET-770). saveNote falls back to now.
        saidAt:   saidAtOf(fact),
        // The structural evidence chain: this claim points back to the source
        // activity observation it was extracted from (claims.supporting_observation_ids).
        // A thread fact carries every message it was read from, so each one's readers can see it.
        supportingObservationIds: factSourceIds(fact).length ? factSourceIds(fact) : undefined,
        metadata: {
          about,
          signal_type:        type,
          extraction_source:  source,
          source_activity_id: fact.activityId || null,
          // THE SENTENCE THIS RESTS ON, already checked verbatim against the source (noema/
          // grounding.mjs). Insights have always carried one; claims — the account record a rep
          // reads before a call — carried nothing, so "he pushed back and called it super
          // important" could not be questioned by a person or by a machine. Null means no
          // verifiable line was offered, and means only that: an unchecked quote is never stored.
          quote: typeof fact.quote === 'string' && fact.quote ? fact.quote : null,
          // WHO SAID IT. The quote answers "which line does this rest on"; alone it cannot answer
          // "and who said it" — which is the other half of checking a fact in a room of eight
          // people, because a claim about the director resting on a line an assistant spoke reads very
          // differently. The read path already renders it and the plugin's write path has always
          // stored it; only the worker never asked the model for one, so every claim the platform
          // extracted itself had a checkable quote and an anonymous speaker (GET-374). Trimmed to
          // the same 80 chars `record` uses, so the two writers agree.
          speaker: typeof fact.speaker === 'string' && fact.speaker.trim()
            ? fact.speaker.trim().slice(0, 80) : null,
          ...(fact.sourceActivityIds?.length > 1 ? { source_observation_ids: factSourceIds(fact) } : {}),
          // Provenance: which contact voiced a company fact, so the company record can
          // show "from Perpetua on the Ashworth call" without duplicating the fact.
          voiced_by_contact_id: about === 'company' ? fact.contactId : null,
          // WHICH SOURCE THIS CLAIM CAME OUT OF (GET-359). It was passed into the extractor and
          // used only to label error events, so a claim had no link back to the meeting that
          // produced it. That makes "has this transcript been read" unanswerable from the claims
          // themselves — and a backfill's resume check has to answer exactly that, or it pays to
          // read the same year twice.
          ...(sourceRef ? { source_ref: sourceRef } : {}),
          // Context tags — a closed vocabulary alongside the prose, so a RULE can act on it.
          // "Osric left last month", "we lost Osric" and "Osric is no longer with us" are one
          // fact and three strings; `change` is what lets a departure end the authority claim it
          // contradicts, `role` is what puts a person on the org chart, and `stance`/`hardness`
          // are what computeDealHealth weighs.
          //
          // Declared beside the taxonomy (claimSubtagsFor) because the API writes claims too, and
          // the two lists had already drifted — `role` and `change` worked here and were silently
          // dropped on the plugin path (GET-364).
          ...claimSubtagsFor(cat, fact),
          // Free text beside the closed sets: `competitor.entity`, `expansion_signal.product`.
          // Declared with the taxonomy for the same two-writer reason (GET-401).
          ...claimFreeTextFor(cat, fact),
          graph_layer:        'private',
        },
      });
    } catch (err) {
      console.warn('[SIGNAL_EXTRACTOR] Insert error:', err.message);
      if (strict) throw err;
      continue;
    }

    // The replaced claim is retired with a link both ways, so the account keeps the history of a
    // position (GET-770). It used to be `updateNote({ is_active: false })` — retired, untraceable.
    if (newMem && action === 'SUPERSEDE' && supersedes && uuidRe.test(supersedes)) {
      await retireNote(supabase, workspaceId, supersedes, newMem.id, reason).catch(() => {});
    }
    // An older statement read after a newer one: on file, but already history.
    if (newMem && retiredBy && uuidRe.test(retiredBy)) {
      await retireNote(supabase, workspaceId, newMem.id, retiredBy, reason).catch(() => {});
    }

    if (newMem) {
      saved.push({ content: fact.content, memoryId: newMem.id });
      if (targetEntity !== fact.companyId) touchedContacts.add(targetEntity);
      if (fact.companyId && (targetEntity === fact.companyId || ACCOUNT_ROLLUP_CATEGORIES.includes(cat))) {
        touchedCompanies.add(fact.companyId);
      }
      if (cat === 'buying_signal' && fact.contactId) buyingSignalPersons.add(fact.contactId);
      // A person named in a Connections fact → a graph node. And a person named in a
      // MEETING's authority fact ("Bertrand owns the budget") → a buying-committee member
      // on the account. Both flow through the same resolver (resolve / stub / leave
      // ambiguous). Fire-and-forget; never blocks the save.
      if (cat === 'relationship' || (type === 'meeting_held' && cat === 'authority')) {
        linkMentionsFromClaim({
          supabase, workspaceId, subjectEntityId: fact.contactId,
          content: fact.content, sourceMemoryId: newMem.id,
        }).catch(err => console.warn('[MENTIONS_HOOK]', err.message));
      }
    }
    results.push({ ...fact, action });
  }

  // One graph-edge call for the whole conversation. Relationships often only show
  // up ACROSS facts — and across PEOPLE on a call, which the old per-contact pass
  // could never see, because it only ever looked at one attendee at a time.
  if (saved.length) {
    extractGraphEdgesBatch(supabase, workspaceId, saved, {
      contact_id: kept[0]?.contactId ?? null,
      source: 'signal_extraction',
    }).catch(() => {});
  }

  console.log(`[SIGNAL_EXTRACTOR] ${results.length} facts — ${type}/${source} — ${touchedContacts.size} contact(s)`);

  if (!dryRun) {
    // A company target never went through here usefully: refreshContactBlock resolves a
    // PERSON subject, found none, and logged SUBJECT_UNRESOLVED. Companies get their own.
    for (const cid of touchedContacts) {
      refreshContactBlock(supabase, cid, workspaceId).catch(() => {});
    }
    for (const coId of touchedCompanies) scheduleCompanySummary(workspaceId, coId);
    // Real-time: a buying signal just landed, so advance stage + rescore intent now
    // instead of waiting for the daily cron. Fire-and-forget; never blocks the save.
    for (const pid of buyingSignalPersons) {
      recomputeEntityStage(supabase, workspaceId, pid).catch(() => {});
      runIntentScoring(supabase, workspaceId, { persons: [{ entity_id: pid, domain: null }], write: true })
        .catch(() => {});
    }
    if (buyingSignalPersons.size) {
      console.log(`[BUYING_SIGNAL] recomputed stage+intent for ${buyingSignalPersons.size} person(s)`);
    }
  }
  return results;
}

// ── Meeting extraction (all attendees, one pass) ──────────────────────────────
//
// A meeting used to be extracted once PER ATTENDEE. Each pass re-sent the whole
// transcript and asked "what does this tell me about ${oneName}?", so a call with
// three prospects paid for the transcript three times.
//
// That was expensive, and it was also worse at the job. The interesting things on
// a call are usually relational — who defers to whom, who owns the budget, who is
// actually blocking — and none of that is visible when the model can only see one
// attendee at a time.
//
// So: one call, every external attendee named, each fact tagged with who it is
// about. Cheaper AND it can finally see the room.
/**
 * Whether a meeting was already read: a claim cites it (value.metadata.source_ref), or the read
 * ledger stamped it (observation external_id read_<source_ref>, workers/readLedger.mjs).
 */
export async function meetingAlreadyRead(supabase, workspaceId, sourceRef) {
  try {
    const { data: cited } = await supabase.from('claims').select('id')
      .eq('workspace_id', workspaceId).eq('value->metadata->>source_ref', sourceRef).limit(1);
    if (cited?.length) return true;
    const { data: stamped } = await supabase.from('observations').select('id')
      .eq('workspace_id', workspaceId).eq('external_id', `read_${sourceRef}`).limit(1);
    return !!stamped?.length;
  } catch {
    return false;   // unknown: read it rather than drop it
  }
}

export async function extractMeetingSignals({
  supabase, workspaceId, participants, summary, source,
  maxFactsOverride, dryRun = false, occurredAt = null,
  // The names on OUR side of the call, as the transcript labels them (GET-417). A fact whose quote
  // was spoken by one of them is the rep's pitch or the rep's guess, not the customer's fact.
  ourNames = [],
  // The call-insights pass. Off for a backfill: a meeting re-read months later would
  // file its insights again beside the ones ingest already filed.
  insights = true,
  // ⭐ WHERE this call is, not what it is called. `sourceLabel` below is a display string
  // ("Harborline, Quillfield") assembled from participant names; it cannot be resolved back to
  // anything. This is the pointer, and its absence is the whole reason insights could never
  // be cited: the extractor was handed the words and never told which call they came from.
  sourceRef = null,
  // A backfill replay (GET-852): skip a meeting that was already read, so continuing or re-running
  // a backfill never sends the same call to the model twice. Live webhooks leave it off, since a
  // meeting can legitimately arrive twice (the summary first, the full transcript later).
  onceOnly = false,
}) {
  try {
    if (onceOnly && sourceRef && !dryRun && await meetingAlreadyRead(supabase, workspaceId, sourceRef)) return [];
    // THE CREDIT GATE (GET-531). Reading is what spends credits, so this is where the band
    // has to bite — one question per workspace per five minutes, in front of every caller:
    // the webhook handlers, the rollups, the re-extraction passes. The activity is already
    // recorded by the time we get here; what pauses is the reading of it, which is the promise
    // the billing page makes. Fails open — see lib/creditGate.mjs.
    const gate = await mayReadWorkspace(workspaceId);
    if (!gate.allowed) return [];
    if (!summary || summary.length < 20) return [];
    if (!participants?.length) return [];
    setUser({ id: String(workspaceId) });

    // Insights about US, mined from this call, in parallel with the facts about
    // THEM. Runs once per call regardless of attendee count (so it sits above the
    // 1:1 branch below), never blocks the fact extraction, and lands in the
    // workspace Insights docs, not on any contact. Skipped on dry runs.
    if (!dryRun && insights) {
      const sourceLabel = [...new Set(
        participants.map(p => p.company || p.name).filter(Boolean),
      )].join(', ') || null;
      const attendees = [...new Set(participants.map(p => p.name).filter(Boolean))];
      setImmediate(() =>
        // Bounded as ingest bounded it before facts learned to read long calls in parts:
        // insights run on a larger model and read the transcript in one pass.
        extractCallInsights({ supabase, workspaceId, transcript: summary.slice(0, 60_000), sourceLabel, attendees, occurredAt, sourceRef, sourceSystem: source, groundAgainst: summary, ourNames })
          .catch(err => console.warn('[INSIGHT_HOOK_ERROR]', err.message)),
      );
    }

    // A 1:1 call is the common case, and the single-person prompt is sharper for
    // it (it can say "these are Sarah's own words" rather than hedging across a
    // roster). Nothing is saved by generalising it, so don't.
    if (participants.length === 1) {
      const p = participants[0];
      return await extractActivitySignals({
        supabase, workspaceId, contactId: p.contactId, activityId: p.activityId,
        type: 'meeting_held', source, summary, maxFactsOverride, dryRun, occurredAt, ourNames,
        // The meeting path already holds the ref; dropping it here is what made a
        // 1:1 call indistinguishable from an unread one (GET-375).
        sourceRef,
      });
    }

    const roster = participants
      .map((p, i) => `${i + 1}. ${p.name}${p.company ? ` (${p.company})` : ''}`)
      .join('\n');

    // The ceiling scales with the room, but sub-linearly: a 4-person call does not
    // hold 4x the durable intelligence of a 1:1, and a per-person ceiling would
    // invite padding. Still a SAFETY limit, never a target — per part of a long call.
    const maxFacts = maxFactsOverride ?? Math.min(24, 8 + 4 * participants.length);
    const ourSide = await loadOurSide(supabase, workspaceId, { activityId: participants[0]?.activityId, text: summary });
    const positionsOnFile = await loadPositionsOnFile(supabase, workspaceId,
      participants.flatMap(p => [p.contactId, p.companyId]), { excludeSourceRef: sourceRef });

    // A long call is read in parts, each persisted before the next is read, so the merge
    // decision on a later part sees what an earlier part saved (see splitForExtraction).
    const { context, parts } = splitForExtraction(summary);
    const partBudget = perPartFactCap(callFactBudget(maxFacts, parts.length), parts.length);   // one budget per call, growing a little with length (GET-789)
    const saved = [];
    const heardAboutUs = [];   // claims about us (GET-969), filed once the whole call is read
    // One part, read once — or, when the model returns nothing for it, read again as two halves
    // (GET-415). Returns the facts found and the transcript text they must be grounded against.
    const criteria = await extractionCriteria(supabase, workspaceId);
    const readPart = async (text, label, allowHalving) => {
      const msg = await createMessage({
        meter: false,
        feature: 'meeting-signals-extract',
        model: pipelineModel(),
        max_tokens: Math.min(5000, Math.max(1500, partBudget * 200)) + ABOUT_US_TOKENS,   // room to think, see buildActivitySignalsPrompt
        accept: (t) => parseJsonArray(t) !== null,
        messages: [{ role: 'user', content: buildMeetingSignalsPrompt({
          roster, transcript: text, maxFacts: partBudget, ourSide, positionsOnFile,
          part: { ...label, context, already: saved.map(f => f.content).filter(Boolean) },
        }) + criteria }],
      });
      await meterLLM(supabase, workspaceId, 'signal-extraction', msg);
      const parsed = parseJsonArray(msg.content[0]?.text);
      let facts = null;
      if (parsed !== null) {
        const { claims, aboutUs, routed } = routeFacts(resolveReplaces(parsed, positionsOnFile));
        if (routed.our_product || routed.market || routed.low_importance) console.log(`[ROUTER] meeting: ${routed.our_product} product feedback, ${routed.market} market view(s) kept as claims about us, ${routed.low_importance} low-importance dropped`);
        facts = [...claims.slice(0, partBudget), ...aboutUs.map(markAboutUs)];
      }
      if (facts !== null) return [{ facts, text }];
      const halves = allowHalving ? halveForRetry(text) : null;
      if (!halves) {
        console.warn(`[MEETING_EXTRACTOR_PARSE_FAIL] ${msg.model}: no JSON array — part ${label.index + 1}/${label.total}`);
        await recordPipelineEvent(supabase, { workspaceId, kind: 'unparseable', feature: 'meeting-signals-extract', model: msg.model, detail: { part: label.index + 1, parts: label.total, source_ref: sourceRef } });
        return [];
      }
      console.warn(`[MEETING_EXTRACTOR_HALVED] part ${label.index + 1}/${label.total}: no answer for ${text.length} chars — reading it as two halves`);
      const out = [];
      for (const half of halves) out.push(...await readPart(half, label, false));
      return out;
    };
    for (let index = 0; index < parts.length; index++) {
      for (const { facts, text: shown } of await readPart(parts[index], { index, total: parts.length }, true)) {
      const kept = facts
        .filter(f => f?.content && typeof f.content === 'string')
        .map((f) => {
          // An unattributable fact is worse than no fact: it would land on the wrong
          // person's record and read as truth. Drop it rather than guess.
          const p = participants[Number(f.person) - 1];
          return p ? { ...f, content: tidyFactContent(f.content, ourSide), contactId: p.contactId, activityId: p.activityId, companyId: p.companyId ?? null } : null;
        })
        .filter(Boolean);
      // Checked against the exact transcript text the model was shown: a line it did not read
      // there is one it made up, and an unchecked quote reads as evidence without being any.
      const { facts: grounded, offered, grounded: ok } = groundFacts(kept, shown);
      if (offered) console.log(`[GROUNDING] meeting-signals-extract: ${ok}/${offered} quotes verbatim in the transcript`);
      // Our words are not their facts (GET-417): drop a fact whose grounded quote our side spoke.
      const theirs = grounded.filter(f => !(f.quote && spokenByOurSide(f.quote, shown, ourNames)));
      if (theirs.length < grounded.length) console.log(`[GROUNDING] meeting-signals-extract: dropped ${grounded.length - theirs.length} fact(s) quoting our own side`);
      const { claims: forThem, aboutUs: forUs } = splitAboutUs(theirs);
      heardAboutUs.push(...forUs);
      if (!forThem.length) continue;
      saved.push(...await persistFacts(supabase, workspaceId, forThem, { type: 'meeting_held', source, dryRun, sourceRef, occurredAt }));
      }
    }
    if (!dryRun && heardAboutUs.length) await saveAboutUsClaims(supabase, workspaceId, heardAboutUs, { sourceRef, sourceSystem: source ?? null, occurredAt });
    return saved;
  } catch (err) {
    console.warn('[MEETING_EXTRACTOR_ERROR]', err.message);
    if (err instanceof ModelUnavailableError) {
      await recordPipelineEvent(supabase, { workspaceId, kind: 'unavailable', feature: 'meeting-signals-extract', model: err.model, detail: { status: err.status, message: String(err.message).slice(0, 300), source_ref: sourceRef } });
    }
    return [];
  }
}

/** The multi-attendee meeting prompt. One part of the transcript per call; see splitForExtraction. */
export function buildMeetingSignalsPrompt({ roster, transcript, maxFacts, ourSide = null, part = null, positionsOnFile = [] }) {
  const we = ourSideLabel(ourSide);
  return `Extract durable CRM intelligence from this meeting transcript.

These are notes/transcript from a call. The people below are the EXTERNAL attendees — the ones we are selling to or working with. Record facts about THEM, drawn from what they reveal about themselves, their company, needs, constraints, opinions, or plans. ALSO record facts about the RELATIONSHIP between an attendee and ${we}: how they found ${we} or why they reached out (a video, post, referral, or event), anything they offered ${we} or introductions they can make, and any objection or critique they raised about the product or how it differs from alternatives.

EXTERNAL ATTENDEES:
${roster}

Our side of the call is ${we}. Do NOT turn our side's questions or statements into facts about an attendee — if ${we} asked "what's driving the timeline?", that is NOT a fact that they care about timelines. But an offer, an introduction, a critique, or a reason-for-reaching-out that an ATTENDEE genuinely voices IS a fact about them and must be recorded.

${partPreamble(part)}
Transcript: "${transcript}"

A fact is worth recording ONLY if it passes ALL FOUR bars:
1. ABOUT THEM — a fact about an external attendee or their business, never about ${we} or our product. Our roadmap, our pricing, our partnership, a defect in our tool, what ${we} demoed, offered or promised: none of those is a fact about them, however much of the call it took up. The test is whose record it belongs on. Two things that DO pass: an objection is their reaction to us and belongs to them, and a fact ${we} states ABOUT an attendee is still a fact about that attendee.
2. DURABLE — still true weeks or months from now. A meeting time, an availability, or a reschedule is NOT durable. FOUR EXCEPTIONS, all decision-critical the instant they happen: a buying signal from a prospect (they asked for the agreement/contract, accepted or agreed to pricing, gave a verbal commit, said they are ready to move forward or to take it to the other stakeholders, or asked to start/onboard) → category buying_signal; a stated result in their business (a record month, a slump, leads or sales up or down, a target hit or missed) → category performance; an existing customer asking for, considering or declining MORE of what we sell (a product they lack, more seats or locations, an upgrade) → category expansion_signal; and an existing customer saying the relationship is in question (cancelling, giving notice, reviewing vendors, escalating a billing or service failure) → category risk_signal. All are snapshots rather than states, and all are recorded anyway.
3. DECISION-RELEVANT — it would change how someone sells to or works with them: budget, authority, pain, goals, stack, or buying timeline — OR how the relationship should be worked: how they found ${we}, what they offered ${we}, or the objection they raised about the product.
4. SPECIFIC — it carries the concrete detail or the reason WHY, not a vague label. "Evaluating Clay vs Apollo because Apollo's data went stale", not "looking at tools".

NEVER record (noise, or it already lives elsewhere in the CRM):
- Meeting logistics: scheduling, availability, reschedules, invites.
- Generic sentiment, small talk, greetings, pleasantries.
- Anything true today but meaningless next week.

Tag each fact with:
- "person": the NUMBER of the attendee it is about (from the list above).
- "category": exactly one of: ${CLAIM_CATEGORY_KEYS.join(', ')}.
- "about": "person" for a fact about that individual, "company" for a fact about their company.
- "label": a 2–4 word tag naming the SUBSTANCE (what a rep skims on a card), NOT the person's name. Competitor → the vendor name ("Pearl Lantern"); objection → the objection ("Already on Salesforce"); pain/goal → the pain/goal ("Stale Apollo data", "Expand to healthcare"). Sentence case: capitalise only the first word and names ("Already on Salesforce", not "Already On Salesforce"). No trailing period.
- CONTEXT TAGS (they decide whether a signal is a real risk):
  - competitor → ONLY a product that does the job described under WHAT ${(ourSide?.companyName || 'our company').toUpperCase()} SELLS. A tool in their stack that does something else (CRM, call recorder, notes/agenda tool, data vendor) is status_quo, never competitor. Set "entity" (vendor name only) + "stance": "evaluating" (live alternative to us) / "incumbent" (they use it for the job we do) / "past_failure" (tried for that job and failed/fired — LOWERS risk, it's an opening) / "mentioned".
  - objection → "status": "open" / "resolved" / "addressed"; and "hardness": "hard" (budget, authority, security, legal, procurement) / "soft" (info, timing, minor).
  - expansion_signal → an EXISTING customer asking for more of what we sell. Set "product" (the family name from WHAT WE SELL, regional suffixes dropped) + "stance": "asked" / "considering" / "declined". NEVER omit "stance": a decline read as an ask sends a rep to pitch what the customer just refused. A feature request about a product they already own is pain.
  - risk_signal → an EXISTING customer saying the relationship is in question. Set "severity": "stated_churn" (cancelled, gave notice, leaving) / "at_risk" (reviewing vendors, questioning value, escalating) / "friction" (billing, invoicing, support or service failure raised with frustration, no threat to leave).
  - tech_stack → a tool they use and any fact about it (who drives it, cost, their view of it, a decision about it). Set "tool" to its name, one tool per fact. Not risk_signal, and not competitor unless it does the job WE do.
  - blocker → what stands between now and a signed deal (others to sign off, no onboarding plan, internal politics, missing access, a pending review). Set "status": "open" / "resolved". A setup step already done (access granted, a file shared) is not a blocker.
  - buying_signal → a decision moving toward the deal, never a setup step (pushing an NDA through, giving access or API keys, promising to send a list).
  - requirement → a hard condition for buying, not a wish.

${ourOfferBlock(ourSide)}Categories:
${claimCategoryPromptBlock()}
${GENERAL_IS_LAST_RESORT}
Rules:
- Each fact is one self-contained sentence naming the person explicitly (no pronouns). Name them as the one doing or wanting the thing, never as a speaker: "Sam is moving support to Zendesk", not "Sam says the company is moving support to Zendesk". Never "Sam's company X's …". Short and plain: the fact, its detail, nothing about who said it (that is stored separately).
- ${ourSideRule(ourSide)}
- State only what the attendee said or plainly did. Never add your own reading of what it implies — no "indicating…", "suggesting that…", "which shows…", "meaning…", "as evidenced by…".
- Attribute each fact to the attendee it is genuinely ABOUT. A fact one person states about another belongs to whoever it describes.
- Extract EVERY fact that clears all four bars — there is no target number, and no requirement that every attendee yields one. A quiet attendee may yield none. NEVER pad, NEVER split one fact into several, NEVER restate the same fact twice.
- Hard ceiling of ${maxFacts} facts with home "claim" across ALL attendees — a safety limit, not a goal. What they say about us (our_product, market) does not count toward it.

${DEAL_BAR}

${ROUTING_RULES}

${positionShiftBlock(positionsOnFile)}

Output ONLY valid JSON: [{${HOME_FIELD}, "person": 1, "content": "...", "quote": "...", "speaker": "...", "label": "2-4 word tag", "category": "<key>", "about": "person|company", "entity": "<competitor only>", "stance": "<competitor only>", "status": "<objection or blocker only>", "tool": "<tech_stack only>", "hardness": "<objection only>", "change": "<staff_change only>", "role": "<authority only>", "product": "<expansion_signal only>", "severity": "<risk_signal only>"${positionsOnFile?.length ? REPLACES_FIELD : ''}}]

  - staff_change → set "change": "left" / "joined" / "moved" / "reorg" / "away" (out for months, not a week off). Name the person in "content".
  - authority → set "role": "economic_buyer" (holds the budget or signs) / "decision_maker" (chooses, or their approval unblocks it) / "champion" (pushes for us internally) / "blocker" (is stopping it) / "technical" (judges whether it works). It must describe the attendee the fact is ABOUT. Leave it out when the fact names someone else's authority, when it only restates a job title, or when they simply use the product.

- "quote": the line from the transcript this fact rests on, VERBATIM — copied exactly, not rephrased, not tidied, max ~25 words. It is checked against the transcript and dropped if it is not found there, so never invent or paraphrase one. Use "" if the fact rests on no single line.
- "speaker": the transcript's own label for whoever spoke that line. This is NOT the same as the attendee the fact is about — one person describing another is the common case in a review call, and the pair is what makes the fact checkable. Use "" if the line has no speaker label.
If nothing meaningful: []`;
}

// ── People named in a Connections claim → graph nodes ─────────────────────────
//
// A Connections fact ("Jack shares a warm connection with Ottoline") names a person.
// This pulls those names out (NER) and hands each to the core mention resolver,
// which turns it into a real, taggable graph node WITHOUT guessing identity —
// resolve to a unique existing account, leave an ambiguous name for a human, or stub
// a pending node. That is what makes "@Ottoline" a traversable node and lets "what
// warm connections can we use?" reach an account, not just read a name.
//
// Only runs on relationship/Connections facts — we don't want to stub every name
// dropped in a pain or status fact.
const MENTION_ROLES = new Set(['champion', 'blocker', 'budget_holder', 'decision_maker', 'none']);

async function extractPersonNamesFromClaim(supabase, workspaceId, content, subjectName) {
  try {
    const result = await read({
      supabase, workspaceId,
      feature: 'mention-names-extract',
      meterAs: 'signal-extraction',
      accept: acceptsArray,
      parse: parseArray,
      maxTokens: 300,
      prompt: `From this fact, list the specific real PEOPLE named in it, OTHER than "${subjectName}", each with the buying role the fact states about them IF any. Only actual named individuals — never a company, tool, product, role, or place.

Fact: "${content}"

For each person: {"name": "...", "role": "champion|blocker|budget_holder|decision_maker|none"}. Use a role ONLY when the fact clearly states it — champions/supports us (champion), blocks/opposes (blocker), owns/controls the budget (budget_holder), makes the final call (decision_maker). Otherwise "none".

Return ONLY a JSON array, e.g. [{"name":"Bertrand","role":"budget_holder"}]. Return [] if no other person is named.`,
    });
    // An unreadable answer used to return [] — the same value as "nobody else is named in this
    // fact" — and the mention was lost with no record (GET-320).
    if (!result.ok) return [];
    const arr = result.value;
    const out = [];
    const seen = new Set();
    for (const p of arr) {
      const name = typeof p?.name === 'string' ? p.name.trim() : (typeof p === 'string' ? p.trim() : '');
      if (name.length < 2 || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const role = MENTION_ROLES.has(p?.role) ? p.role : 'none';
      out.push({ name, role });
    }
    return out;
  } catch {
    return [];
  }
}

export async function linkMentionsFromClaim({
  supabase, workspaceId, subjectEntityId, subjectName, content, sourceMemoryId, dryRun = false,
}) {
  let subj = subjectName;
  if (!subj && subjectEntityId) {
    const { data } = await supabase.from('contacts').select('first_name, last_name').eq('id', subjectEntityId).maybeSingle();
    subj = data ? [data.first_name, data.last_name].filter(Boolean).join(' ') : null;
  }

  // The subject's company — so a colleague they name joins THIS account's buying
  // committee (MENTIONED_AT), not just a floating person↔person link.
  let companyId = null, companyLabel = null;
  if (subjectEntityId) {
    const { data: rel } = await supabase.from('relationships')
      .select('to_entity_id').eq('workspace_id', workspaceId)
      .eq('from_entity_id', subjectEntityId).eq('type', 'works_at').is('valid_to', null).limit(1);
    companyId = rel?.[0]?.to_entity_id ?? null;
    if (companyId) {
      const { data: co } = await supabase.from('companies').select('name, domain').eq('id', companyId).maybeSingle();
      companyLabel = co?.name || co?.domain || null;
    }
  }

  const people = await extractPersonNamesFromClaim(supabase, workspaceId, content, subj || 'the account');
  const results = [];
  for (const { name, role } of people) {
    if (dryRun) {
      results.push({ name, role, ...(await resolvePersonMention(supabase, workspaceId, name)) });
      continue;
    }
    results.push(await linkPersonMention(supabase, workspaceId, {
      subjectEntityId, subjectLabel: subj || 'the account', name, sourceMemoryId,
      companyId, companyLabel, role,
    }));
  }
  if (!dryRun && sourceMemoryId && results.length) {
    // Persist the linked mentions onto the claim so the Intel card renders the @tags.
    await tagClaimMentions(supabase, sourceMemoryId, results).catch(() => {});
  }
  if (results.length && !dryRun) {
    console.log(`[MENTIONS] ${results.map(r => `${r.label}:${r.status}`).join(', ')} — from ${subjectEntityId}`);
  }
  return results;
}

// ── Conversation-thread rollup (the whole back-and-forth, one pass) ───────────
//
// Per-message extraction judges each DM in isolation, so intel that only exists
// ACROSS the thread never lands: a shared connection named in one line, a role in
// another, "the one source of truth you talked about" three messages up. Each short
// message reads as a pleasantry on its own and yields []. This pass loads the whole
// two-sided conversation, labels each side, and mines durable facts from the
// exchange as a unit.
//
// ADDITIVE and safe to re-run: persistFacts dedups against the notes the per-message
// pass already saved (decideMergeBatch → SKIP), so overlap collapses and only
// genuinely new relational facts are written.
const THREAD_MIN_MESSAGES = 4;    // below this, per-message extraction already suffices
const THREAD_MAX_MESSAGES = 60;   // cap the transcript sent to the model

export async function extractConversationThread({
  supabase, workspaceId, contactId, source = 'conversation_rollup',
  maxFactsOverride, minMessages = THREAD_MIN_MESSAGES, dryRun = false,
}) {
  try {
    // THE CREDIT GATE (GET-531). Reading is what spends credits, so this is where the band
    // has to bite — one question per workspace per five minutes, in front of every caller:
    // the webhook handlers, the rollups, the re-extraction passes. The activity is already
    // recorded by the time we get here; what pauses is the reading of it, which is the promise
    // the billing page makes. Fails open — see lib/creditGate.mjs.
    const gate = await mayReadWorkspace(workspaceId);
    if (!gate.allowed) return [];
    // Full-access read (no ctx) — this is a system pass, not a member view.
    const acts = await listActivities(supabase, {
      contactId, types: ['linkedin_message'], limit: THREAD_MAX_MESSAGES,
    });
    // One conversation per teammate's account. Two reps messaging the same person are two private
    // threads; stitched into one transcript, facts from one founder's messages would be pinned to
    // the other's and readable by both (GET-253).
    const byOwner = new Map();
    for (const a of acts) {
      const k = a.owner_user_id ?? '';
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(a);
    }
    const out = [];
    for (const ownerActs of byOwner.values()) {
      out.push(...await rollupOneThread({ supabase, workspaceId, contactId, source, maxFactsOverride, minMessages, dryRun, acts: ownerActs }));
    }
    return out;
  } catch (err) {
    console.warn('[THREAD_ROLLUP_ERROR]', err.message);
    return [];
  }
}

async function rollupOneThread({ supabase, workspaceId, contactId, source, maxFactsOverride, minMessages, dryRun, acts }) {
  try {
    // listActivities is newest-first; a transcript reads oldest-first.
    const msgs = acts.filter(a => (a.summary || a.description || '').trim()).reverse();
    if (msgs.length < minMessages) return [];

    // Same projection lag as the single-message pass — and worse here, because a
    // thread carries BOTH sides, so a nameless subject has two candidates to
    // confuse instead of one. See loadSubject.
    const contact = await loadSubject(supabase, contactId);
    if (!contact) return [];
    const contactName = contact.name;

    // Direction comes from raw_data (the writer stamps is_outbound on every
    // message); the "You:" summary prefix is the fallback for older rows.
    const toLine = (a) => {
      const raw = a.raw_data || {};
      const outbound =
        raw.is_outbound === true || raw.is_sender === true || /^you:\s*/i.test(a.summary || '');
      const text = (a.summary || a.description || '').replace(/^you:\s*/i, '').trim();
      return `${outbound ? 'You' : contactName}: ${text}`;
    };
    const transcript = msgs.map(toLine).join('\n');

    // Anchor the derived facts to the newest message so the claim's supporting
    // observation points at a real activity row.
    const anchorActivityId = acts[0]?.id ?? null;

    return await extractActivitySignals({
      supabase, workspaceId, contactId,
      activityId: anchorActivityId,
      sourceActivityIds: msgs.map(a => a.id),
      type:       'conversation_thread',
      source,
      summary:    transcript,
      maxFactsOverride,
      dryRun,
      // A DM thread is someone's private conversation (GET-985); its claims about us are filed once
      // per thread, and our own "You:" lines are never their words (GET-969).
      quotePrivate: true,
      aboutUsRef: `thread://${source ?? 'dm'}/${contactId}`,
      ourNames: ['You'],
      // A thread is as current as its newest message (GET-770).
      occurredAt: acts[0]?.occurred_at ?? null,
    });
  } catch (err) {
    console.warn('[THREAD_ROLLUP_ERROR]', err.message);
    return [];
  }
}

// ── Message action items ─────────────────────────────────────────────────────
// Mine commitments/asks out of a message and record them as action_item.* state
// observations (Phase 1's store; see reference-nous-action-items). Runs on BOTH
// directions — an outbound "I'll send the deck" is the user's own commitment, so
// this can't sit behind the inbound-only guard that the facts extractor uses.
// owner is decided from the message's direction + who is committing/being asked.
//
// Meetings don't come through here: Fireflies already extracts action items by
// speaker, so that path parses them (utils/actionItems.mjs) with no model call.
// Text channels have no such structure, so we read them.
//
// The activity type → the channel it belongs to. The channel key is part of the
// observation property, so it must stay stable: 'email' items keep the same key
// they have always had, and reprocessing stays idempotent.
const ACTION_ITEM_CHANNELS = new Map([
  ['email_reply',      'email'],
  ['email_received',   'email'],
  ['linkedin_message', 'linkedin'],
  ['linkedin_replied', 'linkedin'],
]);

const CHANNELS = {
  email: {
    label: 'email',
    // An email under 40 chars is a "thanks!" — nothing to mine.
    minLength: 40,
    // Emails are composed; commitments in them are usually explicit.
    guidance: 'Skip greetings, FYIs, and vague statements.',
  },
  linkedin: {
    label: 'LinkedIn message',
    // DMs are short by nature. "I'll send the MVP Friday" is 24 characters and
    // is a real commitment — a 40-char floor would drop it.
    minLength: 24,
    // ...but the flip side is that most DMs are pleasantries, and a model given a
    // chatty message will happily invent a task out of it. So the bar is higher,
    // not lower, on the strictness of what counts.
    guidance:
      'LinkedIn DMs are mostly small talk — "sounds good", "let me know", "great chatting". Those are NOT action items. ' +
      'Only extract a specific deliverable someone explicitly committed to or explicitly asked for. ' +
      'Vague enthusiasm ("would love to see it") is not a commitment. When in doubt, return [].',
  },
};

async function extractMessageActionItems({
  supabase, activityId, contactId, workspaceId, source, summary, isOutbound, channel, occurredAt,
}) {
  // Anchor for resolving "in 4 days" / "by Friday" etc. — when the message was
  // actually sent, not whenever this extraction pass happens to run. Falls back
  // to now() for callers that don't have it, same as observedAt elsewhere.
  const anchor = occurredAt ? new Date(occurredAt) : new Date();
  // Tasks only from a message in the last 30 days (GET-514).
  if (!writesTasks(occurredAt)) return;
  const cfg = CHANNELS[channel];
  if (!cfg) return;
  if (!summary || summary.length < cfg.minLength) return;

  const c = await loadSubject(supabase, contactId);
  if (!c) return;
  const name = c.name;
  const direction = isOutbound === true
    ? `This ${cfg.label} was SENT BY the user (the founder / account owner) TO ${name}.`
    : `This ${cfg.label} was RECEIVED FROM ${name} (the prospect), addressed to the user.`;

  const result = await read({
    supabase, workspaceId,
    feature: `${channel}-action-items`,
    meterAs: 'signal-extraction',
    accept: acceptsArray,
    parse: parseArray,
    maxTokens: 400,
    prompt:
`Extract concrete action items / commitments from this ${cfg.label}. ${direction}

Tag each item's owner:
- "user" — the founder owes it (the user promised to do something, OR ${name} asked the user to do something)
- "prospect" — ${name} owes it (they promised, OR the user asked them to do it)

Only a CONCRETE commitment or explicit ask with a clear deliverable (send X, schedule Y, review Z, follow up by <date>). ${cfg.guidance} Be strict — if nothing is clearly actionable, return [].

${cfg.label}:
"""${summary.slice(0, 6000)}"""

Output ONLY valid JSON, max 4 items:
[{"title":"<imperative, names the deliverable>","owner_kind":"user|prospect","due_phrase":"<timing if stated, in English, else null>","context":"<ONE sentence of what exactly and why, for a reader without the message; empty if the title says it all>"}]`,
  });
  // An unreadable answer used to `return` with no log and no event, so a commitment the model DID
  // find could vanish and look exactly like a message that asked for nothing (GET-320).
  if (!result.ok) return;
  const items = result.value;

  let n = 0;
  // The workspace's own timezone (cached ~5 min in core) — "by Friday" said in
  // Mumbai must resolve against Mumbai's calendar, not the server's. Falls back
  // to NOUS_DEFAULT_TIMEZONE / UTC inside resolveDuePhrase when unset.
  const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
  // Provenance, stamped once here (GET-400): the message's own time, and the account's one open
  // deal when it has exactly one. A message has no title of its own; the source is named by kind.
  const deal = items.length
    ? await dealForTask(supabase, workspaceId, { companyEntityId: await companyOfContact(supabase, workspaceId, contactId).catch(() => null) })
    : { deal_id: null, deal_link: null };
  for (let i = 0; i < items.length && i < 4; i++) {
    const it = items[i];
    if (!it?.title || typeof it.title !== 'string') continue;
    const owner = it.owner_kind === 'prospect' ? 'prospect' : 'user';
    const rec = await recordObservation(supabase, {
      workspaceId, entityId: contactId, kind: 'state',
      // Deterministic per (channel, activity, index) — reprocessing the same
      // message overwrites rather than duplicating.
      property: `action_item.${channel}_${activityId}_${i}`,
      value: {
        ...emptyTaskProvenance(),
        ...provenanceFromModel(it, it.title),
        // Two people on a message: what we owe is for them, what they owe is for us.
        for_name:      owner === 'prospect' ? null : name,
        for_entity_id: owner === 'prospect' ? null : contactId,
        // Whoever wrote the message raised it, when that is not the side that owes it.
        asked_by:      (isOutbound === true) !== (owner === 'user') ? (isOutbound === true ? null : name) : null,
        occurred_at:   anchor.toISOString(),
        deal_id:       deal.deal_id,
        deal_link:     deal.deal_link,
        title:       it.title.trim(),
        owner_kind:  it.owner_kind === 'prospect' ? 'prospect' : 'user',
        status:      'open',
        due_phrase:  it.due_phrase || null,
        // Resolved from due_phrase against the message's own send time, so
        // "in 4 days" said on a Monday reads as Friday, not "4 days from
        // whenever this extraction pass happened to run". Null when the
        // phrase isn't confidently parseable (e.g. "after the demo") — the
        // raw due_phrase still displays even when due_at can't be computed.
        due_at:      dueDateAgreeingWith(resolveDuePhrase(it.due_phrase, anchor, timeZone), it.title),
        source_type: channel,
        source_id:   activityId,
      },
      source:     source || channel,
      method:     'extraction',
      externalId: `action_item_${channel}_${activityId}_${i}`,
    }).catch(() => null);
    if (rec) n++;
  }
  if (n) console.log(`[ACTION_ITEMS] ${n} from ${channel} — contact ${contactId}`);
}

// ── Conversation action items (Slack) ────────────────────────────────────────
// A channel conversation has several speakers on both sides, so the per-message miner above, which
// knows one prospect and "the user", cannot say who asked whom. This reads the whole conversation
// once and records the same `action_item.*` facts the Tasks page and the Next step read (GET-976),
// with who asked, who owes it, who else it involves, and the asker's own words.
//
// What the model says is checked against the conversation before anything is kept:
//   quote        verbatim from one message (whitespace aside); that message's author is the asker
//   owner        a participant or a person mentioned in it; our side owes it, or theirs does
//   commitment   requested: someone asked and nobody has said yes · accepted: the side that owes
//                it said yes in a later message (quoted) · scheduled: accepted AND a time was stated.
//                Anything the conversation does not show is downgraded, never upgraded.
// No due date is invented: due_at only resolves from a timing phrase found in the conversation.

/** Whitespace-insensitive text for quote matching. */
const squash = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Check one model item against the conversation. Pure, so the rules are pinned with fixtures.
 * `messages`: [{ speaker, side: 'internal'|'external', text, ts, occurredAt, activityId, contactId }]
 * `people`: [{ name, side, contactId }] — everyone the conversation names, speakers and mentions.
 * Returns the stored fields, or null when the item is not supported by what was said.
 */
export function checkConversationActionItem(item, { messages = [], people = [], twoParty = false } = {}) {
  if (!item || typeof item.title !== 'string' || !item.title.trim()) return null;
  const q = squash(item.quote);
  if (q.length < 8) return null;
  const said = messages.find(m => squash(m.text).includes(q));
  if (!said || !['internal', 'external'].includes(said.side)) return null;
  const byName = (name) => {
    const n = squash(name).replace(/^@/, '');
    if (!n) return null;
    const exact = people.filter(p => squash(p.name) === n);
    if (exact.length === 1) return exact[0];
    const first = people.filter(p => squash(p.name).split(' ')[0] === n.split(' ')[0]);
    return first.length === 1 ? first[0] : null;
  };
  const ownerSide = item.owner_kind === 'prospect' ? 'external' : 'internal';
  const owner = byName(item.owner);
  // An owner named on the wrong side is a misread; keep the side, drop the name.
  let ownerPerson = owner && owner.side === ownerSide ? owner : null;
  // A teammate's own DM has one speaker per side, so an unnamed owner can only be that person
  // (GET-1003). A channel can hold silent teammates, so it never guesses. Only a blank owner is
  // filled: a name we could not place ("get Priya from engineering to…") is someone else.
  if (!ownerPerson && twoParty && !String(item.owner ?? '').trim()) {
    const speakers = [...new Map(messages.filter(m => m.side === ownerSide && m.speaker)
      .map(m => [m.speaker, { name: m.speaker, side: m.side, contactId: m.contactId ?? null }])).values()];
    if (speakers.length === 1) ownerPerson = speakers[0];
  }
  const participants = [...new Set((Array.isArray(item.participants) ? item.participants : []).map(byName).filter(Boolean))]
    .filter(p => p.name !== said.speaker && p.name !== ownerPerson?.name)
    .map(p => ({ name: p.name, side: p.side, entity_id: p.contactId ?? null }));
  // Acceptance only counts when the side that owes it said so, after the ask, in its own words.
  let commitment = 'requested';
  let acceptedQuote = null;
  const aq = squash(item.accepted_quote);
  if (['accepted', 'scheduled'].includes(item.commitment) && aq.length >= 2) {
    const yes = messages.find(m => m.side === ownerSide && Number(m.ts) > Number(said.ts) && squash(m.text).includes(aq));
    if (yes) { commitment = 'accepted'; acceptedQuote = String(item.accepted_quote).trim(); }
  }
  // When said by the side that owes it, an own promise ("I'll send the deck") is accepted by saying it.
  if (said.side === ownerSide && commitment === 'requested') commitment = 'accepted';
  const duePhrase = typeof item.due_phrase === 'string' && item.due_phrase.trim() ? item.due_phrase.trim() : null;
  const phraseSaid = duePhrase && messages.some(m => squash(m.text).includes(squash(duePhrase)));
  if (item.commitment === 'scheduled' && commitment === 'accepted' && phraseSaid) commitment = 'scheduled';
  return {
    title: item.title.trim().slice(0, 200),
    owner_kind: ownerSide === 'external' ? 'prospect' : 'user',
    owner_name: ownerPerson?.name ?? null,
    owner_entity_id: ownerPerson?.contactId ?? null,
    asked_by: said.side !== ownerSide ? said.speaker : null,
    asked_by_entity_id: said.side !== ownerSide ? said.contactId ?? null : null,
    participants,
    commitment,
    accepted_quote: acceptedQuote,
    due_phrase: phraseSaid ? duePhrase : null,
    quote: String(item.quote).trim().slice(0, 500),
    context: typeof item.context === 'string' ? item.context : null,
    said,
  };
}

/** The participant key the model reads: who each speaker and mention is, and which side. */
function conversationKey(messages, people, mentions) {
  const lines = people.map(p => `- ${p.name}: ${p.side === 'internal' ? 'our team (the user\'s side)' : 'the customer\'s side'}`);
  for (const [id, m] of Object.entries(mentions || {})) if (m?.name) lines.push(`- <@${id}> is ${m.name}`);
  return lines.join('\n');
}

export async function extractConversationActionItems({
  supabase, workspaceId, channel = 'slack', messages = [], people = [], mentions = {},
  sourceRef = null, sourceUrl = null, sourceTitle = null, dryRun = false, twoParty = false,
}, { reader = read, observe = recordObservation } = {}) {
  const live = messages.filter(m => ['internal', 'external'].includes(m.side) && m.text?.trim());
  const external = live.filter(m => m.side === 'external' && m.contactId);
  if (!external.length) return [];
  const newest = live.at(-1)?.occurredAt ?? null;
  // Tasks only from a conversation in the last 30 days (GET-514).
  if (!writesTasks(newest)) return [];
  const transcript = live.map(m => `[${m.ts}] ${m.speaker}: ${m.text}`).join('\n');
  if (transcript.length < 24) return [];

  const result = await reader({
    supabase, workspaceId,
    feature: `${channel}-action-items`,
    meterAs: 'signal-extraction',
    accept: acceptsArray,
    parse: parseArray,
    maxTokens: 700,
    prompt:
`Extract concrete action items from this team chat between our team (the user's side) and a customer.

Who is who:
${conversationKey(live, people, mentions)}

Only a CONCRETE ask or commitment with a clear deliverable (set up a call, send X, fix Y, invite Z). Greetings, thanks, FYIs and vague enthusiasm are NOT action items. When in doubt, return [].

For each item:
- quote: copy the words of the ONE message that asks for or promises it, exactly as written, including any <@...> tokens.
- owner_kind: "user" if our team owes it, "prospect" if the customer's side owes it.
- owner: the name of the person who owes it, if the chat names one, else null.
- participants: names of other people the item involves (for example the person a call is with).
- commitment: "requested" if it was asked and nobody on the owing side has agreed yet; "accepted" if the owing side agreed in a LATER message; "scheduled" only if it was agreed AND a specific time was stated. Never assume a meeting was booked.
- accepted_quote: the exact words of that agreeing message, else null.
- due_phrase: timing words exactly as written in the chat, else null. Never invent one.

Chat:
"""${transcript.slice(0, 8000)}"""

Output ONLY valid JSON, max 4 items:
[{"title":"<imperative, names the deliverable>","quote":"...","owner_kind":"user|prospect","owner":"<name or null>","participants":["..."],"commitment":"requested|accepted|scheduled","accepted_quote":"<or null>","due_phrase":"<or null>","context":"<ONE sentence of what and why, for a reader without the chat>"}]`,
  });
  if (!result.ok) throw new Error(`${channel}_action_items_${result.reason ?? 'unreadable'}`);

  const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
  const kept = [];
  const perMessage = new Map();
  for (const raw of (result.value || []).slice(0, 4)) {
    const it = checkConversationActionItem(raw, { messages: live, people, twoParty });
    if (!it) continue;
    // The asker's person when they are the customer, else the customer on the conversation the
    // ask was made to: the fact lives on a real person at the account, like every other task.
    const anchorEntity = it.asked_by_entity_id ?? (it.owner_kind === 'prospect' ? it.owner_entity_id : null) ?? external.at(-1).contactId;
    const sourceActivityId = it.said.activityId ?? external.at(-1).activityId ?? null;
    // Stable per (message, index within it): a re-read after a new reply overwrites, never duplicates.
    const n = perMessage.get(it.said.ts) ?? 0;
    perMessage.set(it.said.ts, n + 1);
    const key = `${channel}_${String(it.said.ts).replace('.', '_')}_${n}`;
    const anchorAt = new Date(it.said.occurredAt ?? newest ?? Date.now());
    const deal = await dealForTask(supabase, workspaceId, { companyEntityId: await companyOfContact(supabase, workspaceId, anchorEntity).catch(() => null) })
      .catch(() => ({ deal_id: null, deal_link: null }));
    const value = {
      ...emptyTaskProvenance(),
      ...provenanceFromModel({ context: it.context }, it.title),
      for_name: it.owner_kind === 'user' ? it.asked_by : null,
      for_entity_id: it.owner_kind === 'user' ? it.asked_by_entity_id : null,
      asked_by: it.asked_by,
      asked_by_entity_id: it.asked_by_entity_id,
      owner_name: it.owner_name,
      owner_entity_id: it.owner_entity_id,
      participants: it.participants,
      commitment: it.commitment,
      quote: it.quote,
      accepted_quote: it.accepted_quote,
      slack_mentions: mentions,
      source_title: sourceTitle,
      source_url: it.said.url ?? sourceUrl,
      source_ref: sourceRef,
      occurred_at: anchorAt.toISOString(),
      deal_id: deal.deal_id,
      deal_link: deal.deal_link,
      title: it.title,
      owner_kind: it.owner_kind,
      status: 'open',
      due_phrase: it.due_phrase,
      due_at: it.due_phrase ? dueDateAgreeingWith(resolveDuePhrase(it.due_phrase, anchorAt, timeZone), it.title) : null,
      source_type: channel,
      source_id: sourceActivityId,
    };
    kept.push({ property: `action_item.${key}`, entityId: anchorEntity, value });
    if (dryRun) continue;
    await observe(supabase, {
      workspaceId, entityId: anchorEntity, kind: 'state',
      property: `action_item.${key}`, value,
      source: channel, method: 'extraction',
      // Versioned by the conversation it was read from: a later read records the newer reading.
      externalId: `action_item_${key}_${squash(sourceRef ?? '').slice(-16)}`,
      sourceRef,
    });
  }
  if (kept.length) console.log(`[ACTION_ITEMS] ${kept.length} from ${channel} conversation — ${sourceRef ?? 'no ref'}`);
  return kept;
}

// ── Public export — call this after every logActivity ────────────────────────

export async function extractAfterActivity(supabase, activityResult, { contactId, workspaceId, type, source, summary, isOutbound, occurredAt }) {
  if (!activityResult?.id) return;
  if (extractionSkipReason({ type, text: summary })) return;

  // A meeting is logged once per resolved attendee, and every one of those calls
  // lands here — so a call with a rep and two prospects ran the whole transcript
  // through extraction three times, once of them to mine "durable CRM facts"
  // about our own colleague.
  //
  // That second part is not just expensive, it is wrong. A teammate is not a
  // prospect, and their side of a call does not belong in the GTM graph as
  // intelligence about them. They are already flagged is_internal for exactly
  // this reason (scoring and outreach both skip them); extraction should have
  // been skipping them too.
  //
  // NOTE: this does not fully fix the fan-out. Two EXTERNAL attendees still mean
  // two passes over the same transcript, because the extraction prompt is
  // person-specific ("facts about ${contactName}") and each pass genuinely
  // produces different facts. Collapsing those into one multi-person call is a
  // real change to the prompt contract, not a one-liner. See internal/PRICING_MODEL.md §7.
  if (contactId) {
    try {
      if (await isEntityInternal(supabase, workspaceId, contactId)) return;
    } catch { /* if the check fails, extract — losing signal is worse than a wasted call */ }
  }

  // Action items mine BOTH directions (the user's own "I'll send X" counts), so
  // they run before the inbound-only guard below. Email and LinkedIn both go
  // through here — a promise made in a DM is still a promise, and until now the
  // LinkedIn ones were simply never captured.
  const channel = ACTION_ITEM_CHANNELS.get(type);
  if (channel) {
    setImmediate(() =>
      extractMessageActionItems({
        supabase, activityId: activityResult.id, contactId, workspaceId,
        source, summary, isOutbound, channel, occurredAt,
      }).catch(err => console.warn('[ACTION_ITEM_HOOK_ERROR]', err.message))
    );
  }

  // Never extract "facts about the contact" from a message the USER sent — that
  // would attribute our own questions/offers to them (e.g. "interested in X"
  // when we were the one asking about X). Only the contact's own words (inbound
  // messages, meeting transcripts) describe the contact.
  if (isOutbound === true) return;

  setImmediate(() =>
    extractActivitySignals({
      supabase,
      activityId:  activityResult.id,
      contactId,
      workspaceId,
      type,
      source,
      summary,
      occurredAt,
    }).catch(err => console.warn('[SIGNAL_HOOK_ERROR]', err.message))
  );
}
