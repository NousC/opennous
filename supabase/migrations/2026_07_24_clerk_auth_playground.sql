-- Move user authentication from Supabase Auth to Clerk — PART 2 (BREAKING; apply
-- ONLY together with the Clerk code deploy, never before).
--
-- `playground_threads.user_id` is the one table that was keyed on the Supabase
-- auth uuid directly (every other table uses the internal public.users.id). This
-- repoints it at public.users(id) — the app-wide convention — and remaps the
-- existing rows through users.supabase_user_id.
--
-- WHY THIS CAN'T GO IN PART 1: the deployed Supabase-Auth code still inserts the
-- auth uuid into playground_threads.user_id. The moment the FK below points at
-- public.users(id), those inserts (new playground chats + routine-generated
-- threads) fail. The Clerk code writes req.internalUserId here instead, so this
-- migration and that code must land in the same deploy.

BEGIN;

ALTER TABLE public.playground_threads
  DROP CONSTRAINT IF EXISTS playground_threads_user_id_fkey;

-- Remap existing rows from the Supabase auth uuid to the internal users.id.
UPDATE public.playground_threads pt
  SET user_id = u.id
  FROM public.users u
  WHERE pt.user_id = u.supabase_user_id;

-- Drop any threads that couldn't be remapped (their auth user no longer maps to
-- an app user) so the stricter FK below can be created.
DELETE FROM public.playground_threads pt
  WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = pt.user_id);

ALTER TABLE public.playground_threads
  ADD CONSTRAINT playground_threads_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

COMMIT;
