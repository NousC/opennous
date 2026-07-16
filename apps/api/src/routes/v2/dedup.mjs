import { Router } from 'express';
import { getSupabaseClient, classifyIdentifiers } from '@nous/core';

export const dedupV2Router = Router();

// POST /v2/dedup — the cross-list cold-outbound dedup primitive.
//
// The "pre-flight before you pay" check. You're about to scrape 10k leads on
// Apollo for $300 — paste in the LinkedIn URLs (visible for free in Apollo's
// preview), get back which ones you already have. Buy only the difference.
//
// Body — at least one of:
//   { emails:        string[] }  // up to 50,000
//   { linkedin_urls: string[] }  // up to 50,000
//   { domains:       string[] }  // up to 50,000 — company-level dedup
//   any combination — combined response
//
// `domains` is the pre-spend, company-level gate: "do I already have anyone at
// this company?" Pass the domains from your discovery source (e.g. DiscoLike),
// keep only `net_new`, and enrich people only at companies you don't already
// have — so you never pay to re-enrich the agencies already in your pipeline.
//
// Response:
//   {
//     results: [
//       { kind, value, status, entity_id?, reason?,
//         email_status?, enriched_at?, stale? }   // coverage — present when we already have them
//     ],
//     summary: { net_new, engaged, recent, bounced, unsubscribed, suppressed, known,
//                needs_enrichment, reusable, total }
//   }
//
// Status semantics:
//   net_new       — no prior record. Safe to send / safe to buy.
//   engaged       — in an active conversation. Don't cold-send.
//   recent        — contacted in the last 30 days. Defer.
//   bounced       — last delivery bounced (email-only signal). Skip.
//   unsubscribed  — opted out or do-not-contact. Skip.
//   suppressed    — workspace-level suppression policy. Skip.
//   known         — (domain) a company already in the workspace. Skip.
//
// Coverage (the freshness layer — answers "re-buy vs re-enrich vs reuse"):
//   stale=true        — we own this identity but it wasn't enriched in the last
//                       90 days (or never). RE-ENRICH it (cheap, often free for an
//                       email you already verified) rather than re-buying it.
//   stale=false +
//   email_status set  — we have a fresh, verified email. REUSE it; don't spend.
//   enriched_at       — when we last enriched them (null = never).
//   needs_enrichment  — summary count of entities you already have that are stale.
//   reusable          — summary count with a fresh verified email (pure savings).

// The core helper chunks every IN query internally, so this ceiling reflects
// reasonable per-request work, not a URL-length constraint.
const MAX_PER_BATCH = 50_000;

dedupV2Router.post('/', async (req, res) => {
  try {
    const { emails, linkedin_urls, domains } = req.body || {};
    const emailList = Array.isArray(emails) ? emails : [];
    const linkedinList = Array.isArray(linkedin_urls) ? linkedin_urls : [];
    const domainList = Array.isArray(domains) ? domains : [];

    if (emailList.length === 0 && linkedinList.length === 0 && domainList.length === 0) {
      return res.status(400).json({
        error: 'identifiers_required',
        message: 'Body must include a non-empty `emails`, `linkedin_urls`, or `domains` array.',
      });
    }
    if (emailList.length > MAX_PER_BATCH || linkedinList.length > MAX_PER_BATCH || domainList.length > MAX_PER_BATCH) {
      return res.status(413).json({
        error: 'too_many',
        message: `Maximum ${MAX_PER_BATCH} of each kind per call. Split into batches.`,
        max: MAX_PER_BATCH,
      });
    }

    const supabase = getSupabaseClient();
    const results = await classifyIdentifiers(supabase, req.workspaceId, {
      emails: emailList,
      linkedin_urls: linkedinList,
      domains: domainList,
    });

    const summary = {
      net_new: 0, engaged: 0, recent: 0,
      bounced: 0, unsubscribed: 0, suppressed: 0, known: 0,
      // Coverage roll-ups: who you already have but should re-enrich (stale), and
      // who you have with a fresh verified email (reuse — pure savings).
      needs_enrichment: 0, reusable: 0,
      total: results.length,
    };
    for (const r of results) {
      summary[r.status] = (summary[r.status] || 0) + 1;
      if (r.entity_id && r.stale) summary.needs_enrichment++;
      else if (r.entity_id && r.email_status) summary.reusable++;
    }

    return res.json({ results, summary });
  } catch (err) {
    console.error('[POST /v2/dedup]', err?.message, '| code:', err?.code, '| details:', err?.details, '| hint:', err?.hint);
    return res.status(500).json({ error: 'internal_error' });
  }
});
