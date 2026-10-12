-- Phase 2 of the personal workspace: GitHub sync. The member's fine-grained PAT,
-- encrypted at rest (AES-256-GCM via providers/crypto.mjs, same as provider creds).
-- Only the API (service role) ever reads it; it is never returned to the client.
alter table public.personal_workspaces
  add column if not exists github_token_enc text;

comment on column public.personal_workspaces.github_token_enc is
  'Encrypted GitHub fine-grained PAT (Contents: read/write on one repo). Never sent to the client.';
