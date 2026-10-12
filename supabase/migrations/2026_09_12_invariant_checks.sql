-- Every defect found on 2026-09-12 was a violated invariant that nobody was
-- asserting. Not one needed a model, a heuristic, or a judgment call to detect —
-- each is a query returning a number that should be zero:
--
--   ~95% of active people had a LinkedIn URL we could match on but not read
--   ~40% of LinkedIn profiles were in a shape a lookup can never match
--   most companies had a domain we could match on but not read
--   ~150 extracted claims described somebody other than their subject
--   every row in the unresolved-meeting queue was in fact resolved
--
-- All of it sat in the database, discoverable the day it happened. It surfaced
-- because a human opened a record and saw something stupid.
--
-- The checks live HERE rather than in the worker for two reasons: they are about
-- the data, so they belong next to it; and the alternative — a worker holding SQL
-- strings and an RPC that executes arbitrary SQL — is an injection surface built
-- to solve a problem that does not exist.

CREATE TABLE IF NOT EXISTS invariant_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL,
  name          text        NOT NULL,
  violations    bigint      NOT NULL,
  -- Enough of the offending rows to act on without re-deriving the query.
  sample        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- What SHOULD be true, in one sentence, so a row is legible on its own to
  -- whoever finds it six weeks from now.
  description   text,
  ran_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invariant_checks_name_time
  ON invariant_checks (name, workspace_id, ran_at DESC);

COMMENT ON TABLE invariant_checks IS
  'One row per invariant per workspace per run. Read the TREND, not the level: several of these will never reach zero (a lead-list import legitimately creates identifier-less people), so a jump is the signal, not the absolute count.';

-- Each branch selects the rows that VIOLATE the invariant. Empty is healthy.
-- Every check is named for what SHOULD be true, so a zero reads as health rather
-- than as an absence of information.
CREATE OR REPLACE FUNCTION run_invariants(ws uuid)
RETURNS TABLE (name text, violations bigint, sample jsonb, description text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH
person_without_identifier AS (
  SELECT e.id AS entity_id
    FROM entities e
   WHERE e.workspace_id = ws AND e.type = 'person' AND e.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM entity_identifiers i
                      WHERE i.entity_id = e.id AND i.status = 'active')
),
identifier_not_canonical AS (
  SELECT i.id, i.entity_id, i.kind, i.value
    FROM entity_identifiers i
   WHERE i.workspace_id = ws AND i.status = 'active'
     AND i.value IS DISTINCT FROM normalise_identifier(i.kind, i.value)
),
identifier_malformed_email AS (
  SELECT i.id, i.entity_id, i.value
    FROM entity_identifiers i
   WHERE i.workspace_id = ws AND i.status = 'active' AND i.kind = 'email'
     AND i.value !~ '^[^@[:space:],;]+@[^@[:space:],;]+\.[a-z]{2,}$'
),
company_domain_unreadable AS (
  SELECT e.id AS entity_id, i.value AS domain
    FROM entities e
    JOIN entity_identifiers i
      ON i.entity_id = e.id AND i.kind = 'domain' AND i.status = 'active'
   WHERE e.workspace_id = ws AND e.type = 'company' AND e.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM claims c
                      WHERE c.entity_id = e.id AND c.property = 'domain'
                        AND c.invalid_at IS NULL)
),
company_without_identifier AS (
  SELECT e.id AS entity_id
    FROM entities e
   WHERE e.workspace_id = ws AND e.type = 'company' AND e.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM entity_identifiers i
                      WHERE i.entity_id = e.id AND i.status = 'active')
),
named_people AS (
  SELECT e.id,
         lower(trim(
           coalesce((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'first_name' AND invalid_at IS NULL LIMIT 1), '')
           || ' ' ||
           coalesce((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'last_name'  AND invalid_at IS NULL LIMIT 1), '')
         )) AS full_name
    FROM entities e
   WHERE e.workspace_id = ws AND e.type = 'person' AND e.status = 'active'
),
duplicate_people_by_name AS (
  SELECT full_name, count(*) AS copies, array_agg(id) AS entity_ids
    FROM named_people
   WHERE length(full_name) > 3
   GROUP BY full_name
  HAVING count(*) > 1
),
claim_does_not_name_its_subject AS (
  -- Only judged for facts about the PERSON. A fact tagged about:"company" names
  -- the company by design ("Corvane raised from Tallis Partners") and mentions
  -- nobody, so holding it to this rule would flag every correct company fact.
  SELECT c.id, c.entity_id, c.value->>'content' AS content
    FROM claims c
    JOIN entities e ON e.id = c.entity_id AND e.type = 'person'
   WHERE c.workspace_id = ws
     AND c.property LIKE 'note.%' AND c.invalid_at IS NULL
     AND c.value->>'source' = 'signal_extraction'
     AND coalesce(c.value->'metadata'->>'about', 'person') = 'person'
     -- Only where we actually know a name to check against; no name means the
     -- check has nothing to say, not that the claim is wrong.
     AND EXISTS (SELECT 1 FROM claims n
                  WHERE n.entity_id = e.id AND n.property = 'first_name'
                    AND n.invalid_at IS NULL AND length(n.value #>> '{}') >= 3)
     AND NOT EXISTS (
           SELECT 1 FROM claims n
            WHERE n.entity_id = e.id AND n.property IN ('first_name', 'last_name')
              AND n.invalid_at IS NULL AND length(n.value #>> '{}') >= 3
              AND position(lower(n.value #>> '{}') IN lower(c.value->>'content')) > 0)
),
unresolved_queue_actually_resolved AS (
  SELECT u.id, u.title, u.external_id
    FROM unresolved_ingest u
   WHERE u.workspace_id = ws AND u.status = 'pending'
     AND EXISTS (SELECT 1 FROM observations o
                  WHERE o.workspace_id = u.workspace_id
                    AND o.property = 'interaction.meeting_held'
                    AND o.external_id LIKE 'ff_' || u.external_id || '_%')
),
system_note_rendered_as_intel AS (
  SELECT c.id, c.entity_id, c.value->>'content' AS content
    FROM claims c
   WHERE c.workspace_id = ws
     AND c.property LIKE 'note.%' AND c.invalid_at IS NULL
     AND c.value->>'category' = 'Data Quality'
),
identifier_unreadable AS (
  -- The same write-only shape as company domains, and far bigger: most of the
  -- active people in a typical workspace hold a linkedin_url IDENTIFIER and no
  -- linkedin_url CLAIM. They are perfectly resolvable and the page shows blank,
  -- because the UI and the agent read claims. Attaching an identifier and
  -- asserting the claim are one act, not two.
  SELECT i.entity_id, i.kind, i.value
    FROM entity_identifiers i
    JOIN entities e ON e.id = i.entity_id AND e.status = 'active'
   WHERE i.workspace_id = ws AND i.status = 'active'
     AND i.kind IN ('email', 'linkedin_url', 'domain')
     AND NOT EXISTS (SELECT 1 FROM claims c
                      WHERE c.entity_id = i.entity_id AND c.property = i.kind
                        AND c.invalid_at IS NULL)
),
member_id_is_not_a_urn AS (
  SELECT i.id, i.entity_id, i.value
    FROM entity_identifiers i
   WHERE i.workspace_id = ws AND i.status = 'active'
     AND i.kind = 'linkedin_member_id' AND i.value NOT LIKE 'ACoA%'
)
SELECT 'person_without_identifier', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM person_without_identifier LIMIT 10) x), '[]'::jsonb),
       'Every active person can be matched by at least one identifier. Without one, the next mention of them forks a new record.'
  FROM person_without_identifier
UNION ALL
SELECT 'identifier_not_canonical', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM identifier_not_canonical LIMIT 10) x), '[]'::jsonb),
       'Every stored identifier is already in the shape a lookup will use. Matching is exact, so a non-canonical value is unreachable.'
  FROM identifier_not_canonical
UNION ALL
SELECT 'identifier_malformed_email', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM identifier_malformed_email LIMIT 10) x), '[]'::jsonb),
       'An email identifier is exactly one well-formed address. Two joined with a comma is two humans in one identifier, and matches neither.'
  FROM identifier_malformed_email
UNION ALL
SELECT 'company_domain_unreadable', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM company_domain_unreadable LIMIT 10) x), '[]'::jsonb),
       'A domain we can match on is also a domain we can read. The identifier serves resolution; the claim is what the UI and the agent see.'
  FROM company_domain_unreadable
UNION ALL
SELECT 'company_without_identifier', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM company_without_identifier LIMIT 10) x), '[]'::jsonb),
       'Every active company has a domain to key on. Without one it has no identifier at all, and every mention mints another copy.'
  FROM company_without_identifier
UNION ALL
SELECT 'duplicate_people_by_name', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM duplicate_people_by_name LIMIT 10) x), '[]'::jsonb),
       'Two active people rarely share a full name, and when they do it is usually one human split in two. Not a must-be-zero check — two real people can share a name — so watch the trend and review the pairs.'
  FROM duplicate_people_by_name
UNION ALL
SELECT 'claim_does_not_name_its_subject', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM claim_does_not_name_its_subject LIMIT 10) x), '[]'::jsonb),
       'An extracted fact names the person whose record it sits on. One that does not is describing somebody else.'
  FROM claim_does_not_name_its_subject
UNION ALL
SELECT 'unresolved_queue_actually_resolved', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM unresolved_queue_actually_resolved LIMIT 10) x), '[]'::jsonb),
       'Nothing sits in the unresolved queue that already landed on somebody. A queue that cries wolf is one the operator stops reading.'
  FROM unresolved_queue_actually_resolved
UNION ALL
SELECT 'system_note_rendered_as_intel', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM system_note_rendered_as_intel LIMIT 10) x), '[]'::jsonb),
       'The note.* namespace holds intelligence about a person, never the resolver talking to itself about its own plumbing.'
  FROM system_note_rendered_as_intel
UNION ALL
SELECT 'identifier_unreadable', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM identifier_unreadable LIMIT 10) x), '[]'::jsonb),
       'An identifier we can match on is also one we can read. The identifier serves resolution; the claim is what the UI and the agent see.'
  FROM identifier_unreadable
UNION ALL
SELECT 'member_id_is_not_a_urn', count(*),
       coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM member_id_is_not_a_urn LIMIT 10) x), '[]'::jsonb),
       'linkedin_member_id holds member URNs. A vanity handle filed there is the same fact as a linkedin_url and will never match one.'
  FROM member_id_is_not_a_urn;
$$;

COMMENT ON FUNCTION run_invariants(uuid) IS
  'Data-quality invariants for one workspace. Each row is (name, violations, sample, description); zero violations is health. Deterministic SQL only — judgment belongs in the nightly reviewer, because a check that can be wrong is a check people learn to ignore.';

GRANT EXECUTE ON FUNCTION run_invariants(uuid) TO authenticated, service_role;
