-- Phase 4 (Redesign Vault-focused): a claim's DERIVED visibility, separate from the evidence
-- it came from. Default null = inherit (visible exactly per the account dial — today's behavior).
-- 'shared' = an admin has explicitly promoted this extracted fact to the whole workspace, so it
-- is readable team-wide EVEN when the account is owner-scoped — WITHOUT exposing the raw behind
-- it (rawVisible is untouched; only the claim value travels). Layers ON TOP of
-- open_account_visibility, never broadens raw, never narrows below the account dial.
alter table public.claims
  add column if not exists derived_visibility text
    check (derived_visibility is null or derived_visibility in ('inherit','shared'));

-- Index the promoted set — the shared-claims surface reads exactly these.
create index if not exists claims_shared_idx
  on public.claims (workspace_id) where derived_visibility = 'shared';

comment on column public.claims.derived_visibility is 'null/inherit = visible per the account dial (default). shared = admin-promoted, readable workspace-wide without exposing the supporting raw.';
