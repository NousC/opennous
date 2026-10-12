-- Per-workspace ICP dial model, edited as YAML in Settings -> ICP and read by the
-- deterministic scorer (scoreDials). Stored verbatim (WYSIWYG): the YAML the operator
-- edits IS the model. Falls back to the repo default (config/icp-model.json) when absent.
-- Deliberately separate from scorecard_signals (the old prose-compiled model).
create table if not exists public.workspace_icp_model (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  yaml         text not null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

comment on table public.workspace_icp_model is
  'Per-workspace ICP scoring dials as YAML (base + personas + firmographics + signals + disqualifiers). Read by scoreDials; edited in Settings > ICP.';
