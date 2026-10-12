-- Email follow-ups join the approval flow. The agent can now propose an email
-- (propose_email → sendProposedAction's email branch, sent as the user via their
-- Gmail OAuth connection), alongside the LinkedIn message/invite it already drafts.
-- So: allow kind='email', and carry the two fields an email needs that a LinkedIn
-- message doesn't — a subject line and the recipient's address.
ALTER TABLE public.pending_actions DROP CONSTRAINT IF EXISTS pending_actions_kind_check;
ALTER TABLE public.pending_actions ADD CONSTRAINT pending_actions_kind_check
  CHECK (kind = ANY (ARRAY['linkedin_message'::text, 'linkedin_invite'::text, 'email'::text]));

ALTER TABLE public.pending_actions ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE public.pending_actions ADD COLUMN IF NOT EXISTS recipient_email text;
