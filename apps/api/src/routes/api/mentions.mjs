// @-mention lookup for the composer.
//
// The agent resolves a name by scanning claims in memory — correct, and far too slow to run
// on a keystroke (it pages up to 50,000 claim rows). This is the typeahead counterpart: a
// DB-side ILIKE over the two tables a person actually means when they type a name, capped
// small and answerable in one round trip.
//
// It exists because the agent kept failing to find accounts. Two different problems hide
// behind that complaint: the operator typed the name slightly wrong, and the resolver does
// exact substring matching so a typo finds nothing. A mention fixes it at the source — the
// operator picks the real record from a list, and what reaches the agent is unambiguous
// rather than a spelling it has to guess at.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { hasListRows } from '../../lib/listRows.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const mentionsRouter = Router();

const LIMIT = 8;   // a menu you scan, not a result set you page

// GET /api/mentions?workspaceId=…&q=jack
mentionsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, q } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const term = String(q ?? '').trim();
    const supabase = getSupabaseClient();

    // An EMPTY term is a real question, not a non-answer.
    //
    // Typing "@" on its own used to return nothing, so the menu appeared only once you had
    // guessed two correct letters — which is backwards, because "@" is what you reach for
    // precisely when you do NOT want to spell the name. Every mention picker people already
    // know (Slack, Linear, Notion) opens on the character itself. With no term it answers
    // "what have you been working on", ordered by last activity, which is usually the thing
    // being reached for anyway.
    const t = term ? `%${term}%` : null;

    // Read the FLATTENED rows, not the contacts/companies views (GET-316).
    //
    // Two queries, and both were ordered by `last_activity_at` — which on those views is an
    // aggregate over every activity of every person at the account. Measured on the live API:
    // this endpoint took 8.2 SECONDS, every time, a hair under the statement budget, on a
    // keystroke. entity_list_rows holds the same fields with an index on exactly this order.
    //
    // Probe EACH kind. One 'person' probe used to gate BOTH branches, so a workspace with
    // account rows but no person rows sent the ACCOUNT lookup down the view path — and on
    // one customer's ten thousand accounts that path is not slow, it is unfinishable: measured three times
    // past 120,000 ms, all three killed by Postgres' own 2-minute ceiling,
    // against an 8s PostgREST budget. Two probes cost ~2ms on the (workspace_id, entity_id)
    // primary key, so asking the question properly is free.
    const [peopleFlat, accountsFlat] = await Promise.all([
      hasListRows(supabase, workspaceId, 'person').catch(() => false),
      hasListRows(supabase, workspaceId, 'account').catch(() => false),
    ]);

    const [{ data: people }, { data: companies }] = await Promise.all([
      (() => {
        if (peopleFlat) {
          let query = supabase.from('entity_list_rows')
            .select('entity_id, name, email, company_name, company_id, last_activity_at')
            .eq('workspace_id', workspaceId).eq('kind', 'person');
          if (t) query = query.or(`name.ilike.${t},email.ilike.${t},company_name.ilike.${t}`);
          return query.order('last_activity_at', { ascending: false, nullsFirst: false })
            .limit(LIMIT)
            .then(r => ({ data: (r.data ?? []).map(p => ({
              id: p.entity_id, first_name: p.name, last_name: null,
              email: p.email, company: p.company_name, company_id: p.company_id,
            })) }), () => ({ data: [] }));
        }
        // No person rows means the sweep has not run for this workspace yet. The old fallback
        // read the `contacts` view ordered by last_activity_at, on the theory that slow beats
        // an empty menu. It is not slow, it is dead: that ordering is a correlated subplan per
        // person and it cannot finish inside the 8s budget on any workspace big enough to care.
        // An empty menu for the minutes before the first sweep beats a keystroke that hangs.
        return Promise.resolve({ data: [] });
      })(),
      (() => {
        if (accountsFlat) {
          let query = supabase.from('entity_list_rows')
            .select('entity_id, name, domain, last_activity_at')
            .eq('workspace_id', workspaceId).eq('kind', 'account');
          if (t) query = query.or(`name.ilike.${t},domain.ilike.${t}`);
          return query.order('last_activity_at', { ascending: false, nullsFirst: false })
            .limit(LIMIT)
            .then(r => ({ data: (r.data ?? []).map(c => ({ id: c.entity_id, name: c.name, domain: c.domain })) }),
                  () => ({ data: [] }));
        }
        // NOT last_activity_at. On this view that column is GREATEST(own activity, staff
        // activity) — a correlated subplan per account plus one per employee. A LIMIT does not
        // push through a Sort, so ordering by it computes every one of thousands of values before returning 8.
        // Measured on a customer workspace at LIMIT 8: `id` 289ms, no ordering at all 292ms, `created_at`
        // 302ms, `last_activity_at` >120,000ms (killed by the 2-minute server ceiling).
        //
        // `id` rather than `created_at` because they cost the same and `id` does not promise a
        // recency the row order cannot deliver on an unswept import. Same rule already shipped
        // in companies.mjs:181 and contacts.mjs:176 ("Id is the only free column here").
        let query = supabase.from('companies')
          .select('id, name, domain')
          .eq('workspace_id', workspaceId);
        if (t) query = query.or(`name.ilike.${t},domain.ilike.${t}`);
        return query.order('id')
          .limit(LIMIT).then(r => r, () => ({ data: [] }));
      })(),
    ]);

    const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ').trim();

    const results = [
      // Companies first when the term looks like one: a person typing "Harborline" almost
      // always means the account, and a contact who merely works there is the fallback.
      ...(companies ?? []).map(c => ({
        id: c.id, kind: 'company', label: c.name || c.domain || 'Unknown',
        detail: c.domain || null, domain: c.domain || null,
      })),
      ...(people ?? []).map(p => ({
        id: p.id, kind: 'person', label: fullName(p) || p.email || 'Unknown',
        detail: p.company || p.email || null,
        domain: null, email: p.email || null, company_id: p.company_id || null,
      })),
    ]
      // An exact prefix is what the operator is reaching for; rank it above a mid-string hit.
      // With no term there is nothing to prefix-match, so the recency order above stands.
      .sort((a, b) => {
        if (!term) return 0;
        const pa = a.label.toLowerCase().startsWith(term.toLowerCase()) ? 0 : 1;
        const pb = b.label.toLowerCase().startsWith(term.toLowerCase()) ? 0 : 1;
        return pa - pb;
      })
      .slice(0, LIMIT);

    return res.json({ results });
  } catch (err) {
    console.error('[GET /api/mentions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
