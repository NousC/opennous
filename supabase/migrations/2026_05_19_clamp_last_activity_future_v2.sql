-- Follow-up to 2026_05_19_clamp_last_activity_future.sql.
--
-- v1 clamped future-dated source data to now() on write, which had the
-- unintended side effect of pinning previously-poisoned contacts to the very
-- top of the People list (since their backfilled value was literally
-- "right now", later than every other contact's real today-activity).
--
-- Correct behavior: future-dated activity is not real engagement and should
-- be ignored entirely, not clamped. This migration:
--   1) Replaces the trigger to skip rows with occurred_at > now().
--   2) Re-derives last_activity_at from the most recent past-or-present
--      activity row, nulling contacts whose only activity is future-dated.

CREATE OR REPLACE FUNCTION trigger_recompute_pipeline_stage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_new_stage  TEXT;
  v_cur_stage  TEXT;
  v_cur_source TEXT;
BEGIN
  IF NEW.activity_type IN ('airtable_imported','airtable_synced','airtable_pushed','contact_created') THEN
    RETURN NEW;
  END IF;

  IF NEW.occurred_at > now() THEN
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
      last_activity_at          = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.contact_id;
  ELSE
    UPDATE contacts SET
      last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-backfill: targets contacts that v1 clamped to ~now() (anything within the
-- last 10 minutes), since those are the artifacts of the previous migration.
-- Re-derive last_activity_at from the most recent NON-future activity row.
UPDATE contacts c SET last_activity_at = sub.max_at
FROM (
  SELECT contact_id, MAX(occurred_at) FILTER (WHERE occurred_at <= now()) AS max_at
  FROM contact_activity_log
  WHERE activity_type NOT IN ('airtable_imported','airtable_synced','airtable_pushed','contact_created')
  GROUP BY contact_id
) sub
WHERE c.id = sub.contact_id
  AND c.last_activity_at IS NOT NULL
  AND c.last_activity_at >= now() - interval '10 minutes';

-- Anything still sitting at ~now() has no legitimate (past) activity → null it.
UPDATE contacts SET last_activity_at = NULL
WHERE last_activity_at IS NOT NULL
  AND last_activity_at >= now() - interval '10 minutes';
