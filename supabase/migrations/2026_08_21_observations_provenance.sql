-- Phase 0 provenance (Redesign Vault-focused roadmap): make every observation traceable to
-- a verifiable source. Additive + dual-write — `raw` stays exactly as-is, nothing breaks.
--   source_ref   — a pointer/URI to where the raw lives (source://<source>/<external_id>, a
--                  vault file path, or a git sha). resolveRaw() follows it on demand.
--   content_hash — sha256 of the raw we stored, so a fetched raw can be verified untampered.
-- This is the groundwork for the eventual edge cutover (raw at the customer, Nous keeps the
-- pointer). We do NOT remove any blob here.
alter table public.observations add column if not exists source_ref  text;
alter table public.observations add column if not exists content_hash text;

-- Look up raw by its pointer (resolveRaw): source_ref is derived from (source, external_id),
-- both already covered by observations_dedup, but index source_ref for direct pointer lookups.
create index if not exists observations_source_ref_idx
  on public.observations (workspace_id, source_ref)
  where source_ref is not null;

comment on column public.observations.source_ref  is 'Verifiable pointer to the raw source (source://<source>/<external_id>, vault path, or git sha). Followed by resolveRaw().';
comment on column public.observations.content_hash is 'sha256 of the stored raw payload — lets a resolved raw be verified untampered.';
