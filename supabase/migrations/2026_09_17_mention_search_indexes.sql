-- Typeahead searches three columns; only one of them was indexed (GET-316).
--
-- The mention menu matches a typed name against the person's name, their email and their
-- company's name. `entity_list_name_trgm` covered the first, so an OR across all three fell back
-- to scanning every row: 1,546ms on a large workspace, on a keystroke. With all three
-- indexed, Postgres can bitmap-OR them: 247ms.
--
-- CONCURRENTLY: this runs against a live table, and the point of the change is that people are
-- typing into the box it serves.
CREATE INDEX CONCURRENTLY IF NOT EXISTS entity_list_email_trgm
  ON public.entity_list_rows USING gin (email gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS entity_list_company_name_trgm
  ON public.entity_list_rows USING gin (company_name gin_trgm_ops);
