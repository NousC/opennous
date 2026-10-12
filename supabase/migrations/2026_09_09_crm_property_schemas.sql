-- Each connected CRM's property schema, per object type, refreshed on every sync.
--
-- Why: HubSpot returns only the properties you name in a request, so "what fields does
-- this portal actually have" (custom properties above all) has to be discovered and kept,
-- not assumed. This is also what makes write-back safe: a value is validated against the
-- field's declared type and allowed options before it is ever sent.
--
-- Safe to run more than once: every statement is guarded, so re-running is a no-op rather
-- than a "constraint already exists" error.

CREATE TABLE IF NOT EXISTS public.crm_property_schemas (
    id            uuid        DEFAULT gen_random_uuid() NOT NULL,
    workspace_id  uuid        NOT NULL,
    provider      text        NOT NULL,
    object_type   text        NOT NULL,
    properties    jsonb       DEFAULT '[]'::jsonb NOT NULL,
    custom_count  integer     DEFAULT 0 NOT NULL,
    fetched_at    timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_property_schemas_pkey') THEN
    ALTER TABLE ONLY public.crm_property_schemas
      ADD CONSTRAINT crm_property_schemas_pkey PRIMARY KEY (id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_property_schemas_ws_provider_object_unique') THEN
    ALTER TABLE ONLY public.crm_property_schemas
      ADD CONSTRAINT crm_property_schemas_ws_provider_object_unique UNIQUE (workspace_id, provider, object_type);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_property_schemas_workspace_id_fkey') THEN
    ALTER TABLE ONLY public.crm_property_schemas
      ADD CONSTRAINT crm_property_schemas_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_property_schemas_ws ON public.crm_property_schemas USING btree (workspace_id, provider);
