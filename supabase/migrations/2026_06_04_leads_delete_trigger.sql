-- Leads view DELETE handler — powers "delete selected" in the Lists page.
-- Idempotent and safe to re-run on existing tables. Requires `leads` to be the
-- v2 VIEW (INSTEAD OF triggers only attach to views). Deleting a lead row
-- removes only its collection (list) membership; the underlying entity and its
-- engagement history are never hard-deleted, per the v2 rule.

-- Sanity check first (expect: VIEW). If this returns BASE TABLE, do NOT run the
-- rest — on a v1 table, deletes already work natively.
--   SELECT table_type FROM information_schema.tables WHERE table_name = 'leads';

CREATE OR REPLACE FUNCTION leads_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.lead_list_id IS NOT NULL THEN
    DELETE FROM collection_entities
      WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS leads_delete_trigger ON leads;
CREATE TRIGGER leads_delete_trigger INSTEAD OF DELETE ON leads
FOR EACH ROW EXECUTE FUNCTION leads_delete_handler();
