-- Layer A — make the personal vault READABLE by the agent.
--
-- Until now the vault was write-only from the agent's point of view: it could
-- propose a file (propose_vault_file) but never read what a member had filed in
-- thoughts / decisions / projects / company / content. This migration gives each
-- vault file an embedding in the same 1536-dim OpenAI space the rest of the
-- substrate uses (claims, observations), plus a search RPC scoped to ONE member's
-- private vault — so the agent can retrieve a member's own prior thinking before it
-- answers from generic knowledge, without ever crossing into another member's files.

alter table public.personal_files
  add column if not exists embedding public.vector(1536);

-- Semantic search over a single member's vault. Scoped by (workspace_id, user_id)
-- in the WHERE so private files never leak into another member's search — the same
-- reason the table is RLS-locked to the service role. Optional single-folder filter.
-- Mirrors search_claims: cheap candidate pre-filter, cosine sort, threshold cut.
-- Unapproved agent proposals (inbox_pending) are excluded — the agent must not
-- retrieve a draft it itself just proposed as if it were established fact.
create or replace function public.search_personal_files(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_embedding    public.vector,
  p_threshold    double precision default 0.2,
  p_limit        integer          default 8,
  p_folder       text             default null
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
             (1 - (f.embedding <=> v))::float as similarity
      from public.personal_files f
      where f.workspace_id = p_workspace_id
        and f.user_id = p_user_id
        and f.embedding is not null
        and f.status <> 'inbox_pending'
        and (p_folder is null or f.folder = p_folder)
      order by f.embedding <=> v
      limit p_limit
    ) t
    where t.similarity >= p_threshold
    order by t.similarity desc;
  end $$;

comment on function public.search_personal_files is
  'Semantic search over one member''s private personal vault (Layer A). Scoped by (workspace_id, user_id); excludes unapproved inbox proposals.';
