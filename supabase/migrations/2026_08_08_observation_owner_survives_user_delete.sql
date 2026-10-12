-- Fix: deleting a user must NOT turn their private raw content workspace-public.
--
-- observations.owner_user_id scopes a raw email/LinkedIn body to the rep it came
-- through (PRIVACY_MODEL.md). The read rule treats owner_user_id IS NULL as
-- "system / derived / shared" — visible to everyone on the account.
--
-- The FK was ON DELETE SET NULL. So the GDPR self-erasure path (DELETE /api/users/me
-- -> DELETE FROM users) NULLed owner_user_id on every observation the departing rep
-- owned, flipping all of their previously-private conversations to shared. A rep
-- leaving is the exact moment their content must STAY private, not open up.
--
-- Fix: drop the SET NULL behaviour. owner_user_id becomes a durable scope token that
-- outlives the user row. After the user is gone no living viewer equals that id, so
-- the content stays private to whoever is IN TOUCH with the account (sharedAccount),
-- and is never exposed to members who never touched it. We keep the column and its
-- index; we only stop the cascade from erasing the scope. No read-path change needed.
--
-- Referential integrity trade-off: a departed owner's id is intentionally allowed to
-- dangle (privacy wins over a live FK). Nothing renders the observation owner by name
-- — it is only ever compared to the viewer's id for redaction — so a dangling id is
-- inert everywhere except that comparison, which is the behaviour we want.
--
-- Idempotent.

ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_owner_user_id_fkey;

COMMENT ON COLUMN public.observations.owner_user_id IS
  'The rep this raw row came through; scopes its body to that rep + in-touch members '
  '(PRIVACY_MODEL.md). A durable scope token, deliberately WITHOUT an ON DELETE SET NULL '
  'FK: it must survive user deletion so a departed rep''s content stays private rather '
  'than becoming workspace-shared. NULL still means system/derived/shared.';
