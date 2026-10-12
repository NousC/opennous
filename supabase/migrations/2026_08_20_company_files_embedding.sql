-- Step #1 — make the company vault READABLE by agents, permission-filtered.
--
-- Give each company file an embedding in the same 1536-dim space the rest of the
-- substrate uses, plus a search RPC that applies the ACL in ONE place: effective
-- agents_can_read (file override, else folder policy, else true) must be true, and
-- admins-only docs surface only to an admin-scoped caller. Mirrors
-- search_personal_files, but shared per workspace with the folder-inherited ACL.

alter table public.company_files
  add column if not exists embedding public.vector(1536);

create or replace function public.search_company_files(
  p_workspace_id uuid,
  p_embedding    public.vector,
  p_admin        boolean          default false,
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
             -- Effective ACL: the file's own override, else the folder policy, else the default.
             coalesce(f.agents_can_read, p.agents_can_read, true)      as eff_agents,
             coalesce(f.visibility,      p.visibility,      'company')  as eff_visibility
      from public.company_files f
      left join public.company_folder_policy p
        on p.workspace_id = f.workspace_id and p.folder = f.folder
      where f.workspace_id = p_workspace_id
        and f.embedding is not null
        and f.status = 'live'
      order by f.embedding <=> v
      limit greatest(p_limit * 4, 32)   -- over-fetch before the ACL cut, then trim below
    ) t
    where t.similarity >= p_threshold
      and t.eff_agents = true                              -- agents may read this doc
      and (t.eff_visibility = 'company' or p_admin)        -- admins-only → admin callers only
    order by t.similarity desc
    limit p_limit;
  end $$;

comment on function public.search_company_files is
  'Semantic search over the shared company vault, ACL-filtered in one place: effective agents_can_read (file override, else folder policy, else true) must be true; admins-only docs surface only when p_admin. Used by search_company_knowledge.';
