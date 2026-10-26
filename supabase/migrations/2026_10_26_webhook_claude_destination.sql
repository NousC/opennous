-- A webhook can fire a Claude scheduled task (GET-1035).
--
-- destination_type 'claude' keeps the task's Fire URL in `url` (api.anthropic.com/v1/claude_code/
-- routines/trig_…/fire only, checked in core: db/webhookDeliveries.ts CLAUDE_FIRE_URL_RE) and the
-- task's API token, encrypted by the API, in github_token_enc, the destination's one encrypted
-- credential. Each event fires the task with the event as its text: same catalog, outbox, retries
-- and delivery log as a URL webhook. The token is never returned.
--
-- Idempotent.

ALTER TABLE public.trigger_subscriptions DROP CONSTRAINT IF EXISTS trigger_subscriptions_destination_check;
ALTER TABLE public.trigger_subscriptions
  ADD CONSTRAINT trigger_subscriptions_destination_check CHECK (
    (destination_type = 'url'    AND url IS NOT NULL)
 OR (destination_type = 'github' AND github_repo IS NOT NULL AND github_token_enc IS NOT NULL)
 OR (destination_type = 'slack'  AND url IS NOT NULL)
 OR (destination_type = 'claude' AND url IS NOT NULL AND github_token_enc IS NOT NULL)
  );

COMMENT ON COLUMN public.trigger_subscriptions.destination_type IS
  'url (POST a signed JSON body), github (repository_dispatch to github_repo), slack (a message to the incoming webhook in url) or claude (fire the Claude scheduled task whose Fire URL is url, with the token in github_token_enc). GET-670, GET-941, GET-1035.';

COMMENT ON COLUMN public.trigger_subscriptions.github_token_enc IS
  'The destination''s encrypted credential: a GitHub token (github) or a Claude scheduled task''s API token (claude). Read only by the delivery path.';

NOTIFY pgrst, 'reload schema';
