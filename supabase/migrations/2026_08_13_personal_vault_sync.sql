-- Layer B — continuous, safe, bi-directional GitHub sync for the personal vault.
--
-- Until now sync was manual (scan → click ingest) and push-on-save one way. This
-- adds (1) a per-source webhook so a `git push` to the connected repo flows into the
-- vault on its own, (2) a poll fallback for tokens that can't create a webhook, and
-- (3) conflict safety so an incoming change never silently clobbers a local edit.

alter table public.personal_workspaces
  -- Random path segment in the webhook callback URL — how a delivery finds its source.
  add column if not exists sync_token      text,
  -- The GitHub hook id (so we can delete it on disconnect) and its HMAC secret (so we
  -- can verify a delivery really came from GitHub). Null when the token couldn't
  -- create a hook — that source falls back to the poller.
  add column if not exists webhook_id      bigint,
  add column if not exists webhook_secret  text,
  -- Master switch for automatic inbound sync (webhook + poll). Push-on-save is
  -- unaffected. On by default when a source connects.
  add column if not exists auto_sync       boolean not null default true,
  -- How the last ingest was triggered: 'webhook' | 'poll' | 'manual'.
  add column if not exists last_synced_via text,
  -- When the poller last considered this source (its claim marker, so overlapping
  -- ticks don't double-ingest).
  add column if not exists last_polled_at  timestamptz;

create unique index if not exists personal_workspaces_sync_token_idx
  on public.personal_workspaces (sync_token) where sync_token is not null;

-- Conflict safety. When an incoming file changed in the repo AND the local copy has
-- unpushed edits, we do NOT overwrite the local content — we stash the incoming
-- remote version here and flip status to 'conflict' for the member to resolve
-- (keep mine → push local; take theirs → adopt remote). 'conflict' is already an
-- allowed status on personal_files.
alter table public.personal_files
  add column if not exists conflict_content text,
  add column if not exists conflict_sha     text;
