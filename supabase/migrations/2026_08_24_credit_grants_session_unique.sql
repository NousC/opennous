-- Idempotency for Stripe credit grants (audit #9).
--
-- Both grant paths in apps/api/src/routes/stripeWebhook.mjs (invoice.paid monthly
-- refill + checkout.session.completed pack purchase) store the Stripe id in
-- credit_grants.stripe_session_id and treat a 23505 unique violation as "already
-- granted" (a no-op) so a replayed webhook does NOT double-grant credits. That
-- guarantee only holds if a UNIQUE index actually exists — the credit_grants table
-- was created out-of-band and the index was never in a migration, so a replay would
-- silently double-grant.
--
-- Partial index: signup/manual grants carry a NULL stripe_session_id and are exempt
-- (they can legitimately repeat). Verified 2026-08-23 that prod has 0 duplicate
-- stripe_session_ids, so this creates cleanly.
--
-- Guarded (GET-757): credit_grants has no CREATE TABLE in this repo, so on a database built from
-- the repo there is nothing to index. On production the table exists and this runs as before.
do $$
begin
  if to_regclass('public.credit_grants') is not null then
    create unique index if not exists credit_grants_stripe_session_uniq
      on public.credit_grants (stripe_session_id)
      where stripe_session_id is not null;
  end if;
end $$;
