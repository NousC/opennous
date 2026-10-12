-- Makes entity merges reversible going forward. mergeEntities records exactly which
-- rows it re-pointed (and a snapshot of the deleted v1 contacts row) here, so
-- unmergeEntities can put them back precisely. Merges done before this table existed
-- have no row and are not reversible (unmerge returns not_reversible). Idempotent.
create table if not exists public.entity_merge_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  keep_id uuid not null,   -- survivor
  drop_id uuid not null,   -- the tombstoned entity that was folded in
  payload jsonb not null,  -- moved row ids per table + relationship orig endpoints + contact snapshot
  unmerged_at timestamptz, -- set when reversed; a log row is used at most once
  created_at timestamptz not null default now()
);
create index if not exists entity_merge_log_drop_idx
  on public.entity_merge_log(workspace_id, drop_id) where unmerged_at is null;
create index if not exists entity_merge_log_keep_idx
  on public.entity_merge_log(workspace_id, keep_id) where unmerged_at is null;
