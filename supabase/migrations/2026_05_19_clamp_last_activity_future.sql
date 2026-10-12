-- Clamp last_activity_at so it can never be in the future.
--
-- Bug: future-dated activity rows (bad import / provider timestamp) propagated
-- straight into contacts.last_activity_at via the recompute trigger, which
-- then pinned them to the top of every "sort by last activity DESC" list.
--
-- Fix has two parts:
--   1) Replace trigger_recompute_pipeline_stage so it clamps to now() on write.
--   2) Backfill: any contact whose last_activity_at is in the future gets
--      re-derived from contact_activity_log (also clamped), or nulled if no
--      legitimate activity rows exist.

CREATE OR REPLACE FUNCTION trigger_recompute_pipeline_stage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_new_stage  TEXT;
  v_cur_stage  TEXT;
  v_cur_source TEXT;
  v_occurred   TIMESTAMPTZ := LEAST(NEW.occurred_at, now());
BEGIN
  IF NEW.activity_type IN ('airtable_imported','airtable_synced','airtable_pushed','contact_created') THEN
    RETURN NEW;
  END IF;

  SELECT pipeline_stage, pipeline_stage_source
  INTO v_cur_stage, v_cur_source
  FROM contacts WHERE id = NEW.contact_id;

  IF v_cur_stage = 'client' THEN
    RETURN NEW;
  END IF;

  v_new_stage := compute_contact_pipeline_stage(NEW.contact_id);

  IF v_cur_source = 'auto'
     OR (v_cur_source = 'manual' AND v_new_stage = 'client')
     OR (v_cur_source = 'manual' AND (
           (v_new_stage = 'evaluating' AND v_cur_stage IN ('identified','aware','interested'))
        OR (v_new_stage = 'interested' AND v_cur_stage IN ('identified','aware'))
        OR (v_new_stage = 'aware'      AND v_cur_stage = 'identified')
     ))
  THEN
    UPDATE contacts SET
      pipeline_stage            = v_new_stage,
      pipeline_stage_updated_at = now(),
      pipeline_stage_source     = 'auto',
      last_activity_at          = GREATEST(LEAST(COALESCE(last_activity_at, v_occurred), now()), v_occurred)
    WHERE id = NEW.contact_id;
  ELSE
    UPDATE contacts SET
      last_activity_at = GREATEST(LEAST(COALESCE(last_activity_at, v_occurred), now()), v_occurred)
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Backfill: re-derive last_activity_at from real activity log entries, clamped to now.
UPDATE contacts c SET last_activity_at = sub.max_at
FROM (
  SELECT contact_id, MAX(LEAST(occurred_at, now())) AS max_at
  FROM contact_activity_log
  WHERE activity_type NOT IN ('airtable_imported','airtable_synced','airtable_pushed','contact_created')
  GROUP BY contact_id
) sub
WHERE c.id = sub.contact_id
  AND c.last_activity_at IS NOT NULL
  AND c.last_activity_at > now();

-- For contacts with no real activity log rows at all, null out the bogus future value.
UPDATE contacts SET last_activity_at = NULL
WHERE last_activity_at IS NOT NULL
  AND last_activity_at > now();
