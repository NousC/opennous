-- Revoke a user's API keys when the user row is deleted (GET-1058).
--
-- api_keys.owner_user_id is ON DELETE SET NULL, and the key middleware treats a key with no owner
-- as a shared admin workspace key (team view, every teammate's private content). So deleting a
-- user turned each of their live member keys into an admin key. The app now revokes them first
-- (revokeMemberKeys in apps/api/src/lib/apiKeyScope.mjs); this trigger does the same for every
-- other path that deletes a user row, before the foreign key nulls the owner. The OAuth tokens
-- minted on those keys resolve to the key row, so revoking the key ends them; they are revoked
-- here as well so nothing lists them as live.
--
-- Not fixed here: keys whose owner was already deleted before this migration are indistinguishable
-- from deliberate admin workspace keys (both have owner_user_id null). Find them by hand.
--
-- Public: the key middleware is open-source code. Idempotent.
BEGIN;

CREATE OR REPLACE FUNCTION public.revoke_api_keys_of_deleted_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.oauth_tokens t SET revoked_at = now()
    FROM public.api_keys k
   WHERE t.api_key_id = k.id AND k.owner_user_id = OLD.id AND t.revoked_at IS NULL;
  UPDATE public.api_keys SET revoked_at = now()
   WHERE owner_user_id = OLD.id AND revoked_at IS NULL;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_api_keys_of_deleted_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS revoke_api_keys_of_deleted_user ON public.users;
CREATE TRIGGER revoke_api_keys_of_deleted_user
  BEFORE DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.revoke_api_keys_of_deleted_user();

COMMIT;
