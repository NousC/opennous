-- Documents: what the agent writes for you, as first-class objects (GET-197).
--
-- A brief, an account plan, a revenue report used to be a `claims` row with property
-- `note.<uuid>` and the document stuffed into `value.metadata`. That shape could hold the
-- words and nothing about them: one entity per document, no period, no versions, no links
-- to other documents, and a source list that lived beside the text rather than under it.
-- `/api/docs` then had to read 400 note rows (transcripts included) to find fourteen
-- documents, and an agent could not list them, cite them, or open one by a citation.
--
-- Four tables, one job each:
--
--   documents          the document itself, with what a reader and an agent file it by —
--                      its kind, what it is about, the period it covers, who wrote it with
--                      which skill, and the version it replaces.
--   document_sources   its evidence, one row per source, snapshotted at write time with the
--                      cite token the text carries. A reopened document resolves its [ct7k2]
--                      markers from here, so a citation works a month later exactly as it did
--                      in the turn that wrote it.
--   document_links     typed edges: about / mentions an account or person, links_to or
--                      supersedes another document. Backlinks are this table read the other
--                      way round, never stored twice.
--   document_chunks    one row per section (long sections split), each embedded and indexed
--                      for full text, so search returns the PASSAGE that matched rather than
--                      the first eight thousand characters of the document.
--
-- Additive: no existing table is altered. The old note rows are copied by
-- `scripts/backfill-documents.mjs`, which is a separate, reversible step.
--
-- RLS on with no policy, like every service-role table here: the API is the only reader.

create table if not exists public.documents (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,

  -- What it is. `series` is which recurring document it belongs to (a pipeline report, a
  -- win/loss read), so September's monthly pipeline report and August's sit together.
  kind               text not null check (kind in ('brief', 'plan', 'report', 'meeting_brief', 'objection_prep')),
  series             text,
  -- Derived from the period once, at write time, by `documentCadence` — the folder a report
  -- lives in is a fact about the document, not something each reader re-derives.
  cadence            text check (cadence in ('weekly', 'monthly', 'quarterly', 'one_off')),

  title              text not null,
  headline           text,
  -- The document as the renderer draws it: [{label, body?, blocks?}].
  sections           jsonb not null default '[]'::jsonb,
  -- The same document as plain markdown, blocks included (a chart is written out as its
  -- rows). What an agent reads and what full-text search indexes.
  body_md            text not null default '',
  word_count         integer not null default 0,
  content_hash       text,

  -- The account or person it is about. Null for a report across the whole book.
  subject_entity_id  uuid references public.entities(id) on delete set null,
  period_start       timestamptz,
  period_end         timestamptz,
  generated_from     text[] not null default '{}',

  -- Who asked for it and how it was made.
  author_user_id     uuid,
  skill              text,
  thread_id          uuid,
  written_by         text not null default 'web_agent',   -- web_agent | routine | plugin | backfill

  -- Read-only documents still have a life: a new brief on the same account replaces the old
  -- one, and a person can delete one. Neither destroys it.
  status             text not null default 'live' check (status in ('live', 'superseded', 'deleted')),
  supersedes_id      uuid references public.documents(id) on delete set null,
  version            integer not null default 1,

  -- The note row this was copied from, so the backfill is idempotent and reversible.
  legacy_claim_id    uuid unique,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists documents_live_idx
  on public.documents (workspace_id, created_at desc) where status = 'live';
create index if not exists documents_subject_idx
  on public.documents (workspace_id, subject_entity_id) where status <> 'deleted';
create index if not exists documents_series_idx
  on public.documents (workspace_id, kind, series, period_end desc) where status <> 'deleted';
alter table public.documents enable row level security;

create table if not exists public.document_sources (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  document_id     uuid not null references public.documents(id) on delete cascade,
  -- First-seen order across the turn, which is the order the document was written against.
  ordinal         integer not null,
  -- `citeKey(ref)` — the token in the text. Stored, not recomputed, so a change to the hash
  -- can never orphan an old document's markers.
  cite_key        text,
  ref             text not null,
  system          text not null,
  detail          text,
  occurred_at     timestamptz,
  quote           text,
  speaker         text,
  evidence_kind   text,
  derived         boolean not null default false,
  -- Whether the text actually points at it. A turn reads more than a document cites; the
  -- panel shows what was cited first and keeps the rest as "also consulted".
  cited           boolean not null default false,
  -- Which sections cite it, by index — so the panel can say where a source is used.
  section_indexes integer[] not null default '{}',
  unique (document_id, ref)
);

create index if not exists document_sources_doc_idx on public.document_sources (document_id, ordinal);
create index if not exists document_sources_ref_idx on public.document_sources (workspace_id, ref);
alter table public.document_sources enable row level security;

create table if not exists public.document_links (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  document_id         uuid not null references public.documents(id) on delete cascade,
  kind                text not null check (kind in ('about', 'mentions', 'links_to', 'supersedes')),
  target_entity_id    uuid references public.entities(id) on delete cascade,
  target_document_id  uuid references public.documents(id) on delete cascade,
  section_index       integer,
  created_at          timestamptz not null default now(),
  -- An edge points at exactly one thing. Two nullable targets with nothing forcing that is
  -- how a link ends up pointing at both, or at neither.
  constraint document_links_one_target check (
    (target_entity_id is not null)::int + (target_document_id is not null)::int = 1
  )
);

create unique index if not exists document_links_unique_entity
  on public.document_links (document_id, kind, target_entity_id) where target_entity_id is not null;
create unique index if not exists document_links_unique_document
  on public.document_links (document_id, kind, target_document_id) where target_document_id is not null;
-- Backlinks: "which documents point at this account / this document".
create index if not exists document_links_entity_idx
  on public.document_links (workspace_id, target_entity_id) where target_entity_id is not null;
create index if not exists document_links_document_idx
  on public.document_links (workspace_id, target_document_id) where target_document_id is not null;
alter table public.document_links enable row level security;

create table if not exists public.document_chunks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  document_id    uuid not null references public.documents(id) on delete cascade,
  chunk_index    integer not null,
  section_index  integer not null,
  heading        text,
  content        text not null,
  content_tsv    tsvector generated always as (
    to_tsvector('english', coalesce(heading, '') || ' ' || coalesce(content, ''))
  ) stored,
  embedding      vector(1536),
  unique (document_id, chunk_index)
);

create index if not exists document_chunks_doc_idx on public.document_chunks (document_id);
create index if not exists document_chunks_tsv_idx on public.document_chunks using gin (content_tsv);
alter table public.document_chunks enable row level security;

-- Semantic passage search over live documents. Returns chunks, not documents: the caller
-- fuses these with the full-text hits and keeps the best passage per document.
create or replace function public.search_document_chunks(
  p_workspace_id uuid,
  p_embedding    vector,
  p_limit        integer default 20,
  p_threshold    double precision default 0.2
) returns table (
  chunk_id uuid, document_id uuid, section_index integer, heading text, content text, similarity double precision
)
language sql stable
as $$
  select c.id, c.document_id, c.section_index, c.heading, c.content,
         1 - (c.embedding <=> p_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.workspace_id = p_workspace_id
    and d.status = 'live'
    and c.embedding is not null
    and 1 - (c.embedding <=> p_embedding) >= p_threshold
  order by c.embedding <=> p_embedding
  limit p_limit;
$$;

-- Full-text passage search, same shape, so the two fuse without translation.
create or replace function public.search_document_chunks_fts(
  p_workspace_id uuid,
  p_query        text,
  p_limit        integer default 20
) returns table (
  chunk_id uuid, document_id uuid, section_index integer, heading text, content text, rank real
)
language sql stable
as $$
  select c.id, c.document_id, c.section_index, c.heading, c.content,
         ts_rank(c.content_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.workspace_id = p_workspace_id
    and d.status = 'live'
    and c.content_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit p_limit;
$$;
