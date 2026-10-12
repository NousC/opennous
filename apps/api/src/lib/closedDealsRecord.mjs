// Recording closed deals — the public half of record_closed_deals (POST /v2/icp/closed-deals,
// POST /v2/workspace/closed-deals) and of the CRM sync's closed-deal pass.
//
// For each won or lost domain: resolve the company, read its website signals, link every contact
// already known there (works_at), and write the won/lost onto each of them and the company, with
// the deal's money and close date. Writing the outcome is what grades an account's open icp_fit
// prediction (services/outcomes.ts), whoever made it, so a workspace that scores for itself
// (POST /v2/scores, GET-586) is graded against these deals too.
//
// Learning from them — discovering the signals that predict a win, re-scoring, staking the
// imported accounts — is the learned ICP scorer's, Nous Cloud's (cloud/lib/closedDealsLearn.mjs,
// GET-754 slice 8). It runs after the deals are recorded, when the build has it.
import { getOrCreateEntity, logActivity, pipelineFeatures } from '@nous/core';
import { normalizeClosedDeals } from './closedDeals.mjs';
import { extractAndRecordWebsiteSignals } from '../services/websiteSignals.mjs';
import { learnedIcpModel } from './icpScorer.mjs';

// Record closed deals and, with the learned scorer, learn from them. Returns a result object;
// shared by the web route (cloud), the agent route (POST /v2/workspace/closed-deals) and the CRM
// sync's trainer. Errors propagate to the caller.
export async function runClosedDeals(supabase, workspaceId, { won = [], lost = [], limit = 40 } = {}) {
    // Accepts either a bare domain string (the original shape, still what the web form
    // sends) or a record carrying the deal's real money and close date. See
    // lib/closedDeals.mjs for why this is a separate, pure module.
    const clean = (list) => normalizeClosedDeals(list, Date.now(), { limit });
    const wonList = clean(won), lostList = clean(lost);
    if (wonList.length + lostList.length < 1) {
      return { need_more_deals: true };
    }

    // Seniority ordering — when a company has several contacts (founder + two
    // CEOs), the MOST SENIOR one represents the deal's decision-maker for the
    // buyer traits; we still link and resolve ALL of them.
    const SENIORITY_RANK = { ic: 0, manager: 1, director: 2, vp: 3, c_suite: 4 };

    // Every contact we already have at a domain — recognized three ways:
    //   1. via the company record (companies.domain → contacts.company_id),
    //   2. the contact's own domain (contacts.domain),
    //   3. email as the fallback (entity_identifiers ilike @domain).
    // Returns deduped person entity ids (contact.id == entity.id by convention).
    const findPeopleAtDomain = async (domain) => {
      const ids = new Set();
      const [byContactDomain, comp, emails] = await Promise.all([
        supabase.from('contacts').select('id').eq('workspace_id', workspaceId).eq('domain', domain),
        supabase.from('companies').select('id').eq('workspace_id', workspaceId).eq('domain', domain).maybeSingle(),
        supabase.from('entity_identifiers').select('entity_id').eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active').ilike('value', `%@${domain}`),
      ]);
      for (const c of byContactDomain.data || []) ids.add(c.id);
      for (const e of emails.data || []) ids.add(e.entity_id);
      if (comp.data?.id) {
        const { data: byCompany } = await supabase.from('contacts').select('id')
          .eq('workspace_id', workspaceId).eq('company_id', comp.data.id);
        for (const c of byCompany || []) ids.add(c.id);
      }
      return [...ids];
    };

    const episodes = [];
    let enriched = 0;
    const linked = [];        // contacts we recognized and joined to the deal
    const companyDeals = [];  // {companyId, disposition} — scored after discovery
    const personDeals = [];   // {personId, disposition} — resolved after discovery
    const ingest = async (deal, disposition) => {
      const { domain, amount, currency, closedAt } = deal;
      // The deal's OWN close date drives every observation written below. Falling back to
      // now only when the caller gave us nothing to work with.
      const occurredAt = closedAt ?? new Date().toISOString();
      const dealRaw = { imported: true, amount: amount ?? null, currency: currency ?? null };
      const companyId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: domain }]);
      const r = await extractAndRecordWebsiteSignals(supabase, workspaceId, companyId, domain).catch(() => null);
      if (r) enriched++;

      // Decision-maker linkage — recognize EVERY contact we already have at this
      // company, link each to the company (works_at), and record the won/lost on
      // each: that resolves their open ICP prediction and joins their pipeline
      // history (touches, calls, channel) to the deal.
      const personIds = await findPeopleAtDomain(domain);
      for (const personId of personIds) {
        try {
          await supabase.from('relationships').upsert(
            // Dated to the deal, not to the import run: the close date is a moment we KNOW
            // this person was at this company, which beats stamping 'now' on a link we
            // learned about from a deal that closed two years ago.
            { workspace_id: workspaceId, from_entity_id: personId, to_entity_id: companyId, type: 'works_at', valid_from: occurredAt },
            { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true },
          );
        } catch { /* best-effort link */ }
        await logActivity(supabase, {
          workspaceId, entityId: personId,
          type: disposition === 'won' ? 'deal_won' : 'deal_lost',
          source: 'closed-deals-import', externalId: `import_${disposition}_${personId}`,
          occurredAt,
          // The amount rides on the activity so outcome resolution can read it:
          // deriveRevenue (services/outcomes.ts) looks for raw.amount, so an imported win
          // now resolves its open prediction with REAL revenue instead of null.
          rawData: dealRaw,
          description: disposition === 'won' ? 'Closed-won (closed-deals import)' : 'Closed-lost (closed-deals import)',
        }).catch(() => {});
        personDeals.push({ personId, disposition });
      }

      // Buyer traits for the episode — the most senior linked contact represents
      // the deal's decision-maker; all names are recorded for the UI.
      let buyer = {};
      if (personIds.length) {
        const { data: pc } = await supabase.from('claims').select('entity_id, property, value')
          .in('entity_id', personIds).is('invalid_at', null)
          .in('property', ['job_title', 'seniority', 'department', 'first_name', 'last_name']);
        const byPerson = {};
        for (const c of pc || []) (byPerson[c.entity_id] ||= {})[c.property] = c.value;
        let bestRank = -1;
        for (const pid of personIds) {
          const p = byPerson[pid] || {};
          const rank = SENIORITY_RANK[p.seniority] ?? 0;
          if (rank >= bestRank) { bestRank = rank; buyer = { job_title: p.job_title, seniority: p.seniority, department: p.department }; }
          const full = [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
          linked.push({ domain, name: full || 'a contact' });
        }
      }

      // Record the deal on the company too (the company-level discovery cohort).
      await logActivity(supabase, {
        workspaceId, entityId: companyId,
        type: disposition === 'won' ? 'deal_won' : 'deal_lost',
        source: 'closed-deals-import', externalId: `import_${disposition}_${companyId}`,
        occurredAt,
        rawData: dealRaw,
        description: disposition === 'won' ? 'Imported closed-won' : 'Imported closed-lost',
      }).catch(() => {});

      // Account-level money, using the same vocabulary as the CRM rollup so both import
      // paths write the same facts.
      //
      // An imported deal is HISTORY, so it lands on won_deal_value / lost_deal_value and
      // never on `deal_value`, which means LIVE pipeline. Writing a deal that closed last
      // year as deal_value would make it read as open pipeline and inflate the forecast by
      // exactly the amount of every deal already in the bank.
      if (amount != null) {
        await supabase.from('observations').insert({
          workspace_id: workspaceId,
          entity_id: companyId,
          kind: 'state',
          property: disposition === 'won' ? 'won_deal_value' : 'lost_deal_value',
          value: amount,
          source: 'closed-deals-import',
          method: 'manual',
          observed_at: occurredAt,
        }).then(() => {}, () => {});
      }

      // Episode features = company firmographics/signals + the decision-maker's
      // own traits (job_title/seniority/department) + the pipeline-engagement of
      // the deal (lead source, channel, inbound/outbound, meetings/touches) — so
      // discovery learns *who* buys and *how* the deal went, not just *what* the
      // company is.
      const { data: companyClaims } = await supabase
        .from('claims').select('property, value').eq('entity_id', companyId).is('invalid_at', null);
      const features = {};
      for (const c of companyClaims ?? []) features[c.property] = c.value;
      for (const [k, v] of Object.entries(buyer)) if (v != null && !(k in features)) features[k] = v;
      if (personIds.length) {
        const { data: pacts } = await supabase
          .from('observations').select('property, source, observed_at')
          .in('entity_id', personIds).eq('kind', 'event').like('property', 'interaction.%')
          .order('observed_at', { ascending: true }).limit(1000);
        for (const [k, v] of Object.entries(pipelineFeatures(pacts || []))) if (!(k in features)) features[k] = v;
      }
      episodes.push({ features, disposition });
      // Only surface the COMPANY as its own analyzed row when we have no contact
      // there — otherwise the linked person IS the account (with the real
      // pipeline), and a separate company row just duplicates it.
      companyDeals.push({ companyId, disposition, hasContacts: personIds.length > 0 });
    };
    for (const d of wonList) await ingest(d, 'won');
    for (const d of lostList) await ingest(d, 'lost');

    // Learn from the cohort (Cloud). Without the learned scorer nothing is discovered or staked;
    // the deals are recorded and grade whatever scores the workspace already has.
    const learned = await learnedIcpModel();
    const { surfaced, mode, discovered } = learned
      ? await learned.learnFromClosedDeals(supabase, workspaceId, { episodes, companyDeals, personDeals })
      : { surfaced: 0, mode: null, discovered: [] };

    return {
      surfaced,
      enriched, won: wonList.length, lost: lostList.length, mode,
      linked: [...new Map(linked.map(l => [l.name, l])).values()],
      discovered,
    };
}
