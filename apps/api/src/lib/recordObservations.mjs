// `record` — the one write door into the graph, as a SERVICE (GET-94).
//
// This logic used to live inline in `routes/v2/observations.mjs`, reachable only by an
// HTTP request. That meant the plugin could write structured claims with confidence and
// provenance and the in-app agent could not — it had `save_note` (prose) and
// `remember_account` (a memory row), neither of which is a claim. So the loop closed on
// one surface only, and four plugin skills (`sync`, `after-call`, `build-record`,
// `reach-out`) half-ran in the app.
//
// Lifted here so the route and the agent tool call the SAME function — the move
// `lib/whoami.mjs` already got, for the same reason. The route keeps its contract; it
// just maps the result onto a status code.
//
// Agents never "update" — they observe. The substrate derives the new claims.

import {
  getOrCreateEntity,
  recordObservation,
  recomputeClaim,
  detectIdentifier,
  listSignals,
  scoreAndStake,
  rescoreEntityFromClaims,
  rescoreCompanyMembers,
  saveNote,
  assertClaims,
  companyDomainFromEmail,
  companyNameFromDomain,
  isFreeEmailDomain,
  normalizeClaimCategory, claimSubtagsFor, claimFreeTextFor,
  proposeDecision,
  recordVerdict,
  confirmDecision,
  upsertFlag,
  addConstraint,
  addPreference,
  violatesPronounRule,
  PRONOUN_RULE_REASON,
  claimAboutFor,
} from '@nous/core';
import { recordCallReviewFromAgent } from './callReviewFromAgent.mjs';

// The pronoun guard is one implementation in @nous/core, shared with the worker's
// persistFacts. It used to be a copy here, which is exactly how GET-368 hid: "F&I" read
// as a first-person pronoun and both writers dropped the fact without saying so.

/**
 * Record what happened / was learned against one focus.
 *
 * @param {object}   supabase
 * @param {string}   workspaceId
 * @param {object}   body  { focus, observations: [{ kind:'event'|'state', property, value,
 *                           source?, method?, observed_at?, external_id?, raw? }] }
 * @param {object}   opts  { userId?, apiKeyId? } — apiKeyId: the key a /v2 request came in on, stamped
 *                           on the claims it writes so the credits they cause are the key's (E6).
 * @returns {Promise<{ok: true, entity_id, recorded, claims_recomputed, icp_scored,
 *                     rejected?: {property: string|null, external_id: string|null, reason: string}[]}
 *                 | {ok: false, status: number, error: string, detail?: string}>}
 *
 * `recorded` alone cannot tell a caller whether the write was complete — `rejected` is
 * what makes a partial write visible (GET-369). It is present only when something was
 * actually refused.
 *
 * Never throws for a caller mistake — a bad focus comes back as `ok:false` so the route
 * can 400 it and the agent tool can hand the model something it can act on.
 */
export async function recordObservations(supabase, workspaceId, body = {}, opts = {}) {
  const { focus, observations } = body;

  if (!focus || !Array.isArray(observations) || observations.length === 0) {
    return { ok: false, status: 400, error: 'focus_and_observations_required' };
  }

  // Resolve the focus to an entity — create one if it's a new identifier.
  // A write needs a precise identifier (id / email / LinkedIn / domain) —
  // never a bare name (too ambiguous to record against).
  const ident = detectIdentifier(String(focus));
  if (!ident) {
    return {
      ok: false, status: 400, error: 'invalid_focus',
      detail: 'provide an entity id, email, LinkedIn URL, or domain — not a bare name',
    };
  }

  let entityId;
  if (ident.kind === 'entity_id') {
    entityId = ident.value;
  } else if (ident.kind === 'domain') {
    entityId = await getOrCreateEntity(supabase, workspaceId, 'company',
      [{ kind: 'domain', value: ident.value }]);
  } else {
    // Pull the name out of the incoming observations so the resolver can run its
    // name-fallback tier and attach to an existing same-person record instead of
    // forking. Without this, a same-batch LinkedIn import (name in the payload,
    // only an identifier here) creates a duplicate before the name is ever seen.
    const nameOf = (p) => {
      const o = observations.find(x => x?.kind === 'state' && x?.property === p && x?.value);
      return o ? String(o.value) : null;
    };
    const first_name = nameOf('first_name');
    const last_name = nameOf('last_name');
    const nameHint = (first_name || last_name) ? { first_name, last_name } : undefined;
    entityId = await getOrCreateEntity(supabase, workspaceId, 'person',
      [{ kind: ident.kind, value: ident.value }], { nameHint });
  }

  // Materialize + link the person's employer (the ACCOUNT). Historically the write
  // path recorded a person's domain/company as inert claims and never created the
  // company entity or the works_at edge the People/Companies views read from — so an
  // agent-driven backfill produced people but ZERO companies. Here, for a person focus,
  // resolve a company from the work-email domain (or an explicit `domain` claim in the
  // batch), open an idempotent works_at edge (the only thing the overlay reads for
  // company_id), and give the company a display name. Free-mailbox domains are people,
  // not employers — skip them. Best-effort; never blocks the write.
  let companyEntityId = null;
  const stateVal = (p) => {
    const o = observations.find(x => x?.kind === 'state' && x?.property === p && x?.value != null);
    if (!o) return null;
    const v = o.value;
    return (v && typeof v === 'object') ? (v.value ?? null) : String(v);
  };
  if (ident.kind === 'email' || ident.kind === 'linkedin_url') {
    const explicitDomain = stateVal('domain');
    const derivedDomain = ident.kind === 'email' ? companyDomainFromEmail(ident.value) : null;
    let companyDomain = String(explicitDomain || derivedDomain || '')
      .replace(/^www\./, '').toLowerCase().trim() || null;
    if (companyDomain && isFreeEmailDomain(companyDomain)) companyDomain = null;
    if (companyDomain) {
      try {
        companyEntityId = await getOrCreateEntity(supabase, workspaceId, 'company',
          [{ kind: 'domain', value: companyDomain }]);
        if (companyEntityId) {
          await supabase.from('relationships').upsert(
            [{ workspace_id: workspaceId, from_entity_id: entityId, to_entity_id: companyEntityId,
               type: 'works_at', valid_from: new Date().toISOString() }],
            { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true });
          // Name it. An explicit name from extraction always wins; a domain-derived
          // name (quillfield.example → "Quillfield") only fills a company that has none yet,
          // so we never clobber a better name a CRM/enrichment already set.
          const explicitName = stateVal('company');
          const nameToSet = explicitName || companyNameFromDomain(companyDomain);
          if (nameToSet) {
            const { data: cur } = await supabase.from('companies')
              .select('name').eq('id', companyEntityId).maybeSingle();
            if (explicitName || !cur?.name) {
              await assertClaims(supabase, workspaceId, companyEntityId,
                { values: { name: nameToSet }, source: 'agent' });
            }
          }
        }
      } catch (e) {
        console.error('[record] company link failed:', e.message);
      }
    }
  }

  // Append every observation to the immutable spine.
  let recorded = 0;
  // Everything this call REFUSED, and why (GET-369). Without it a guard's `continue` is
  // invisible: the caller sees "Recorded 10" for the 12 it sent and has no way to tell a
  // clean write from a partial one. That silence is what let GET-368 run for months and
  // what made twenty agents' self-reports unverifiable in the week-9 backfill.
  const rejected = [];
  const reject = (o, reason) => rejected.push({
    property: o?.property ?? null,
    external_id: o?.external_id ?? null,
    reason,
  });
  const touchedProps = new Set();
  const callReviews = [];
  for (const o of observations) {
    if (!o.property || (o.kind !== 'event' && o.kind !== 'state')) {
      reject(o, !o.property ? 'missing property' : `kind must be 'event' or 'state', got ${JSON.stringify(o.kind)}`);
      continue;
    }
    // A call review an agent wrote (the revenue plugin, GET-260). Not a fact on the account: it
    // becomes the call's scorecard and Call page through the same core store the worker uses.
    if (o.property === 'call_review') {
      callReviews.push(await recordCallReviewFromAgent(supabase, workspaceId, {
        value: o.value, focusEntityId: entityId, userId: opts.userId ?? null,
        observedAt: o.observed_at ?? null, sourceRef: o.source_ref ?? null,
      }).catch(err => ({ status: 'error', error: err.message })));
      continue;
    }
    // A constraint — something this operator does not do. Not an observation about the
    // account, so it never touches the spine; it is a standing instruction about us.
    //
    // Routed through the one write door on purpose: an agent that has just been told "I never
    // do that" should be able to write it down without reaching for different machinery, in
    // the same call it was already making.
    // A stated preference — how this operator wants things, said outright rather than inferred
    // from a correction. "Always write shorter" has no other door: constraints have one, and
    // preferences only arrived as a side effect of a verdict, so a preference volunteered in
    // conversation was simply lost.
    //
    // The sibling of a constraint and deliberately weaker. A constraint is not up for weighing
    // and we refuse to generate against it; a preference should be followed unless the
    // situation clearly calls for something else.
    if (o.kind === 'state' && o.property === 'preference') {
      const v = (o.value && typeof o.value === 'object') ? o.value : { statement: o.value };
      try {
        await addPreference(supabase, workspaceId, {
          statement: v.statement,
          scope: v.scope,
          // Same rule as a constraint: person scope binds to the caller, never to a body field.
          // A preference attached to the wrong person reshapes somebody else's output.
          user_id: v.scope === 'workspace' ? null : (opts.userId ?? v.user_id ?? null),
          applies_to: v.applies_to,
          source: v.source ?? 'stated',
          evidence_ids: v.evidence_ids,
        });
        recorded++;
      } catch (e) {
        console.error('[record] preference write failed:', e.message);
      }
      continue;
    }

    if (o.kind === 'state' && o.property === 'constraint') {
      const v = (o.value && typeof o.value === 'object') ? o.value : { statement: o.value };
      try {
        await addConstraint(supabase, workspaceId, {
          statement: v.statement,
          scope: v.scope,
          // Person scope needs an owner, and it comes from the caller's identity rather than
          // the body. A constraint bound to the wrong person is worse than one that failed to
          // save — it silently stops someone else from being offered something they wanted.
          user_id: v.scope === 'workspace' ? null : (opts.userId ?? v.user_id ?? null),
          action_type: v.action_type,
          category: v.category,
          source: v.source,
          evidence_ids: v.evidence_ids,
        });
        recorded++;
      } catch (e) {
        console.error('[record] constraint write failed:', e.message);
      }
      continue;
    }


    // Decision loop — what we RECOMMENDED and what the human did with it. An agent that
    // prefers the single MCP write door records these as decision.* properties instead of
    // calling /v2/decisions directly; both land in the same table. The value carries
    // { decision_id, proposal?, verdict?, ... }. Kept out of the observation spine on
    // purpose: a proposal is not something that happened to the account, it is something
    // we said about it — and mixing the two would pollute the interaction timeline.
    if (o.property?.startsWith('decision.')) {
      const v = (o.value && typeof o.value === 'object') ? o.value : {};
      const decisionId = v.decision_id ?? o.decision_id ?? o.external_id;
      if (!decisionId) {
        console.warn('[record] decision.* without a decision_id — dropped');
        continue;
      }
      const stage = o.property.slice('decision.'.length);
      try {
        if (stage === 'proposed') {
          await proposeDecision(supabase, workspaceId, {
            ...v, decision_id: decisionId, entity_id: entityId,
            surface: v.surface ?? 'plugin', agent: v.agent ?? o.source ?? 'agent',
          });
        } else if (stage === 'confirmed') {
          await confirmDecision(supabase, workspaceId, decisionId, { ...v, confirmed_via: v.confirmed_via ?? 'agent' });
        } else {
          // accepted | edited | rejected — the verdict IS the property name, so a skill
          // cannot report a verdict and a contradicting payload at the same time.
          await recordVerdict(supabase, workspaceId, decisionId, { ...v, verdict: stage });
        }
        recorded++;
      } catch (e) {
        console.error('[record] decision write failed:', o.property, e.message);
      }
      continue;
    }

    // Intel facts — the account's atomic memory: a preference, an objection, a
    // competitor, a general note ABOUT the contact. These are categorized note.*
    // claims (the Intel tab / get_account `facts`), not timeline observations. The
    // plugin writes them through record with property 'intel' and a
    // { category, content, label? } value; route them to saveNote so they get the
    // note.<uuid> shape + embedding the read path already expects. (No read-path
    // change: listNotes reads note.* claims exactly as before.)
    if (o.kind === 'state' && (o.property === 'intel' || o.property === 'note')) {
      const v = (o.value && typeof o.value === 'object') ? o.value : {};
      const content = v.content ?? (typeof o.value === 'string' ? o.value : null);
      if (content && String(content).trim()) {
        // Drop facts that address the subject in 1st/2nd person (see guard above).
        if (violatesPronounRule(String(content))) {
          console.warn('[record] dropped intel fact (pronoun rule):', String(content).slice(0, 120));
          reject(o, PRONOUN_RULE_REASON);
          continue;
        }
        // Snap the agent's category to the canonical taxonomy (same normalizer the
        // server extractor uses), so a plugin that sends 'timing' or 'competitors' lands
        // on 'timeline'/'competitor' instead of persisting a non-canonical key.
        const cat = normalizeClaimCategory(v.category);
        // A company category goes on the company whatever the caller tagged (GET-776), the same
        // rule the worker applies — two writers, one answer.
        const about = claimAboutFor(cat, v.about);
        // Context tags — what makes a signal a real risk vs noise (computeDealHealth
        // reads these). Only stamped for the categories that carry them, exactly like
        // the worker's persistFacts.
        // The EVIDENCE. `quote` is the verbatim line that produced this fact and
        // `speaker` is who said it, both extracted by the plugin (see the plugin's
        // claim-extraction reference). They are what makes a fact checkable rather
        // than something the user takes on faith, and the read path renders them
        // under the fact. Stored only when non-empty — an absent quote is honest
        // (an attendee list or a CRM field has nothing quotable) and the renderer
        // omits the line rather than printing empty quotes.
        const quote = typeof v.quote === 'string' ? v.quote.trim().slice(0, 400) : '';
        const speaker = typeof v.speaker === 'string' ? v.speaker.trim().slice(0, 80) : '';
        const metadata = {
          about,
          extraction_source: o.source || 'agent',
          ...(quote ? { quote } : {}),
          ...(speaker ? { speaker } : {}),
          ...(o.source_ref ? { source_ref: o.source_ref } : {}),
          // The SAME declaration the worker stamps from (claimSubtagsFor). This list used to live
          // here as its own copy of competitor/objection, and `role` and `change` — added to the
          // worker in September — never arrived, so every claim written through the plugin lost
          // them while the category itself landed fine. A silent, category-shaped hole (GET-364).
          ...claimSubtagsFor(cat, v),
          // Free text beside the closed sets: `competitor.entity`, `expansion_signal.product`.
          // Same declaration as the worker (GET-401).
          ...claimFreeTextFor(cat, v),
          graph_layer: 'private',
          // WHICH API KEY WROTE IT (API plan E6, GET-620). A conversation this claim cites is billed
          // later, by the worker's read ledger, the first time a claim cites it; the ledger copies
          // this onto the read so the key's credits can be counted. Only a key-authed request sets
          // it: the in-app agent, a session call and every integration leave it off.
          ...(opts.apiKeyId ? { api_key_id: opts.apiKeyId } : {}),
        };
        // WHOSE RECORD THIS BELONGS ON (GET-366).
        //
        // The plugin skill promises: "set about:'company' — the engine routes it to the company for
        // you." It did not. Every intel fact landed on the focused person whatever `about` said, so
        // an account's lead volumes and tech stack and seasonality sat on one contact — and the
        // account page reads company-pinned claims, so most of what the plugin wrote was invisible
        // on the account it described.
        //
        // Same rule as the worker's persistFacts, including its exception: a buying_signal is a
        // specific person's move on the deal, and stage and intent are person-level, so it stays on
        // whoever voiced it. Everything else routes up when we know the company.
        const targetEntityId = (cat !== 'buying_signal' && about === 'company' && companyEntityId)
          ? companyEntityId : entityId;
        // Who said it, kept on the claim once it has moved off their record — so the company page
        // can show "from Ysolde on the Larkfield Toyota call" without duplicating the fact. The worker
        // stamps this; without it a routed claim arrives at the company anonymous.
        if (targetEntityId !== entityId) metadata.voiced_by_contact_id = entityId;

        // IDEMPOTENCY, which this path claimed and did not have (GET-365).
        //
        // `external_id` is documented on the tool as "re-recording the same one is a no-op". For
        // intel it was accepted, never stored, and never checked: saveNote inserts under a fresh
        // note.<uuid> every call. An agent that retried after a partial write wrote a dozen duplicates,
        // which is the natural response to a partial write, so the bug was reachable by anyone
        // following the tool's own instructions.
        const extId = typeof o.external_id === 'string' ? o.external_id.trim().slice(0, 200) : '';
        if (extId) {
          metadata.external_id = extId;
          const { data: dupe, error: dupeErr } = await supabase.from('claims')
            .select('id').eq('workspace_id', workspaceId).like('property', 'note.%')
            .eq('value->metadata->>external_id', extId).limit(1);
          // A failed check must not write a duplicate on a guess. Skipping loses at most one
          // claim, which a re-run recovers; duplicating is permanent and there is no delete tool.
          if (dupeErr) {
            console.warn('[record] intel dedupe check failed, skipping:', dupeErr.message);
            reject(o, `dedupe check failed, not written: ${dupeErr.message}`);
            continue;
          }
          if ((dupe ?? []).length) { recorded++; continue; }   // already filed — a real no-op
        }

        await saveNote(supabase, workspaceId, {
          entityId: targetEntityId,
          category: cat,
          label: typeof v.label === 'string' ? (v.label.trim().slice(0, 40) || undefined) : undefined,
          content: String(content).trim(),
          source: o.source || 'agent',
          metadata,
        });
        recorded++;
      } else {
        // An intel observation with nothing to file. Silently skipping it is how a caller
        // ends up believing a fact landed (GET-369).
        reject(o, 'intel observation has no content');
      }
      continue;
    }

    // `domain` is the EMPLOYER's identifier — handled on the company entity above, so don't
    // pile it on the person. But KEEP `company` (the name) on the person: the People LIST view
    // reads the person's `company` string column, so dropping it left that column blank even
    // though the works_at link resolved on the detail page. Record it on both.
    if (companyEntityId && o.kind === 'state' && o.property === 'domain') continue;

    const result = await recordObservation(supabase, {
      workspaceId,
      entityId,
      kind: o.kind,
      property: o.property,
      value: o.value ?? null,
      source: o.source || 'agent',
      method: o.method || 'api',
      observedAt: o.observed_at,
      externalId: o.external_id,
      // Stamp the decision this action came from onto the observation itself. That is
      // the whole attribution mechanism: decisionTraces.mjs picks up any send carrying a
      // decision_id (or the app's rec_id) and starts watching for what came back. Without
      // it an agent-sent email is an orphan action nobody can grade.
      raw: o.decision_id ? { ...(o.raw ?? {}), decision_id: o.decision_id } : o.raw,
      // Provenance when raw lives at the edge (git): the caller passes an explicit
      // pointer + hash instead of the raw body, so resolveRaw can fetch + verify later
      // without Nous ever storing the transcript/email. Falls back to the derived
      // source://<source>/<external_id> + hash(raw) when omitted.
      sourceRef: o.source_ref,
      contentHash: o.content_hash,
    });
    if (result) {
      recorded++;
      if (o.kind === 'state') touchedProps.add(o.property);
    }

    // Automation → worklist: a follow-up drafted by the after-call run surfaces on the Custom-plan
    // Focus home as a "follow-up ready" flag. The draft itself stays in the user's git; this is only
    // the "you have one to review" signal. Idempotent per (account, flag_type); a dismissed flag
    // stays dismissed, so it never re-nags. (The Install/plugin home never shows flags.)
    if (o.kind === 'state' && o.property === 'signal.follow_up_ready') {
      const v = o.value && typeof o.value === 'object' ? o.value : {};
      await upsertFlag(supabase, workspaceId, {
        entityId,
        flagType: 'follow_up_ready',
        reason: 'Follow-up drafted — review and send',
        evidence: { draft_path: v.draft_path ?? null, channel: v.channel ?? null, drafted_at: v.drafted_at ?? o.observed_at ?? null },
        source: 'after-call',
      }).catch(() => {});
    }
  }

  // Recompute the affected claims inline so the agent sees the effect now.
  const claimsRecomputed = [];
  for (const property of touchedProps) {
    try {
      await recomputeClaim(supabase, workspaceId, entityId, property);
      claimsRecomputed.push(property);
    } catch (e) {
      console.error('[record] recompute failed:', property, e.message);
    }
  }

  // If a buying signal changed, (re)score the entity's ICP prediction NOW.
  // Signals are scorecard features, but scoring was previously only triggered
  // by the claim-engine worker — and that worker only RE-scores an entity that
  // ALREADY has an open prediction. A fresh lead that gets signal-scanned had
  // no prediction, so nothing ever staked one (the sidebar stayed "Not scored
  // yet"). Here: rescore the open prediction in place, or stake one if none
  // exists. Both gate on scoreable features (job_title/seniority/industry/…),
  // so an unenriched lead is correctly skipped (the lead-list fields.icp_score
  // fallback covers its sidebar). Best-effort — never block the write.
  // exclusion.* is a disqualifier feature, signal.* a buying-signal feature —
  // both are scorecard inputs, so either changing must (re)score now.
  let icpScored = null;
  if ([...claimsRecomputed].some(p => p.startsWith('signal.') || p.startsWith('exclusion.'))) {
    try {
      const signals = await listSignals(supabase, workspaceId);
      if (signals.some(s => s.active)) {
        // A signal/exclusion recorded on a COMPANY (focus = a domain) drives the
        // scores of its PEOPLE, not the company itself. Fan out so the whole
        // buying committee re-scores immediately — an exclusion flag caps every
        // contact at the account now, not on the next pass.
        const fan = await rescoreCompanyMembers(supabase, workspaceId, entityId, { signals });
        if (fan.members) {
          icpScored = { status: 'committee_rescored', members: fan.members, rescored: fan.rescored };
        } else {
          // A person's own signal/intent — re-score (or stake) that person.
          const r = await rescoreEntityFromClaims(supabase, workspaceId, entityId, { signals });
          if (r.status === 'no_open_prediction') {
            const staked = await scoreAndStake(supabase, workspaceId, entityId, signals);
            icpScored = staked ? { status: 'staked', score: staked.score } : { status: 'not_scoreable' };
          } else {
            icpScored = { status: r.status, score: r.to ?? null };
          }
        }
      }
    } catch (e) {
      console.error('[record] icp (re)score failed:', e.message);
    }
  }

  return {
    ok: true, entity_id: entityId, recorded, claims_recomputed: claimsRecomputed, icp_scored: icpScored,
    // Only present when something was actually refused, so a clean write stays a clean
    // response — but a partial one can no longer pass for a complete one (GET-369).
    ...(rejected.length ? { rejected } : {}),
    ...(callReviews.length ? { call_reviews: callReviews } : {}),
  };
}
