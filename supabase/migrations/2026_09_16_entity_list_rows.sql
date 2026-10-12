-- What a LIST needs, stored (GET-296). Applied to prod 2026-09-16.
--
-- Accounts and people are assembled per request from facts: a name is a claim, a domain an
-- identifier, "last activity" an aggregate over every observation of every person at the account.
-- The right shape for truth, the wrong shape for a list — on a large workspace the
-- page broke three ways in one evening: silently capped at a thousand rows, then a timeout on an
-- ORDER BY, then a timeout on one column.
--
-- The facts stay the source of truth; this stands beside them. One row per account and per person
-- holding exactly what a list shows, rebuilt by refresh_entity_list_rows() rather than recomputed
-- on every page load. Measured: 200 accounts ordered by last activity in 1.5ms, against a timeout.
CREATE TABLE IF NOT EXISTS public.entity_list_rows (
    workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    entity_id        uuid NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('account', 'person')),
    name             text,
    domain           text,
    email            text,
    job_title        text,
    industry         text,
    company_id       uuid,
    company_name     text,
    stage            text,
    icp_score        integer,
    deal_health      integer,
    people_count     integer NOT NULL DEFAULT 0,
    open_deals       integer NOT NULL DEFAULT 0,
    pipeline_value   numeric,
    won_value        numeric,
    last_activity_at timestamptz,
    refreshed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, entity_id)
);

CREATE INDEX IF NOT EXISTS entity_list_accounts_activity
  ON public.entity_list_rows (workspace_id, last_activity_at DESC NULLS LAST) WHERE kind = 'account';
CREATE INDEX IF NOT EXISTS entity_list_people_activity
  ON public.entity_list_rows (workspace_id, last_activity_at DESC NULLS LAST) WHERE kind = 'person';
CREATE INDEX IF NOT EXISTS entity_list_company
  ON public.entity_list_rows (workspace_id, company_id) WHERE kind = 'person';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS entity_list_name_trgm
  ON public.entity_list_rows USING gin (name gin_trgm_ops);

ALTER TABLE public.entity_list_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entity_list_rows FROM anon, authenticated;

-- Two indexes the `contacts` view needs whatever reads it: it asks "was this person added by
-- hand?" and "has this person any interaction?" on every read, and answered both with a scan of
-- the whole observations table (GET-294).
CREATE INDEX IF NOT EXISTS observations_manual_source
  ON public.observations (workspace_id, entity_id) WHERE source = 'manual';
CREATE INDEX IF NOT EXISTS observations_event_property_entity
  ON public.observations (property, entity_id) WHERE kind = 'event';

-- The rebuild itself lives in 2026_09_16_refresh_entity_list_rows.sql (a function, kept separate
-- so it can be replaced without touching the table).

-- 2026-09-16, later: our own company is not an account (GET-298). A client's CRM holds their own
-- domain as a company and their staff as contacts; imported blind, the workspace lists its owner
-- as a prospect with a few dozen people. refresh_entity_list_rows now excludes anything team recognition
-- has flagged internal, anything on the workspace's own website domain, and the people who work
-- there. See 2026_09_16_refresh_entity_list_rows.sql for the function.
