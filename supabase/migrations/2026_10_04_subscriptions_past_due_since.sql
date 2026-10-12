-- GET-698: grace for a failed card runs seven days from the FAILURE, not from the period end.
-- A renewal invoice fails after Stripe has already advanced current_period_end a month, so
-- "seven days past the period end" was about five weeks of free reading. The Stripe webhook
-- stamps this on the first invoice.payment_failed / past_due status and clears it on recovery.
-- Additive and idempotent; until it is applied the code falls back to the period end.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS past_due_since timestamptz;
