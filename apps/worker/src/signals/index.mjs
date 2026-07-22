// Signal extraction pipeline — ported from an earlier internal prototype.
// After every qualifying private activity (LinkedIn message, email reply, meeting, Slack DM),
// Claude Haiku extracts structured CRM facts → `note.*` claims on the contact entity.
// Graph edges (REPORTS_TO, BUDGET_HOLDER_AT, etc.) extracted from each fact → workspace_graph_edges.

import Anthropic, { setUser } from 'useleak';
import { listNotes, saveNote, updateNote, searchClaims, listActivities, recordObservation,
  isEntityInternal, linkPersonMention, resolvePersonMention,
  normalizeClaimCategory, normalizeClaimAbout, claimCategoryPromptBlock, CLAIM_CATEGORY_KEYS } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── Note dedup ────────────────────────────────────────────────────────────────
// Semantic search across `note.*` claims via the v2 search_claims RPC.
// Embeddings are filled in by the embeddings worker; if none yet, we degrade
// to no-dedup (always ADD), which is safe but slightly noisier.

async function searchSimilarNotes(supabase, workspaceId, query, threshold = 0.88, limit = 5) {
  // Restrict to note.* claims in SQL — dedup only compares against notes, and
  // scoping the candidate set keeps the search fast (hundreds of notes, not
  // tens of thousands of claims) and high-recall (the global nearest claims are
  // usually signals/features, not notes).
  const hits = await searchClaims(supabase, workspaceId, query, { threshold, limit: limit * 3, propertyPrefix: 'note.' });
  return hits
    .filter(h => h.property?.startsWith('note.'))
    .slice(0, limit)
    .map(h => ({ id: h.id, content: (h.value && h.value.content) || '' }))
    .filter(m => m.content);
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
// Facts with no similar notes never reach the model at all — if nothing is close,
// there is nothing to merge, and the answer is ADD without asking.
async function decideMergeBatch(supabase, workspaceId, factContents) {
  const candidates = await Promise.all(
    factContents.map(f => searchSimilarNotes(supabase, workspaceId, f).catch(() => [])),
  );

  const decisions = factContents.map(() => ({ action: 'ADD', supersedes: null }));

  // Only the facts that actually collide need a judgement.
  const contested = [];
  for (let i = 0; i < factContents.length; i++) {
    if (candidates[i].length > 0) contested.push(i);
  }
  if (contested.length === 0) return decisions;

  const block = contested.map((idx, n) => {
    const existing = candidates[idx].map(f => `   - [ID:${f.id}] ${f.content}`).join('\n');
    return `${n + 1}. NEW FACT: "${factContents[idx]}"\n   SIMILAR EXISTING:\n${existing}`;
  }).join('\n\n');

  try {
    const msg = await anthropic.messages.create({
      feature: 'note-merge-decide',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(600, 40 * contested.length + 60),
      messages: [{ role: 'user', content: `You are managing an atomic fact memory store for a business workspace.

For EACH numbered new fact below, decide one of:
- ADD — distinct enough to keep alongside the existing facts
- UPDATE:<ID> — it supersedes one existing fact (give that fact's ID)
- SKIP — it is already captured by an existing fact

${block}

Return ONLY a JSON array, one entry per numbered fact, in order:
[{"n":1,"decision":"ADD"},{"n":2,"decision":"UPDATE:<uuid>"},{"n":3,"decision":"SKIP"}]` }],
    });

    const text = msg.content[0]?.text?.trim() ?? '[]';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s === -1 || e === -1) return decisions;

    const parsed = JSON.parse(text.slice(s, e + 1));
    if (!Array.isArray(parsed)) return decisions;

    for (const row of parsed) {
      const n = Number(row?.n);
      if (!Number.isInteger(n) || n < 1 || n > contested.length) continue;

      const target = contested[n - 1];
      const decision = String(row?.decision ?? 'ADD').trim();

      if (decision === 'SKIP') {
        decisions[target] = { action: 'SKIP', supersedes: null };
      } else if (decision.startsWith('UPDATE:')) {
        decisions[target] = { action: 'UPDATE', supersedes: decision.slice(7).trim() };
      }
    }
  } catch (err) {
    // A merge failure must never lose the fact. Defaulting to ADD is the safe
    // direction: a duplicate note is recoverable, a dropped one is not.
    console.warn('[NOTE_MERGE_BATCH]', err.message);
  }

  return decisions;
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

    const msg = await anthropic.messages.create({
      feature: 'graph-edges-extract',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(1500, 120 * facts.length + 100),
      messages: [{ role: 'user', content: `Extract relationship edges from these facts for a GTM knowledge graph. A relationship may span two facts.

Extract an edge in TWO cases:
1. Two named entities have a clear directional relationship (reports-to, owns budget, champions, competes with, uses).
2. The subject NAMES A SPECIFIC PERSON they are connected to — a shared or mutual connection, a friend, someone who introduced them, someone they mention knowing — even with no formal relationship. Use KNOWS, subject = the contact, object = the named person. This is what turns "he mentioned Georgi" into a common-connection node in the graph, so DON'T skip a named person just because the tie is informal.

Only real, specific PEOPLE or ORGS — never a generic role, a topic, or a tool as a "known person".

FACTS:
${factBlock}${contextHint ? `\n\nCONTEXT: ${contextHint}` : ''}

Return a JSON array. Each edge, with "from" set to the number of the fact it came from:
{"from":1,"subject_label":"name","subject_type":"contact|company|product|competitor|topic","relationship":"REPORTS_TO|DEFERS_TO_TECHNICAL|DEFERS_TO_BUDGET|DECISION_MAKER_AT|BUDGET_HOLDER_AT|CHAMPIONS|BLOCKS|EVALUATING|USES|WORKS_WITH|KNOWS|CHURNED_FROM|COMPETES_WITH","object_label":"name","object_type":"contact|company|product|competitor|topic"}

Examples:
"Sarah defers to Marcus on technical decisions" → {"from":1,"subject_label":"Sarah","subject_type":"contact","relationship":"DEFERS_TO_TECHNICAL","object_label":"Marcus","object_type":"contact"}
"Jennifer controls the budget at TechFlow" → {"from":2,"subject_label":"Jennifer","subject_type":"contact","relationship":"BUDGET_HOLDER_AT","object_label":"TechFlow","object_type":"company"}
"Jack shares a mutual connection in Georgi" → {"from":1,"subject_label":"Jack","subject_type":"contact","relationship":"KNOWS","object_label":"Georgi","object_type":"contact"}
"Mentioned Q2 budget" → nothing

Return [] only if no entity relationship AND no named person anywhere. At most 4 edges per fact. ONLY valid JSON array, no other text.` }],
    });

    const text = msg.content[0]?.text?.trim() ?? '[]';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s === -1 || e === -1) return;
    let edges = [];
    try { edges = JSON.parse(text.slice(s, e + 1)); } catch { return; }
    if (!Array.isArray(edges) || edges.length === 0) return;

    for (const edge of edges.slice(0, 4 * facts.length)) {
      if (!edge.subject_label || !edge.relationship || !edge.object_label) continue;

      // Which fact produced this edge, so the edge still points back at the note
      // it was drawn from. An unattributable edge is one nobody can audit.
      const origin = facts[Number(edge.from) - 1] ?? facts[0];
      const sourceMemoryId = origin?.memoryId ?? null;
      const factContent    = origin?.content ?? '';

      let subjectId = null, objectId = null;

      if (edge.subject_type === 'contact') {
        const fn = edge.subject_label.split(' ')[0];
        const { data } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .or(`first_name.ilike.${fn},email.ilike.%${edge.subject_label.toLowerCase()}%`)
          .limit(1).maybeSingle();
        subjectId = data?.id ?? context.contact_id ?? null;
      } else if (edge.subject_type === 'company') {
        const { data } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).ilike('name', `%${edge.subject_label}%`).limit(1).maybeSingle();
        subjectId = data?.id ?? context.company_id ?? null;
      }

      if (edge.object_type === 'contact') {
        const fn = edge.object_label.split(' ')[0];
        const { data } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .or(`first_name.ilike.${fn},email.ilike.%${edge.object_label.toLowerCase()}%`)
          .limit(1).maybeSingle();
        objectId = data?.id ?? null;
      } else if (edge.object_type === 'company') {
        const { data } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).ilike('name', `%${edge.object_label}%`).limit(1).maybeSingle();
        objectId = data?.id ?? context.company_id ?? null;
      }

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
        confidence:       0.9,
        metadata:         { fact: factContent.slice(0, 200) },
      }, { onConflict: 'workspace_id,subject_label,relationship,object_label', ignoreDuplicates: false });
    }

    if (edges.length > 0) console.log(`[GRAPH_EXTRACT] ${edges.length} edges — workspace ${workspaceId}`);
  } catch (err) {
    console.warn('[GRAPH_EXTRACT_ERROR]', err.message);
  }
}

// ── Memory summary refresh ────────────────────────────────────────────────────
// Regenerates contacts.memory_summary after new signals land — fire-and-forget.

async function refreshContactBlock(supabase, contactId, workspaceId) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: contact }, recentActs, factList] = await Promise.all([
      supabase.from('contacts').select('first_name, last_name, email, pipeline_stage, company, summary_generated_at').eq('id', contactId).single(),
      listActivities(supabase, { contactId, since: thirtyDaysAgo, limit: 15 }),
      listNotes(supabase, workspaceId, { entityId: contactId, limit: 15 }),
    ]);
    if (!contact || (!recentActs.length && !factList.length)) return;

    // Debounce: skip if summary was regenerated in the last 30 minutes (burst protection)
    if (contact.summary_generated_at) {
      const age = Date.now() - new Date(contact.summary_generated_at).getTime();
      if (age < 30 * 60 * 1000) {
        console.log(`[CONTACT_BLOCK] skipped — regenerated ${Math.floor(age / 60000)}m ago — contact ${contactId}`);
        return;
      }
    }

    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;
    const actLines  = recentActs.slice(0, 8).map(a =>
      `- ${a.activity_type}${a.description ? `: ${a.description}` : ''} (${new Date(a.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
    ).join('\n');
    const factLines = factList.map(f => `- ${f.content}`).join('\n');

    const prompt = `Write a 2-sentence memory summary of ${name} for an AI sales agent. Plain prose only — no markdown, no bullets.
First sentence: who they are and where they stand in the pipeline.
Second sentence: the single most important thing to know right now — the blocker, the opportunity, or the next move.${actLines ? `\n\nRecent activity (last 30 days):\n${actLines}` : ''}${factLines ? `\n\nStored facts:\n${factLines}` : ''}\n\nSummary:`;

    const msg = await anthropic.messages.create({
      feature: 'contact-memory-summary',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    const newSummary = msg.content[0]?.text?.trim();
    if (newSummary) {
      await supabase.from('contacts').update({
        memory_summary: newSummary,
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

export async function extractActivitySignals({ supabase, activityId, contactId, workspaceId, type, source, summary, maxFactsOverride, dryRun = false }) {
  try {
    setUser({ id: String(workspaceId) });
    const { data: contact } = await supabase.from('contacts')
      .select('first_name, last_name, company').eq('id', contactId).single();

    const contactCtx = contact
      ? [[contact.first_name, contact.last_name].filter(Boolean).join(' '), contact.company].filter(Boolean).join(' at ')
      : null;
    const contactName = (contact && [contact.first_name, contact.last_name].filter(Boolean).join(' ')) || 'the contact';
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
        `This is the full back-and-forth of a conversation between you (the user) and ${contactName}. ` +
        `Lines beginning "You:" are the user's own words; lines beginning "${contactName}:" are ${contactName}'s. ` +
        `Record durable facts about ${contactName} drawn from the WHOLE exchange, including things that only become ` +
        `clear across several messages (a shared connection, their role, their company, what they are building). ` +
        `NEVER turn a "You:" line into a fact about ${contactName}.`,
      // Research the user's OWN agent compiled about the contact (from public
      // LinkedIn posts, their website, prior context) — not the contact's words.
      // Real, durable intel, but second-hand, so it is framed as such.
      research_brief:
        `This is research the user's own agent compiled ABOUT ${contactName} (from their public LinkedIn posts, ` +
        `their company website, and prior context) — not ${contactName}'s own words. Record the durable facts it ` +
        `establishes about ${contactName} or their company.`,
    }[type] ||
      `This is a message that ${contactName} sent to you (the user) — these are ${contactName}'s own words, not yours.`;

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
    const maxFacts = maxFactsOverride ?? ({
      meeting_held:        12,
      research_brief:      8,
      conversation_thread: 6,
    }[type] ?? 4);

    const msg = await anthropic.messages.create({
      feature: 'activity-signals-extract',
      model: 'claude-haiku-4-5-20251001',
      // Scale the output budget with the fact cap — a deep transcript re-extract
      // asking for up to 8 detailed facts needs more room than a 2-fact message,
      // or the JSON array truncates mid-fact and fails to parse (→ zero facts).
      max_tokens: Math.min(2000, Math.max(400, maxFacts * 130)),
      messages: [{ role: 'user', content: `Extract durable CRM intelligence about ${contactName} from this private ${channelLabel}.
${provenance}
Record facts ONLY about ${contactName}, drawn from what THEY reveal about themselves, their company, needs, constraints, opinions, or plans. NEVER turn the user's own questions, offers, or statements into facts about ${contactName} (e.g. if the user asked "what's behind your product?", that is NOT a fact that ${contactName} is interested in the user's product).
${contactCtx ? `Contact: ${contactCtx}` : ''}

Message: "${summary}"

A fact is worth recording ONLY if it passes ALL THREE bars:
1. DURABLE — still true weeks or months from now. A meeting time, an availability, or a reschedule is NOT durable.
2. DECISION-RELEVANT — it would change how someone sells to or works with ${contactName}: their budget, authority, pain, goals, stack, or buying timeline.
3. SPECIFIC — it carries the concrete detail or the reason WHY, not a vague label. "Evaluating Clay vs Apollo because Apollo's data went stale", not "looking at tools".

NEVER record (noise, or it already lives elsewhere in the CRM):
- Meeting logistics: scheduling, availability, reschedules, "has a call on X", invites sent or pending.
- Generic sentiment, small talk, greetings, pleasantries.
- Anything true today but meaningless next week.

Tag each fact with exactly one category, and whether it is about the person or their company.

Categories:
${claimCategoryPromptBlock()}

Rules:
- Each fact is one self-contained sentence naming ${contactName} explicitly (no pronouns).
- Set "category" to exactly one of: ${CLAIM_CATEGORY_KEYS.join(', ')}.
- Set "about" to "person" for a fact about ${contactName}, or "company" for a fact about their company.
- Extract EVERY fact that clears all three bars — there is no target number. A thin message often yields none or one; a content-rich meeting may yield many. NEVER pad to reach a count, NEVER split one fact into several, and NEVER restate the same fact in different words.
- Quality over quantity: one sharp, specific fact is worth more than five vague ones. If nothing clears all three bars, return [].
- Hard ceiling of ${maxFacts} facts — a safety limit, not a goal. Stop when you run out of facts that genuinely clear the bar, well before the ceiling.

Output ONLY valid JSON: [{"content": "...", "category": "<one category key>", "about": "person|company"}]
If nothing meaningful: []` }],
    });

    let facts = [];
    try {
      const text = msg.content[0]?.text?.trim() ?? '[]';
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s !== -1 && e !== -1) facts = JSON.parse(text.slice(s, e + 1));
    } catch { return []; }

    if (!Array.isArray(facts) || facts.length === 0) return [];

    const kept = facts
      .slice(0, maxFacts)
      .filter(f => f.content && typeof f.content === 'string')
      .map(f => ({ ...f, contactId, activityId }));

    return await persistFacts(supabase, workspaceId, kept, { type, source, dryRun });
  } catch (err) {
    console.warn('[SIGNAL_EXTRACTOR_ERROR]', err.message);
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
async function persistFacts(supabase, workspaceId, kept, { type, source, dryRun = false }) {
  if (!kept.length) return [];

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const results = [];

  const decisions = await decideMergeBatch(supabase, workspaceId, kept.map(f => f.content));

  // Saved facts, collected so the graph pass sees them together.
  const saved = [];
  const touchedContacts = new Set();

  for (let i = 0; i < kept.length; i++) {
    const fact = kept[i];
    const { action, supersedes } = decisions[i];

    if (action === 'SKIP') { results.push({ ...fact, action: 'SKIP' }); continue; }

    // Preview mode (re-extract dry-run): report what WOULD be saved, write nothing.
    if (dryRun) { results.push({ ...fact, action }); continue; }

    let newMem = null;
    try {
      newMem = await saveNote(supabase, workspaceId, {
        entityId: fact.contactId,
        category: normalizeClaimCategory(fact.category),
        content:  fact.content,
        source:   'signal_extraction',
        // The structural evidence chain: this claim points back to the source
        // activity observation it was extracted from (claims.supporting_observation_ids).
        supportingObservationIds: fact.activityId ? [fact.activityId] : undefined,
        metadata: {
          about:              normalizeClaimAbout(fact.about),
          signal_type:        type,
          extraction_source:  source,
          source_activity_id: fact.activityId || null,
          graph_layer:        'private',
        },
      });
    } catch (err) {
      console.warn('[SIGNAL_EXTRACTOR] Insert error:', err.message);
      continue;
    }

    if (action === 'UPDATE' && supersedes && uuidRe.test(supersedes)) {
      await updateNote(supabase, workspaceId, supersedes, { is_active: false }).catch(() => {});
    }

    if (newMem) {
      saved.push({ content: fact.content, memoryId: newMem.id });
      touchedContacts.add(fact.contactId);
      // A Connections fact that names a person → turn that name into a graph node
      // (resolve / stub / leave-ambiguous). Fire-and-forget; never blocks the save.
      if (normalizeClaimCategory(fact.category) === 'relationship') {
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
    for (const cid of touchedContacts) {
      refreshContactBlock(supabase, cid, workspaceId).catch(() => {});
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
export async function extractMeetingSignals({
  supabase, workspaceId, participants, summary, source,
  maxFactsOverride, dryRun = false,
}) {
  try {
    if (!summary || summary.length < 20) return [];
    if (!participants?.length) return [];
    setUser({ id: String(workspaceId) });

    // A 1:1 call is the common case, and the single-person prompt is sharper for
    // it (it can say "these are Sarah's own words" rather than hedging across a
    // roster). Nothing is saved by generalising it, so don't.
    if (participants.length === 1) {
      const p = participants[0];
      return await extractActivitySignals({
        supabase, workspaceId, contactId: p.contactId, activityId: p.activityId,
        type: 'meeting_held', source, summary, maxFactsOverride, dryRun,
      });
    }

    const roster = participants
      .map((p, i) => `${i + 1}. ${p.name}${p.company ? ` (${p.company})` : ''}`)
      .join('\n');

    // The ceiling scales with the room, but sub-linearly: a 4-person call does not
    // hold 4x the durable intelligence of a 1:1, and a per-person ceiling would
    // invite padding. Still a SAFETY limit, never a target.
    const maxFacts = maxFactsOverride ?? Math.min(24, 8 + 4 * participants.length);

    const msg = await anthropic.messages.create({
      feature: 'meeting-signals-extract',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(3000, Math.max(600, maxFacts * 130)),
      messages: [{ role: 'user', content: `Extract durable CRM intelligence from this meeting transcript.

These are notes/transcript from a call. The people below are the EXTERNAL attendees — the ones we are selling to or working with. Record facts about THEM, drawn from what they reveal about themselves, their company, needs, constraints, opinions, or plans.

EXTERNAL ATTENDEES:
${roster}

NEVER attribute the user's (our own side's) questions, offers, or statements to an attendee. If we asked "what's driving the timeline?", that is NOT a fact that they care about timelines. Only THEIR words describe them.

Transcript: "${summary}"

A fact is worth recording ONLY if it passes ALL THREE bars:
1. DURABLE — still true weeks or months from now. A meeting time, an availability, or a reschedule is NOT durable.
2. DECISION-RELEVANT — it would change how someone sells to or works with them: budget, authority, pain, goals, stack, or buying timeline.
3. SPECIFIC — it carries the concrete detail or the reason WHY, not a vague label. "Evaluating Clay vs Apollo because Apollo's data went stale", not "looking at tools".

NEVER record (noise, or it already lives elsewhere in the CRM):
- Meeting logistics: scheduling, availability, reschedules, invites.
- Generic sentiment, small talk, greetings, pleasantries.
- Anything true today but meaningless next week.

Tag each fact with:
- "person": the NUMBER of the attendee it is about (from the list above).
- "category": exactly one of: ${CLAIM_CATEGORY_KEYS.join(', ')}.
- "about": "person" for a fact about that individual, "company" for a fact about their company.

Categories:
${claimCategoryPromptBlock()}

Rules:
- Each fact is one self-contained sentence naming the person explicitly (no pronouns).
- Attribute each fact to the attendee it is genuinely ABOUT. A fact one person states about another belongs to whoever it describes.
- Extract EVERY fact that clears all three bars — there is no target number, and no requirement that every attendee yields one. A quiet attendee may yield none. NEVER pad, NEVER split one fact into several, NEVER restate the same fact twice.
- Hard ceiling of ${maxFacts} facts across ALL attendees — a safety limit, not a goal.

Output ONLY valid JSON: [{"person": 1, "content": "...", "category": "<key>", "about": "person|company"}]
If nothing meaningful: []` }],
    });

    let facts = [];
    try {
      const text = msg.content[0]?.text?.trim() ?? '[]';
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s !== -1 && e !== -1) facts = JSON.parse(text.slice(s, e + 1));
    } catch { return []; }

    if (!Array.isArray(facts) || facts.length === 0) return [];

    const kept = facts
      .slice(0, maxFacts)
      .filter(f => f?.content && typeof f.content === 'string')
      .map((f) => {
        // An unattributable fact is worse than no fact: it would land on the wrong
        // person's record and read as truth. Drop it rather than guess.
        const p = participants[Number(f.person) - 1];
        return p ? { ...f, contactId: p.contactId, activityId: p.activityId } : null;
      })
      .filter(Boolean);

    return await persistFacts(supabase, workspaceId, kept, {
      type: 'meeting_held', source, dryRun,
    });
  } catch (err) {
    console.warn('[MEETING_EXTRACTOR_ERROR]', err.message);
    return [];
  }
}

// ── People named in a Connections claim → graph nodes ─────────────────────────
//
// A Connections fact ("Jack shares a warm connection with Georgi") names a person.
// This pulls those names out (NER) and hands each to the core mention resolver,
// which turns it into a real, taggable graph node WITHOUT guessing identity —
// resolve to a unique existing account, leave an ambiguous name for a human, or stub
// a pending node. That is what makes "@Georgi" a traversable node and lets "what
// warm connections can we use?" reach an account, not just read a name.
//
// Only runs on relationship/Connections facts — we don't want to stub every name
// dropped in a pain or status fact.
async function extractPersonNamesFromClaim(content, subjectName) {
  try {
    const msg = await anthropic.messages.create({
      feature: 'mention-names-extract',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `From this fact, list the specific real PEOPLE named in it, OTHER than "${subjectName}". Only actual named individuals — never a company, tool, product, role, or place.

Fact: "${content}"

Return ONLY a JSON array of names, e.g. ["Georgi"]. Return [] if no other person is named.` }],
    });
    const t = msg.content[0]?.text ?? '[]';
    const s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(arr)
      ? [...new Set(arr.filter(n => typeof n === 'string' && n.trim().length > 1).map(n => n.trim()))]
      : [];
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
  const names = await extractPersonNamesFromClaim(content, subj || 'the account');
  const results = [];
  for (const name of names) {
    if (dryRun) {
      results.push({ name, ...(await resolvePersonMention(supabase, workspaceId, name)) });
      continue;
    }
    results.push(await linkPersonMention(supabase, workspaceId, {
      subjectEntityId, subjectLabel: subj || 'the account', name, sourceMemoryId,
    }));
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
    // Full-access read (no ctx) — this is a system pass, not a member view.
    const acts = await listActivities(supabase, {
      contactId, types: ['linkedin_message'], limit: THREAD_MAX_MESSAGES,
    });
    // listActivities is newest-first; a transcript reads oldest-first.
    const msgs = acts.filter(a => (a.summary || a.description || '').trim()).reverse();
    if (msgs.length < minMessages) return [];

    const { data: contact } = await supabase.from('contacts')
      .select('first_name, last_name, company').eq('id', contactId).single();
    const contactName =
      (contact && [contact.first_name, contact.last_name].filter(Boolean).join(' ')) || 'the contact';

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
      type:       'conversation_thread',
      source,
      summary:    transcript,
      maxFactsOverride,
      dryRun,
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
  supabase, activityId, contactId, workspaceId, source, summary, isOutbound, channel,
}) {
  const cfg = CHANNELS[channel];
  if (!cfg) return;
  if (!summary || summary.length < cfg.minLength) return;

  const { data: c } = await supabase.from('contacts').select('first_name, last_name').eq('id', contactId).maybeSingle();
  const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'the contact';
  const direction = isOutbound === true
    ? `This ${cfg.label} was SENT BY the user (the founder / account owner) TO ${name}.`
    : `This ${cfg.label} was RECEIVED FROM ${name} (the prospect), addressed to the user.`;

  const msg = await anthropic.messages.create({
    feature: `${channel}-action-items`,
    model:   'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content:
`Extract concrete action items / commitments from this ${cfg.label}. ${direction}

Tag each item's owner:
- "user" — the founder owes it (the user promised to do something, OR ${name} asked the user to do something)
- "prospect" — ${name} owes it (they promised, OR the user asked them to do it)

Only a CONCRETE commitment or explicit ask with a clear deliverable (send X, schedule Y, review Z, follow up by <date>). ${cfg.guidance} Be strict — if nothing is clearly actionable, return [].

${cfg.label}:
"""${summary.slice(0, 6000)}"""

Output ONLY valid JSON, max 4 items:
[{"title":"<imperative, names the deliverable>","owner_kind":"user|prospect","due_phrase":"<timing if stated, else null>"}]` }],
  });

  let items = [];
  try {
    const t = msg.content?.[0]?.text ?? '[]';
    const s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s !== -1 && e !== -1) items = JSON.parse(t.slice(s, e + 1));
  } catch { return; }

  let n = 0;
  for (let i = 0; i < items.length && i < 4; i++) {
    const it = items[i];
    if (!it?.title || typeof it.title !== 'string') continue;
    const rec = await recordObservation(supabase, {
      workspaceId, entityId: contactId, kind: 'state',
      // Deterministic per (channel, activity, index) — reprocessing the same
      // message overwrites rather than duplicating.
      property: `action_item.${channel}_${activityId}_${i}`,
      value: {
        title:       it.title.trim(),
        owner_kind:  it.owner_kind === 'prospect' ? 'prospect' : 'user',
        status:      'open',
        due_phrase:  it.due_phrase || null,
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

// ── Public export — call this after every logActivity ────────────────────────

export async function extractAfterActivity(supabase, activityResult, { contactId, workspaceId, type, source, summary, isOutbound }) {
  if (!activityResult?.id) return;
  if (!SIGNAL_WORTHY_TYPES.has(type)) return;
  if (!summary || summary.length < 20) return;
  if (SIGNAL_NOISE.some(p => p.test(summary))) return;

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
        source, summary, isOutbound, channel,
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
    }).catch(err => console.warn('[SIGNAL_HOOK_ERROR]', err.message))
  );
}
