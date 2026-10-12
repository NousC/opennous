-- Finish the company access model: individual-person folder ACLs, and department
-- auto-assign on join.
--
-- (1) A restricted ('departments') folder may now name specific PEOPLE in addition to
--     departments — the allow-list is department_ids OR member_ids. This covers the
--     "share this one folder with Lena Quist and the Sales team" case a pure department
--     model can't.
-- (2) An invitation may carry a department, so a member lands in the right team the
--     moment they accept — no manual assignment step after onboarding.

-- (1) Folder ACL gains a per-person allow-list, alongside department_ids.
alter table public.company_folder_policy
  add column if not exists member_ids uuid[] not null default '{}';

-- (2) An invitation can pre-assign a department. On accept, the member's
-- workspace_members row for that department's workspace inherits it. Department is
-- per-workspace, so on department delete we simply forget the assignment.
alter table public.team_invitations
  add column if not exists department_id uuid references public.company_departments(id) on delete set null;

-- Agent-read RPC: surface a departments-scoped doc when the acting member is on the
-- folder's department allow-list OR its person allow-list. Extends the live function
-- (which already honoured p_department) with p_member_id + the member_ids check, in
-- the same single place the rest of the ACL lives.
--
-- Adding a parameter makes a NEW overload rather than replacing, so drop the prior
-- signatures first (the original 5-arg and the department-aware 6-arg) to keep the
-- name unambiguous for PostgREST's named-argument resolution.
drop function if exists public.search_company_files(uuid, public.vector, boolean, double precision, integer);
drop function if exists public.search_company_files(uuid, public.vector, boolean, uuid, double precision, integer);

create or replace function public.search_company_files(
  p_workspace_id uuid,
  p_embedding    public.vector,
  p_admin        boolean          default false,
  p_department   uuid             default null,
  p_member_id    uuid             default null,
  p_threshold    double precision default 0.2,
  p_limit        integer          default 8
) returns table(
  id uuid, folder text, subfolder text, name text, content text, similarity double precision
)
  language plpgsql stable
  as $$
  declare v vector(1536) := p_embedding;
  begin
    return query
    select t.id, t.folder, t.subfolder, t.name, t.content, t.similarity
    from (
      select f.id, f.folder, f.subfolder, f.name, f.content,
             (1 - (f.embedding <=> v))::float as similarity,
             coalesce(f.agents_can_read, p.agents_can_read, true)      as eff_agents,
             coalesce(f.visibility,      p.visibility,      'company')  as eff_visibility,
             coalesce(p.department_ids,  '{}')                          as eff_departments,
             coalesce(p.member_ids,      '{}')                          as eff_members
      from public.company_files f
      left join public.company_folder_policy p
        on p.workspace_id = f.workspace_id and p.folder = f.folder
      where f.workspace_id = p_workspace_id
        and f.embedding is not null
        and f.status = 'live'
      order by f.embedding <=> v
      limit greatest(p_limit * 4, 32)
    ) t
    where t.similarity >= p_threshold
      and t.eff_agents = true
      and (
        t.eff_visibility = 'company'
        or p_admin
        or (t.eff_visibility = 'departments' and (
              (p_department is not null and p_department = any(t.eff_departments))
              or (p_member_id is not null and p_member_id = any(t.eff_members))
           ))
      )
    order by t.similarity desc
    limit p_limit;
  end $$;

comment on function public.search_company_files is
  'Semantic search over the shared company vault, ACL-filtered in one place: effective agents_can_read must be true; admins-only docs surface only when p_admin; a departments-scoped doc surfaces when the acting member is on the folder department allow-list (p_department) OR its person allow-list (p_member_id).';
