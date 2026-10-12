-- Member onboarding parity: a CLI join token can carry a department, so a member who
-- runs `nous join <token>` is auto-assigned to it (the web invite path already does this
-- via team_invitations.department_id). approveJoin applies it to the workspace_members row.
alter table public.team_join_tokens
  add column if not exists department_id uuid references public.company_departments(id) on delete set null;
