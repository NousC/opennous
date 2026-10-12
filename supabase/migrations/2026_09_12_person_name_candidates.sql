-- Identity resolution was reading the workspace through a keyhole.
--
-- resolvePersonByNameFallback — the tier that stops the same human forking into a
-- LinkedIn copy and an email copy — pulled every first_name/last_name claim in the
-- workspace with `.limit(5000)`, no ORDER BY, and filtered them in JavaScript. A large
-- workspace holds more such claims than that, so the fallback saw only part of the
-- graph, and WHICH half was whatever Postgres happened to return that call. A twin
-- outside the slice is invisible, and the resolver forks a duplicate it had every
-- means to avoid.
--
-- Fix the shape, not the number: filter at the database, on an index, and return
-- only the handful of people who share the incoming first name. Raising the limit
-- would just move the cliff.

-- Case-insensitive, because "Rowan" from LinkedIn and "rowan" from a calendar
-- invite are the same person. Partial, because only live name claims are ever
-- candidates.
CREATE INDEX IF NOT EXISTS claims_person_name_lower
  ON claims (workspace_id, property, lower(value #>> '{}'))
  WHERE invalid_at IS NULL AND property IN ('first_name', 'last_name');

-- One row per candidate person: their first name, their surname, and whether they
-- already own an email. That last flag is what the caller's "weak" tier needs — it
-- only attaches to a candidate that has no email of its own, so a match can never
-- overwrite a known address.
CREATE OR REPLACE FUNCTION person_name_candidates(ws uuid, fname text)
RETURNS TABLE (entity_id uuid, first_name text, last_name text, has_email boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    e.id,
    lower(f.value #>> '{}'),
    lower(l.value #>> '{}'),
    EXISTS (
      SELECT 1 FROM entity_identifiers i
       WHERE i.entity_id = e.id AND i.kind = 'email' AND i.status = 'active'
    )
  FROM claims f
  JOIN entities e
    ON e.id = f.entity_id
   AND e.workspace_id = ws
   AND e.type = 'person'
   AND e.status = 'active'
  LEFT JOIN claims l
    ON l.entity_id = e.id
   AND l.workspace_id = ws
   AND l.property = 'last_name'
   AND l.invalid_at IS NULL
  WHERE f.workspace_id = ws
    AND f.property = 'first_name'
    AND f.invalid_at IS NULL
    AND lower(f.value #>> '{}') = lower(fname)
  LIMIT 200;
$$;

COMMENT ON FUNCTION person_name_candidates(uuid, text) IS
  'People in this workspace whose first name matches, for the identity-resolution name fallback. Replaces a client-side scan that truncated the workspace at 5000 unordered claim rows. 200 is a genuine ceiling: a first name shared by 200 active people corroborates nothing, so the caller treats that as ambiguous and refuses to match.';

GRANT EXECUTE ON FUNCTION person_name_candidates(uuid, text) TO authenticated, service_role, anon;
