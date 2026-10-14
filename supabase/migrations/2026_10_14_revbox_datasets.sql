-- RevBox datasets (GET-874): a table a box's jobs keep. A job's `dataset_append` step adds one row per
-- run (e.g. one per deal won or lost, analysed against the box's ICP), and a later job's `dataset_read`
-- step reads a window of rows back (the monthly win/loss report). The Results tab shows each dataset
-- as a table. Runs after 2026_10_14_revboxes.sql (it needs revboxes(id, workspace_id)) and
-- 2026_10_14_revbox_job_builder.sql. One transaction: it applies whole or not at all. Service role
-- only, like every revbox table: access is the box's, checked by the server on every read and write.
BEGIN;

-- One dataset per (box, key). `columns` is the ordered schema the rows follow:
-- [{ key, label, type: text|number|date|boolean|enum, options? }], at most 30 (checked by the server;
-- the database caps its size). Deleting the box deletes its datasets and their rows.
CREATE TABLE public.revbox_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  revbox_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  columns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) <= 30 AND octet_length(columns::text) <= 65536),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revbox_id, key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX revbox_datasets_box ON public.revbox_datasets(workspace_id, revbox_id);

-- One row. `entity_id` is the account or deal the row is about (null for none): a viewer who cannot
-- see that account does not see the row. `source_run_id` / `source_job_id` are the routine run and
-- routine that wrote it (no FK: a deleted run or job keeps its rows). `dedupe_key` (e.g.
-- "deal:<id>:closed_won") makes a re-run a no-op; a plain UNIQUE treats NULLs as distinct, so rows
-- without a key never collide.
CREATE TABLE public.revbox_dataset_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 32768),
  entity_id uuid,
  source_run_id uuid,
  source_job_id uuid,
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, dedupe_key),
  FOREIGN KEY (dataset_id, workspace_id) REFERENCES public.revbox_datasets(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX revbox_dataset_rows_recent ON public.revbox_dataset_rows(dataset_id, created_at DESC, id DESC);
CREATE INDEX revbox_dataset_rows_entity ON public.revbox_dataset_rows(workspace_id, entity_id) WHERE entity_id IS NOT NULL;

ALTER TABLE public.revbox_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_dataset_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_datasets, public.revbox_dataset_rows FROM anon, authenticated;
GRANT ALL ON public.revbox_datasets, public.revbox_dataset_rows TO service_role;

COMMIT;
