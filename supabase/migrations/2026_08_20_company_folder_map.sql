-- Company vault sync becomes folder-mapped (identical to the personal vault sync):
-- the founder maps each company folder (knowledge/policies/playbooks/decisions) to a
-- repo path, then scans + ingests. Add the folder_map the mapping step writes.
alter table public.company_workspaces
  add column if not exists folder_map jsonb not null default '{}'::jsonb;
