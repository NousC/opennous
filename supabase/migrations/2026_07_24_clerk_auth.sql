-- Move user authentication from Supabase Auth to Clerk — PART 1 (safe to apply
-- ahead of the code deploy).
--
-- Nothing about the app's own identity model changes: every app table still keys
-- off the internal `public.users.id` (uuid), and the backend still talks to
-- Postgres via the service-role client. What changes is the *external* auth id we
-- store on `users`.
--
-- Every statement here is backward-compatible with the currently-deployed
-- Supabase-Auth code: it keeps writing `supabase_user_id` (still present, just
-- nullable now) and ignores the new column. That's why this half can go in early
-- — and once it's in, the user-import backfill can populate `clerk_user_id`
-- before cutover. The one BREAKING change (repointing playground_threads off
-- auth.users) lives in PART 2, which deploys together with the code.
--
-- Clerk ids look like `user_2ab...`, not uuids, so `clerk_user_id` is text.
-- `supabase_user_id` is kept (nullable, FK dropped) so the import script can map
-- Clerk ids back to existing rows by it; drop it in a later migration once every
-- row has a clerk_user_id.
--
-- Dormant `auth.uid()` RLS policies are intentionally left untouched: all backend
-- access is service-role (bypasses RLS), so they never fire, and `auth.uid()`
-- still resolves as a function since Supabase remains the Postgres host.

BEGIN;

-- Clerk id column -----------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS clerk_user_id text;

-- Unique, but only over populated values so existing rows (null until backfilled
-- by the import) don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_user_id_key
  ON public.users (clerk_user_id)
  WHERE clerk_user_id IS NOT NULL;

-- Cut the tie to auth.users -------------------------------------------------
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_supabase_user_id_fkey;

-- New Clerk users have no auth.users row → supabase_user_id must be optional.
ALTER TABLE public.users
  ALTER COLUMN supabase_user_id DROP NOT NULL;

COMMIT;
