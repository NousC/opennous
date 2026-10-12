-- A webhook can deliver to a GitHub repo instead of a URL (GET-670).
--
-- The event is sent as a repository_dispatch, so the repo's GitHub Actions run on it: the
-- after-call automation, a customer's own ICP scorer, anything a workflow can do. Same catalog,
-- same outbox, same retries and delivery log as a URL webhook, managed on the same page.
--
-- github_token_enc is a fine-grained token encrypted with the API's ENCRYPTION_KEY
-- (providers/crypto.mjs). It is never selected by a read path; only the delivery path decrypts it.
--
-- Idempotent.

ALTER TABLE public.trigger_subscriptions
  ADD COLUMN IF NOT EXISTS destination_type text NOT NULL DEFAULT 'url',
  ADD COLUMN IF NOT EXISTS github_repo text,
  ADD COLUMN IF NOT EXISTS github_token_enc text;

ALTER TABLE public.trigger_subscriptions ALTER COLUMN url DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.trigger_subscriptions
    ADD CONSTRAINT trigger_subscriptions_destination_check CHECK (
      (destination_type = 'url'    AND url IS NOT NULL)
   OR (destination_type = 'github' AND github_repo IS NOT NULL AND github_token_enc IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.trigger_subscriptions.destination_type IS
  'url (POST a signed JSON body) or github (repository_dispatch to github_repo). GET-670.';
COMMENT ON COLUMN public.trigger_subscriptions.github_token_enc IS
  'Fine-grained GitHub token, encrypted (providers/crypto.mjs). Never returned by a read. GET-670.';
