-- Departments — the company access model. The founder defines departments and assigns
-- each member to one (members can't change their own). A company-vault folder can be
-- scoped to specific departments; a member sees the folder only if their department is
-- allowed (or it's company-wide, or they're an admin). Files inherit the folder.
create table if not exists public.company_departments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists company_departments_ws_name_idx on public.company_departments (workspace_id, lower(name));
alter table public.company_departments enable row level security;

-- Each member belongs to at most one department (founder-assigned; on department delete
-- the member is simply unassigned).
alter table public.workspace_members add column if not exists department_id uuid references public.company_departments(id) on delete set null;

-- Folder ACL gains a 'departments' audience + the list of allowed departments.
alter table public.company_folder_policy drop constraint if exists company_folder_policy_visibility_check;
alter table public.company_folder_policy add constraint company_folder_policy_visibility_check check (visibility in ('company','departments','admins'));
alter table public.company_folder_policy add column if not exists department_ids uuid[] not null default '{}';

-- Allow 'departments' on the (rarely used) per-file override too, for consistency.
alter table public.company_files drop constraint if exists company_files_visibility_check;
alter table public.company_files add constraint company_files_visibility_check check (visibility is null or visibility in ('company','departments','admins'));
