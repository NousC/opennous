-- A LinkedIn member URN written as a profile URL (/in/ACoAA…) is case-sensitive.
--
-- normalise_identifier() lowercased the whole /in/ handle, which is right for a vanity
-- handle and destroys a URN: `ACoAAA0000000000000000000000000000000` becomes a
-- string that matches no real LinkedIn id. Several hundred linkedin_url identifiers in production
-- hold a URN, and all of them are lowercase — most from the app normaliser, which had the
-- same rule long before the trigger existed. Both now preserve a URN's case.
--
-- Recovery: where the original casing survives in a linkedin_url claim (copied from the
-- identifier before the trigger ran) it is restored below — a handful of rows at time of writing,
-- after the day's merges moved some identifiers away from their claims. The
-- rest have no surviving original and stay as they are; resolveEntity's variant
-- matching includes the lowercase form, so they keep deduplicating re-imports.

CREATE OR REPLACE FUNCTION normalise_identifier(p_kind text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v      text := btrim(coalesce(p_value, ''));
  handle text;
BEGIN
  IF v = '' THEN RETURN NULL; END IF;

  IF p_kind IN ('email', 'domain') THEN
    RETURN lower(v);
  END IF;

  IF p_kind = 'linkedin_url' THEN
    handle := substring(v from '/in/([^/?#]+)');
    IF handle IS NULL OR handle = '' THEN RETURN v; END IF;   -- /company/ pages left untouched
    -- A member URN keeps its case; a vanity handle folds.
    IF handle !~* '^acoa' THEN handle := lower(handle); END IF;
    RETURN 'https://www.linkedin.com/in/' || handle;
  END IF;

  IF p_kind = 'linkedin_member_id' THEN
    IF v LIKE 'ACoA%' THEN RETURN v; END IF;                  -- real URNs are case-sensitive
    RETURN lower(v);
  END IF;

  RETURN v;
END;
$$;

-- Restore the casing where it survives in a claim. Runs after the function above, so
-- the trigger preserves the restored case instead of lowercasing it again.
UPDATE entity_identifiers i
   SET value = 'https://www.linkedin.com/in/' || substring(c.value #>> '{}' from '/in/([^/?#]+)')
  FROM claims c
 WHERE i.kind = 'linkedin_url' AND i.status = 'active'
   AND i.value ~ '/in/acoa'
   AND c.entity_id = i.entity_id AND c.property = 'linkedin_url' AND c.invalid_at IS NULL
   AND (c.value #>> '{}') ~ '/in/ACoA'
   AND lower(substring(c.value #>> '{}' from '/in/([^/?#]+)')) = substring(i.value from '/in/([^/?#]+)');
