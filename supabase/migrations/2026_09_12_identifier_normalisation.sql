-- Identity matching is exact-value, so an identifier stored in the wrong shape can
-- never match the same identifier stored in the right shape.
--
-- `normaliseIdentifier()` in @nous/core is correct and has been all along — it
-- lowercases emails and domains and canonicalises a LinkedIn URL to
-- https://www.linkedin.com/in/<handle>. It just isn't the only way in. Five call
-- sites insert into entity_identifiers directly and skip it, and the result is
-- about 40% of person LinkedIn profiles in a non-canonical shape — including one
-- person carrying BOTH .../in/rowanachterberg and .../in/rowanachterberg/ as separate
-- active rows: the same fact twice, neither able to match the other.
--
-- Normalisation in application code is a convention. Here it becomes a guarantee:
-- every write goes through the same function no matter which code path made it.

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
    -- Pull the vanity handle out of whatever shape arrived — with or without a
    -- scheme, a www, a country subdomain, a trailing slash, or a query string —
    -- and re-emit the single canonical form. Anything we cannot parse as an
    -- /in/ profile is returned untouched rather than mangled.
    handle := lower(substring(v from '/in/([^/?#]+)'));
    IF handle IS NULL OR handle = '' THEN RETURN v; END IF;
    RETURN 'https://www.linkedin.com/in/' || handle;
  END IF;

  IF p_kind = 'linkedin_member_id' THEN
    -- This column holds two different things: real member URNs (ACoAA…, which are
    -- base64-ish and CASE-SENSITIVE — lowercasing one corrupts it) and vanity
    -- handles that were filed here by mistake. Only the latter get folded.
    IF v LIKE 'ACoA%' THEN RETURN v; END IF;
    RETURN lower(v);
  END IF;

  RETURN v;
END;
$$;

COMMENT ON FUNCTION normalise_identifier(text, text) IS
  'Canonical form of an identifier value, by kind. Mirrors normaliseIdentifier() in @nous/core. Applied by a BEFORE INSERT OR UPDATE trigger so no write path can bypass it.';

CREATE OR REPLACE FUNCTION entity_identifiers_normalise()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.value := normalise_identifier(NEW.kind, NEW.value);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_identifiers_normalise_trg ON entity_identifiers;
CREATE TRIGGER entity_identifiers_normalise_trg
  BEFORE INSERT OR UPDATE OF kind, value ON entity_identifiers
  FOR EACH ROW EXECUTE FUNCTION entity_identifiers_normalise();

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Canonicalising an existing value can collide with a row that already holds the
-- canonical form. Two cases, and they are NOT the same problem:
--
--   same entity      → the row is a redundant spelling of a fact the entity already
--                      has. Retire it; nothing is lost.
--   different entity → we have just discovered that two entities share an
--                      identifier, i.e. they are the same person. That is a MERGE
--                      decision, and a migration has no business making it. Leave
--                      both rows alone and record the pair for the dedup sweep.

CREATE TABLE IF NOT EXISTS identifier_normalisation_conflicts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  kind          text NOT NULL,
  canonical     text NOT NULL,
  entity_a      uuid NOT NULL,
  entity_b      uuid NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

COMMENT ON TABLE identifier_normalisation_conflicts IS
  'Entity pairs discovered during the identifier backfill: both sides hold the same identifier once canonicalised, so they are almost certainly the same person. Input for the dedup sweep — a migration must not merge entities on its own.';

DO $$
DECLARE
  r          record;
  canonical  text;
  owner_id   uuid;
  fixed      int := 0;
  retired    int := 0;
  conflicts  int := 0;
BEGIN
  FOR r IN
    SELECT id, workspace_id, entity_id, kind, value
      FROM entity_identifiers
     WHERE status = 'active'
       AND kind IN ('email', 'domain', 'linkedin_url', 'linkedin_member_id')
  LOOP
    canonical := normalise_identifier(r.kind, r.value);
    CONTINUE WHEN canonical IS NULL OR canonical = r.value;

    owner_id := NULL;
    SELECT entity_id INTO owner_id
      FROM entity_identifiers
     WHERE workspace_id = r.workspace_id AND kind = r.kind
       AND value = canonical AND status = 'active'
     LIMIT 1;

    IF owner_id IS NULL THEN
      UPDATE entity_identifiers SET value = canonical WHERE id = r.id;
      fixed := fixed + 1;
    ELSIF owner_id = r.entity_id THEN
      UPDATE entity_identifiers SET status = 'retired' WHERE id = r.id;
      retired := retired + 1;
    ELSE
      INSERT INTO identifier_normalisation_conflicts
             (workspace_id, kind, canonical, entity_a, entity_b)
      VALUES (r.workspace_id, r.kind, canonical, owner_id, r.entity_id);
      conflicts := conflicts + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'identifier backfill: % canonicalised, % retired as redundant, % cross-entity conflicts recorded',
    fixed, retired, conflicts;
END;
$$;
