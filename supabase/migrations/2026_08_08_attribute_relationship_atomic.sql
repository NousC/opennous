-- Fix: attributing a touch to an account was a read-modify-write on the
-- relationship_owner JSON claim (getClaim -> mutate members[] in JS -> assertClaims
-- with the whole blob). Two touches on the SAME account arriving together — the
-- Gmail poller and a LinkedIn webhook fire on the same contact constantly — both
-- read the same members[], both write their own version back, and the second write
-- clobbers the first. A rep gets silently dropped from members[], LOSING read access
-- to an account they are actively working.
--
-- Fix: do the whole merge atomically in the database. A transaction-scoped advisory
-- lock keyed on (workspace, entity, relationship_owner) serialises concurrent
-- attributions to the same account, so the read-merge-write can't interleave. The
-- access-grant audit row is written in the same transaction (previously a
-- fire-and-forget insert that could be lost).
--
-- Semantics preserved exactly from relationshipOwner.ts::attributeRelationship:
--   * a member already present has touches +1 and last_touch = max(existing, at);
--     an absent member is appended with touches = 1
--   * label follows opts.label ?? existing ?? null
--   * primary = most-recent toucher, ties keep the earlier member (strict >)
--   * a manual `assigned` owner is preserved untouched
--   * timestamps are stored in JS toISOString() shape (…​.MSZ) so lexical ordering
--     stays consistent with rows written by the old TS path
--
-- Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.attribute_relationship(
  p_workspace uuid,
  p_entity    uuid,
  p_user      uuid,
  p_at        timestamptz,
  p_label     text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_val        jsonb;
  v_members    jsonb := '[]'::jsonb;
  v_new        jsonb := '[]'::jsonb;
  v_elem       jsonb;
  v_found      boolean := false;
  v_assigned   jsonb;
  v_primary    text;
  v_best_touch text;
  v_touch      text;
  -- Match JavaScript's Date.toISOString(): millisecond precision, trailing 'Z'.
  v_at_text    text := to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;

  -- Serialise concurrent attributions to THIS account's relationship claim.
  -- Scoped to the exact (workspace, entity); released at transaction end.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace::text || ':' || p_entity::text || ':relationship_owner', 0));

  SELECT value INTO v_val
    FROM public.claims
   WHERE workspace_id = p_workspace
     AND entity_id    = p_entity
     AND property     = 'relationship_owner'
     AND invalid_at IS NULL;

  v_members  := COALESCE(v_val->'members', '[]'::jsonb);
  v_assigned := v_val->'assigned';

  -- Rebuild members, bumping the caller's row in place if it already exists.
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_members) LOOP
    IF (v_elem->>'user_id') = p_user::text THEN
      v_found := true;
      v_touch := v_elem->>'last_touch';
      IF v_touch IS NULL OR v_at_text > v_touch THEN v_touch := v_at_text; END IF;
      v_elem := jsonb_build_object(
        'user_id',    p_user::text,
        'label',      CASE WHEN p_label IS NOT NULL THEN to_jsonb(p_label)
                           ELSE COALESCE(v_elem->'label', 'null'::jsonb) END,
        'last_touch', v_touch,
        'touches',    COALESCE((v_elem->>'touches')::int, 0) + 1
      );
    END IF;
    v_new := v_new || v_elem;
  END LOOP;

  IF NOT v_found THEN
    v_new := v_new || jsonb_build_object(
      'user_id',    p_user::text,
      'label',      to_jsonb(p_label),   -- JSON null when no label, matching the TS path
      'last_touch', v_at_text,
      'touches',    1
    );
  END IF;

  -- primary = most recent toucher; strict '>' keeps the earlier member on a tie,
  -- matching the TS reduce().
  v_best_touch := NULL;
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    v_touch := COALESCE(v_elem->>'last_touch', '');
    IF v_best_touch IS NULL OR v_touch > v_best_touch THEN
      v_best_touch := v_touch;
      v_primary    := v_elem->>'user_id';
    END IF;
  END LOOP;

  v_val := jsonb_build_object('primary', v_primary, 'members', v_new);
  IF v_assigned IS NOT NULL AND v_assigned <> 'null'::jsonb THEN
    v_val := v_val || jsonb_build_object('assigned', v_assigned);
  END IF;

  -- Upsert the asserted claim (one row per (workspace, entity, property)).
  INSERT INTO public.claims (
    workspace_id, entity_id, property, value, distribution, confidence,
    epistemic_class, freshness, valid_from, invalid_at,
    supporting_observation_ids, observation_count, last_observed_at, computed_at
  ) VALUES (
    p_workspace, p_entity, 'relationship_owner', v_val, NULL, 1.0,
    'asserted', 'fresh', now(), NULL,
    '{}'::uuid[], 0, NULL, now()
  )
  ON CONFLICT (workspace_id, entity_id, property) DO UPDATE
    SET value           = EXCLUDED.value,
        epistemic_class = 'asserted',
        confidence      = 1.0,
        freshness       = 'fresh',
        invalid_at      = NULL,
        computed_at     = now();

  -- Provenance: the first time a member is attributed they GAINED access. Written
  -- in-transaction so the grant and the access can never diverge.
  IF NOT v_found THEN
    INSERT INTO public.audit_log (action, actor_user_id, target_type, target_id, target_workspace_id, metadata)
    VALUES ('access.granted', NULL, 'account', p_entity::text, p_workspace,
            jsonb_build_object('member_user_id', p_user::text, 'via', 'co-attendance',
                               'label', to_jsonb(p_label)));
  END IF;
END;
$$;

-- Server calls this via the service-role client.
GRANT EXECUTE ON FUNCTION public.attribute_relationship(uuid, uuid, uuid, timestamptz, text) TO service_role;
