-- NOEMA OBSERVATORY (GET-193): the taxonomy becomes data, and extraction quality becomes a number.
--
-- Two additions, both to machinery that already exists.
--
-- 1. THE REGISTRY. The claim taxonomy lives in code (packages/core/src/db/claimCategories.ts) and
--    must stay there: the extractor prompt is built from those descriptions and examples, and a
--    prompt assembled from the database at run time is a new way to fail silently. What the code
--    cannot hold is the LIFECYCLE — which categories are active, which are being watched, which
--    arrived by promotion and on what evidence. That is what this table is for.
--
--    Code answers "what can be extracted". The registry answers "what did we learn, and when".
--
-- 2. THE MEASURES. system_snapshot() already runs nightly across every workspace and writes one row
--    per metric per day. It records how many facts exist and how many sources produced them. It
--    does not record what KIND of facts, or whether any of them are grounded in something a person
--    actually said. Those two questions are the whole of extraction quality.

-- ── 1. The registry ──────────────────────────────────────────────────────────────

create table if not exists public.noema_categories (
  key           text primary key,
  -- proposed: mined from `general`, not yet reviewed by a person
  -- watched:  under the promotion bar, counting
  -- active:   in claimCategories.ts and being extracted
  -- retired:  no longer extracted; existing claims keep the key
  status        text not null check (status in ('proposed','watched','active','retired')),
  label         text not null,
  -- The evidence that moved it, captured AT THE MOMENT of the decision. Recomputing it later
  -- answers a different question, because the corpus has moved on.
  evidence      jsonb not null default '{}'::jsonb,
  rule_version  text null,
  promoted_at   timestamptz null,
  retired_at    timestamptz null,
  notes         text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.noema_categories is
  'Lifecycle and evidence for the claim taxonomy (GET-193/GET-327). Code owns what can be extracted; this owns what we learned and when.';

-- The 13 that exist today. Seeded as active with no promotion evidence, because they predate the
-- rule — honest about their provenance rather than inventing a justification after the fact.
insert into public.noema_categories (key, status, label, notes) values
  ('status_quo',    'active', 'Status Quo',    'Predates the promotion rule.'),
  ('goal',          'active', 'Goal',          'Predates the promotion rule.'),
  ('pain',          'active', 'Pain',          'Predates the promotion rule.'),
  ('objection',     'active', 'Objection',     'Predates the promotion rule.'),
  ('authority',     'active', 'Authority',     'Predates the promotion rule.'),
  ('budget',        'active', 'Budget',        'Predates the promotion rule.'),
  ('timeline',      'active', 'Timeline',      'Predates the promotion rule.'),
  ('buying_signal', 'active', 'Buying Signal', 'Predates the promotion rule.'),
  ('preference',    'active', 'Preference',    'Predates the promotion rule.'),
  ('competitor',    'active', 'Competitor',    'Predates the promotion rule.'),
  ('discovery',     'active', 'Discovery',     'Predates the promotion rule.'),
  ('relationship',  'active', 'Relationship',  'Predates the promotion rule.'),
  ('general',       'active', 'General',       'The unclassified bucket. Also the sensor: what accumulates here is the taxonomy reporting its own gaps.')
on conflict (key) do nothing;

-- The first mining (GET-327, a sample of `general` claims). Proposed rather than active: the code
-- change comes next, and the registry must never claim a category is being extracted when it is not.
-- The examples and counts in these rows are invented (GET-761); prod already ran the original
-- version of this insert, so this edit changes nothing on an existing database.
insert into public.noema_categories (key, status, label, evidence, rule_version, notes) values
  ('proficiency', 'proposed', 'Proficiency',
   '{"claims":15,"accounts":10,"mined_from":"general","examples":["Imogen Thackery knows how to build a report from scratch","Desmond Kilbride has never logged in to the dashboard","Rosalind Achebe installed the mobile app but rarely opens it"]}'::jsonb,
   'promotion-rule-v1',
   'Who is trained, who is dormant, who to remove from a seat. The customer-success blind spot in a sales-shaped taxonomy.'),
  ('seasonality', 'proposed', 'Seasonality',
   '{"claims":10,"accounts":5,"mined_from":"general","examples":["Fenwick Boatyard closes for two weeks at year end","Ashcombe Motors: spring is strong, winter is slow","Corrigan Outdoor sells most of its stock between May and August"]}'::jsonb,
   'promotion-rule-v1',
   'Without it a December collapse in usage reads as churn risk. With it, it is the calendar.'),
  ('adoption', 'proposed', 'Adoption',
   '{"claims":5,"accounts":5,"mined_from":"general","note":"below the >=8 bar on count, promoted because the concept already exists in the health-read vocabulary and its absence from claims is the inconsistency"}'::jsonb,
   'promotion-rule-v1',
   'Captured on a business review, discarded on a training call. Same fact, two fates.'),
  ('customer_base', 'watched', 'Customer Base Profile',
   '{"claims":5,"accounts":5,"mined_from":"general","bar":"needs >=8 claims"}'::jsonb,
   'promotion-rule-v1',
   'Who the dealership sells to. Explains why a feature fails (older clientele will not use a self-service kiosk).'),
  ('compliance', 'watched', 'Compliance / Regulatory',
   '{"claims":5,"accounts":5,"mined_from":"general","bar":"needs >=8 claims"}'::jsonb,
   'promotion-rule-v1',
   'Regulatory change as a buying trigger (TCPA one-to-one consent, mandatory ID verification).')
on conflict (key) do nothing;

-- ── 2. The measures ──────────────────────────────────────────────────────────────
--
-- Extends the nightly snapshot rather than adding a second one. Two shapes:
--
--   LEVELS  the distribution of the corpus as it stands — noema.claims.<category>
--   FLOWS   what happened on the day — written, and how many of those carried a CHECKED quote
--
-- Grounding is measured as a FLOW on purpose. Claims written before quotes existed can never have
-- one, and are not evidence of dishonesty; averaging them into a level would produce a number that
-- starts near zero, climbs for months, and means nothing at any point. The daily rate answers the
-- question actually being asked: of what we asserted today, how much rests on something someone
-- said.

create or replace function public.system_snapshot(ws uuid, inbound_types text[], for_day date default current_date)
 returns table(metric text, value numeric)
 language sql
 stable
 set search_path to 'public'
as $function$
WITH
inbound AS (
  SELECT o.id
    FROM observations o
   WHERE o.workspace_id = ws
     AND o.property = ANY (SELECT 'interaction.' || t FROM unnest(inbound_types) t)
     AND coalesce(o.raw->>'is_outbound', 'false') <> 'true'
     AND coalesce(o.value->>'summary', '') NOT LIKE 'You:%'
),
facts AS (
  SELECT c.value->'metadata'->>'source_activity_id' AS source_id,
         c.value->>'category'                        AS category,
         c.value->'metadata'->>'quote'               AS quote,
         c.computed_at
    FROM claims c
   WHERE c.workspace_id = ws
     AND c.property LIKE 'note.%' AND c.invalid_at IS NULL
     AND c.value->>'source' = 'signal_extraction'
),
cited AS (
  SELECT DISTINCT source_id FROM facts WHERE source_id IS NOT NULL
),
-- What was asserted on the day being measured. A claim written before quotes shipped cannot have
-- one and must not drag the rate.
today AS (
  SELECT * FROM facts WHERE computed_at::date = for_day
)
SELECT 'people.active', count(*)::numeric FROM entities
 WHERE workspace_id = ws AND type = 'person' AND status = 'active'
UNION ALL
SELECT 'companies.active', count(*)::numeric FROM entities
 WHERE workspace_id = ws AND type = 'company' AND status = 'active'
UNION ALL
SELECT 'extraction.inbound_sources', count(*)::numeric FROM inbound
UNION ALL
SELECT 'extraction.inbound_sources_with_claims', count(*)::numeric
  FROM inbound i JOIN cited c ON c.source_id = i.id::text
UNION ALL
SELECT 'extraction.facts_active', count(*)::numeric FROM facts
UNION ALL
SELECT 'identity.unresolved_pending', count(*)::numeric FROM unresolved_ingest
 WHERE workspace_id = ws AND status = 'pending'
-- The distribution. One row per category actually present, the same shape llm.cost_usd.<model>
-- already uses, so a new category needs no migration to start being counted.
UNION ALL
SELECT 'noema.claims.' || coalesce(category, 'unknown'), count(*)::numeric
  FROM facts GROUP BY category
-- Honesty, as a flow.
UNION ALL
SELECT 'noema.claims_written', count(*)::numeric FROM today
UNION ALL
SELECT 'noema.claims_written_grounded', count(*)::numeric
  FROM today WHERE quote IS NOT NULL AND length(quote) > 3
$function$;

comment on function public.system_snapshot(uuid, text[], date) is
  'The nightly per-workspace snapshot (GET-201), extended with Noema measures (GET-193): claim distribution by category, and the share of a day''s claims grounded in a checked quote.';
