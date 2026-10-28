// The real extractor, run for one eval case into an in-memory database (GET-1048).
//
// WHAT IS MEASURED IS WHAT PRODUCTION FILES. Not extractFactsFromText alone: the production entry
// points, extractActivitySignals (an email, or a call with one buyer, which is what
// extractMeetingSignals hands a 1:1 call to) and extractMeetingSignals (a call with several), with
// dryRun on. That runs the whole read: our side and the account brief loaded from the database,
// the extraction prompt, quote grounding, the our-side guard, the signal check, and then
// persistFacts' guards (title-only, pronoun, subject) and wording, up to the point where it would
// write. What comes back is what would have been saved.
//
// THE DATABASE is tests/fakeDb.mjs, seeded per case with exactly what the read looks up: the
// workspace (our company name), its members (our side's names), the positioning foundation (our
// offer, which decides competitor vs tech_stack), the contacts and the account rows the brief is
// built from. Nothing is on file about the account, so the merge has nothing to merge with and
// every fact is an ADD. Each case gets its own workspace id, so the per-workspace caches
// (loadTeam, the credit gate) never carry one case into the next.
//
// THE MODEL is the real one, through lib/llm.mjs. No seam was needed in extraction: the entry
// points already take the database as an argument, and the model door takes a registered client
// (registerAnthropicClient), which is how tests/extractionEvals.test.mjs runs this file offline.
//
// SAFETY: run.mjs imports this only after safeEnv.mjs has removed every production credential from
// the environment, so nothing here can reach a real database or the credit API.

import { randomUUID, createHash } from 'node:crypto';
import { claimAboutFor, normalizeClaimCategory, claimSubtagsFor, claimFreeTextFor, insightBoardModel } from '@nous/core';
import { fakeDb } from '../../tests/fakeDb.mjs';
import {
  extractActivitySignals, extractMeetingSignals, buildActivitySignalsPrompt, buildMeetingSignalsPrompt,
} from '../../src/signals/index.mjs';
import { buildSignalCheckPrompt } from '../../src/signals/signalCheck.mjs';
import { pipelineModel } from '../../src/lib/llm.mjs';

const splitName = (name) => {
  const [first, ...rest] = String(name).trim().split(/\s+/);
  return { first_name: first, last_name: rest.join(' ') || null };
};

/**
 * The seed for one case, and the ids it uses. Pure.
 * @returns {{ workspaceId, companyId, people: {id, name, title}[], seed: object }}
 */
export function seedFor(c) {
  const { account, people, ourSide } = c.input;
  const workspaceId = randomUUID();
  const companyId = randomUUID();
  const ppl = people.map(p => ({ id: randomUUID(), name: p.name, title: p.title ?? null }));
  const team = (ourSide.names ?? []).map(name => ({ id: randomUUID(), name, email: null }));
  const seed = {
    workspaces: [{ id: workspaceId, name: ourSide.company }],
    workspace_members: team.map(u => ({ workspace_id: workspaceId, user_id: u.id })),
    users: team,
    foundations: ourSide.offer ? [{ workspace_id: workspaceId, kind: 'positioning', body_md: ourSide.offer }] : [],
    contacts: ppl.map(p => ({
      id: p.id, workspace_id: workspaceId, ...splitName(p.name), email: null, company: account.name, company_id: companyId,
    })),
    // What the account brief reads (accountBrief.mjs): the account row and its people.
    entity_list_rows: [
      { workspace_id: workspaceId, entity_id: companyId, kind: 'company', name: account.name, industry: account.industry ?? null, stage: null },
      ...ppl.map(p => ({ workspace_id: workspaceId, entity_id: p.id, kind: 'person', company_id: companyId, name: p.name, job_title: p.title, last_activity_at: null })),
    ],
  };
  return { workspaceId, companyId, people: ppl, seed };
}

/**
 * A saved-fact row (persistFacts' dry-run result) as the runner holds it: the category the claim
 * is filed under, the record it lands on, its tags. Pure.
 */
export function toEvalClaim(f, { people, account, saidAt }) {
  const category = normalizeClaimCategory(f.category);
  const onCompany = claimAboutFor(f.category, f.about) === 'company';
  const person = people.find(p => p.id === f.contactId);
  return {
    category,
    content: f.content,
    subject: onCompany ? { kind: 'account', name: account.name } : { kind: 'person', name: person?.name ?? null },
    saidAt: f.saidAt ?? saidAt,
    // The tags exactly as they would be stored (the same declarations persistFacts writes with).
    tags: { ...claimSubtagsFor(category, f), ...claimFreeTextFor(category, f) },
    quote: f.quote ?? null,
    // When it happens or happened (GET-1051), as persistFacts would store it in the claim's metadata.
    ...occurredOf(f),
  };
}

/** A fact's fact_kind and occurred dates, only the ones it has. Pure. */
function occurredOf(f) {
  const out = {};
  if (f.fact_kind) out.fact_kind = f.fact_kind;
  if (f.occurred_start || f.occurred_end) out.occurred = { start: f.occurred_start ?? null, end: f.occurred_end ?? null };
  return out;
}

/** Token use from the llm_usage rows the read metered into the fake database. */
function usageFrom(db) {
  const rows = db.tables.llm_usage ?? [];
  const by = {};
  for (const r of rows) {
    const k = r.model ?? 'unknown';
    by[k] ??= { calls: 0, input_tokens: 0, output_tokens: 0 };
    by[k].calls++;
    by[k].input_tokens += r.input_tokens ?? 0;
    by[k].output_tokens += r.output_tokens ?? 0;
  }
  return by;
}

/**
 * Run one case through the production read. Throws when the read failed (a model outage, an
 * unparseable answer, or no model call at all): a failed read returns [] in production, and an
 * eval that scored [] as "selective" would pass every selectivity case during an outage.
 * @returns {Promise<{ claims: object[], usage: object }>}
 */
export async function extractCase(c) {
  const { kind, text, saidAt, account, ourSide } = c.input;
  const { workspaceId, companyId, people, seed } = seedFor(c);
  const db = fakeDb(seed);
  const occurredAt = `${saidAt}T12:00:00.000Z`;
  const ourNames = ourSide.names ?? [];
  let facts;
  if (kind === 'email' || people.length === 1) {
    // strict: every failure throws here instead of returning [].
    facts = await extractActivitySignals({
      supabase: db, workspaceId, contactId: people[0].id, activityId: null,
      type: kind === 'email' ? 'email_reply' : 'meeting_held', source: 'eval', summary: text,
      dryRun: true, strict: true, occurredAt, ourNames, aboutUs: false,
    });
  } else {
    facts = await extractMeetingSignals({
      supabase: db, workspaceId, source: 'eval', summary: text, dryRun: true, occurredAt, ourNames, insights: false,
      participants: people.map(p => ({ contactId: p.id, activityId: null, name: p.name, company: account.name, companyId })),
    });
  }
  // The meeting path has no strict mode; what it could not read it records as a pipeline event.
  const events = (db.tables.pipeline_events ?? []).filter(e => e.kind === 'unavailable' || e.kind === 'unparseable');
  if (events.length) throw new Error(`extraction failed: ${events.map(e => `${e.kind} (${e.model ?? 'model'})`).join(', ')}`);
  const usage = usageFrom(db);
  if (!Object.keys(usage).length) throw new Error('extraction made no model call (the read stopped before the model)');
  const claims = (facts ?? []).filter(f => f && f.action !== 'SKIP').map(f => toEvalClaim(f, { people, account, saidAt }));
  return { claims, usage };
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * Which extractor this run measured: the models, and a fingerprint of each prompt (the prompt
 * built for a fixed probe input, hashed), so two results files say whether the prompt changed
 * between them without either having to carry the prompt.
 */
export function extractorInfo() {
  const ourSide = { companyName: 'Probe', ownerName: null, teamNames: ['Probe Rep'], offer: 'Probe offer.' };
  return {
    models: { extraction: pipelineModel(), signal_check: insightBoardModel() },
    prompts: {
      activity: sha(buildActivitySignalsPrompt({ contactName: 'Probe Person', company: 'Probe Co', type: 'email_reply', summary: 'probe', ourSide }).prompt),
      meeting: sha(buildMeetingSignalsPrompt({ roster: '1. Probe Person (Probe Co)', transcript: 'probe', maxFacts: 8, ourSide })),
      signal_check: sha(buildSignalCheckPrompt({ signals: [{ category: 'objection', content: 'probe', quote: 'probe' }], text: 'probe' })),
    },
  };
}
